"""Thin multi-provider LLM client for the Studio's AI features.

Tries providers in order: Anthropic (if ANTHROPIC_API_KEY is set) -> OpenAI (if
OPENAI_API_KEY is set) -> a local Ollama model (if OLLAMA_MODEL is set), so the
AI features still work without an Anthropic key. Exactly one provider is used
per call - whichever is configured first in that order, no mixing.

OpenAI and Ollama both go through the `openai` SDK's chat.completions API
(Ollama exposes an OpenAI-compatible endpoint), forcing a single named tool
call so the response is always valid structured JSON - the same guarantee
Anthropic's forced tool_choice gives.
"""
import json

from fastapi import HTTPException

from ..config import (
    ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL,
    LLM_API_KEY,
    LLM_BASE_URL,
    LLM_MODEL,
    OLLAMA_BASE_URL,
    OLLAMA_MODEL,
    OPENAI_API_KEY,
    OPENAI_MODEL,
)

_clients: dict = {}


def active_provider(provider: str | None = None, model: str | None = None, model_code: str | None = None) -> dict:
    """Which provider would be used right now, and with which model - used by
    both call_structured() and the /api/ai/status endpoint."""
    selected_model = model_code or model
    if provider:
        if provider == "anthropic":
            if not ANTHROPIC_API_KEY:
                raise HTTPException(400, "Anthropic is selected but ANTHROPIC_API_KEY is not configured.")
            return {"provider": "anthropic", "model": selected_model or ANTHROPIC_MODEL}
        if provider == "openai":
            if not OPENAI_API_KEY:
                raise HTTPException(400, "OpenAI is selected but OPENAI_API_KEY is not configured.")
            return {"provider": "openai", "model": selected_model or OPENAI_MODEL}
        if provider == "ollama":
            ollama_model = selected_model or OLLAMA_MODEL
            if not ollama_model:
                raise HTTPException(400, "Ollama is selected but no model was provided and OLLAMA_MODEL is not configured.")
            return {"provider": "ollama", "model": ollama_model}
        if provider == "llm":
            llm_model = selected_model or LLM_MODEL
            if not llm_model:
                raise HTTPException(400, "Self-hosted LLM is selected but no model was provided and LLM_MODEL is not configured.")
            if not LLM_BASE_URL:
                raise HTTPException(400, "Self-hosted LLM is selected but LLM_BASE_URL is not configured.")
            return {"provider": "llm", "model": llm_model}
        raise HTTPException(400, f"Unsupported LLM provider: {provider}")
    if LLM_MODEL and LLM_BASE_URL:
        return {"provider": "llm", "model": LLM_MODEL}
    if ANTHROPIC_API_KEY:
        return {"provider": "anthropic", "model": ANTHROPIC_MODEL}
    if OPENAI_API_KEY:
        return {"provider": "openai", "model": OPENAI_MODEL}
    if OLLAMA_MODEL:
        return {"provider": "ollama", "model": OLLAMA_MODEL}
    return {"provider": None, "model": None}


def _require_provider(provider: str | None = None, model: str | None = None, model_code: str | None = None) -> dict:
    info = active_provider(provider, model, model_code)
    if not info["provider"]:
        raise HTTPException(
            400,
            "No LLM is configured. Set one of LLM_MODEL (+LLM_BASE_URL for a "
            "self-hosted OpenAI-compatible server), ANTHROPIC_API_KEY, "
            "OPENAI_API_KEY, or OLLAMA_MODEL (with Ollama running) in "
            "rdf-studio/.env and restart the backend.",
        )
    return info


def _anthropic_client():
    if "anthropic" not in _clients:
        import anthropic
        _clients["anthropic"] = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    return _clients["anthropic"]


def _openai_compatible_client(cache_key: str, api_key: str, base_url: str | None = None):
    if cache_key not in _clients:
        import openai
        _clients[cache_key] = openai.OpenAI(api_key=api_key, base_url=base_url)
    return _clients[cache_key]


def _call_anthropic(model: str, system: str, user_content: str, tool_name: str, tool_description: str, tool_schema: dict, max_tokens: int) -> dict:
    client = _anthropic_client()
    # Stream so large max_tokens calls (e.g. rewriting a whole script) never hit
    # the SDK's 10-minute non-streaming request ceiling.
    with client.messages.stream(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user_content}],
        tools=[{"name": tool_name, "description": tool_description, "input_schema": tool_schema}],
        tool_choice={"type": "tool", "name": tool_name},
    ) as stream:
        response = stream.get_final_message()
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
            return block.input
    raise HTTPException(502, "Anthropic response did not include the expected tool call.")


def _extract_json(text: str) -> dict:
    """Best-effort parse of a JSON object out of a plain completion - handles
    ```json fences and leading/trailing prose, for models that answer in text
    instead of emitting a tool call."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```", 2)[1] if cleaned.count("```") >= 2 else cleaned.strip("`")
        if cleaned.lstrip().startswith("json"):
            cleaned = cleaned.lstrip()[4:]
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    start = cleaned.find("{")
    if start != -1:  # scan for the matching closing brace
        depth = 0
        for i in range(start, len(cleaned)):
            if cleaned[i] == "{":
                depth += 1
            elif cleaned[i] == "}":
                depth -= 1
                if depth == 0:
                    return json.loads(cleaned[start : i + 1])
    raise json.JSONDecodeError("no JSON object found", cleaned, 0)


def _call_openai_json_fallback(client, model: str, system: str, user_content: str, tool_schema: dict, max_tokens: int) -> dict:
    """For models/servers that ignore forced tool_choice (e.g. gpt-oss-20b served
    via vLLM) - ask for raw JSON conforming to the schema and parse it, so the
    feature still works instead of hard-failing."""
    instruction = (
        "Respond with ONLY a single JSON object that conforms exactly to this JSON "
        f"schema. No prose, no markdown fences.\n\nSchema:\n{json.dumps(tool_schema)}"
    )
    response = client.chat.completions.create(
        model=model,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": f"{system}\n\n{instruction}"},
            {"role": "user", "content": user_content},
        ],
    )
    content = response.choices[0].message.content or ""
    try:
        return _extract_json(content)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            502,
            f"{model} did not return usable structured output (no tool call and no "
            f"parseable JSON): {exc}. This model may not support tool/function calling.",
        ) from exc


def _call_openai_compatible(client, model: str, system: str, user_content: str, tool_name: str, tool_description: str, tool_schema: dict, max_tokens: int) -> dict:
    # First try forced function calling. Some open models (e.g. gpt-oss-20b) either
    # ignore tool_choice and answer in plain text, or reject the tools params
    # outright - in both cases fall back to plain JSON mode so the feature works.
    try:
        response = client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user_content}],
            tools=[{"type": "function", "function": {"name": tool_name, "description": tool_description, "parameters": tool_schema}}],
            tool_choice={"type": "function", "function": {"name": tool_name}},
        )
    except Exception:
        return _call_openai_json_fallback(client, model, system, user_content, tool_schema, max_tokens)
    tool_calls = response.choices[0].message.tool_calls or []
    for call in tool_calls:
        if call.function.name == tool_name:
            try:
                return json.loads(call.function.arguments)
            except json.JSONDecodeError as exc:
                raise HTTPException(502, f"{model} returned invalid JSON for its tool call: {exc}") from exc
    return _call_openai_json_fallback(client, model, system, user_content, tool_schema, max_tokens)


def call_structured(system: str, user_content: str, tool_name: str, tool_description: str, tool_schema: dict, max_tokens: int = 4096, provider: str | None = None, model: str | None = None, model_code: str | None = None) -> dict:
    """Call the active LLM provider and force a single tool call so the response
    is guaranteed valid structured JSON, regardless of which provider is used."""
    info = _require_provider(provider, model, model_code)
    provider = info["provider"]
    selected_model = info["model"]
    try:
        if provider == "anthropic":
            return _call_anthropic(selected_model, system, user_content, tool_name, tool_description, tool_schema, max_tokens)
        if provider == "openai":
            client = _openai_compatible_client("openai", OPENAI_API_KEY)
            return _call_openai_compatible(client, selected_model, system, user_content, tool_name, tool_description, tool_schema, max_tokens)
        if provider == "llm":
            client = _openai_compatible_client("llm", LLM_API_KEY or "not-needed", LLM_BASE_URL)
            return _call_openai_compatible(client, selected_model, system, user_content, tool_name, tool_description, tool_schema, max_tokens)
        client = _openai_compatible_client("ollama", "ollama", OLLAMA_BASE_URL)
        return _call_openai_compatible(client, selected_model, system, user_content, tool_name, tool_description, tool_schema, max_tokens)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"{provider} API call failed: {exc}") from exc
