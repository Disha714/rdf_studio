"""Decompose a single large script into standalone, ontology-conformant code
blocks - one AnalyticalProcess node per block, each carrying its extracted
standalone code as an `rps:codeArtifact` property (logic only, explicit
inputs/outputs). Same discipline as generate.py: the LLM only returns simple
structured fields; this module, not the model, mints IRIs and serializes the
JSON-LD under the distinct `.../freqrec/ai/...` namespace. Blocks are chained in
flow order with the existing `rps:isIntermedateProcessto` relation so they
render as a pipeline.
"""
from .client import call_structured
from .generate import (
    AI_BASE,
    ALL_TRIPLES,
    ANALYTICAL_PROCESS,
    COMMENT,
    COMPUTES_METRIC,
    FORMULA,
    GROUNDED_IN,
    HAS_INPUT,
    HAS_OUTPUT,
    LABEL,
    METRIC_CLASS,
    PRODUCT,
    RPS,
    UNIT,
    _existing_products,
    _literal,
    _slug,
)
from ..store import construct

CODE_ARTIFACT = f"{RPS}codeArtifact"
CODE_LANGUAGE = f"{RPS}codeLanguage"
CODE_ENTRYPOINT = f"{RPS}codeEntrypoint"
# Reuse the (existing, deliberately-spelled) intermediate-process relation so the
# blocks connect into a pipeline on the canvas exactly like modify.py expects.
INTERMEDIATE = f"{RPS}isIntermedateProcessto"

DECOMPOSE_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "blocks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "comment": {"type": "string"},
                    "code": {"type": "string"},
                    "entrypoint": {"type": "string"},
                    "language": {"type": "string"},
                    "inputs": {"type": "array", "items": {"type": "string"}},
                    "outputs": {"type": "array", "items": {"type": "string"}},
                    "metric": {
                        "type": ["object", "null"],
                        "properties": {
                            "label": {"type": "string"},
                            "formula": {"type": "string"},
                            "unit": {"type": "string"},
                            "groundedIn": {"type": "string"},
                        },
                    },
                },
                "required": ["label", "comment", "code", "inputs", "outputs"],
            },
        }
    },
    "required": ["blocks"],
}

DEFAULT_INSTRUCTIONS = (
    "Split the script into standalone, single-responsibility blocks (e.g. a normalization "
    "step, a similarity metric, a distribution step). For EACH block emit: a conceptual "
    "`label` (snake_case, the function it performs), a one-line `comment`, and `code` = a "
    "self-contained function that takes the named inputs as arguments and RETURNS the named "
    "outputs. The code must be logic only - no file paths, no open()/read_csv()/to_json(), "
    "no global state, no I/O. Put the function name in `entrypoint` and the language in "
    "`language` (default python). `inputs`/`outputs` are short human-readable names for the "
    "datasets flowing between blocks (an output of one block is typically the input of the "
    "next). Only attach a `metric` when the block computes a specific named formula."
)

SYSTEM = (
    "You are a senior engineer refactoring a data pipeline script into a knowledge graph of "
    "reusable, standalone code blocks. Extract only what the code actually does - never "
    "invent steps. Each block's `code` must be able to run on its own given only its "
    "declared inputs as arguments."
)


def _render_blocks(blocks: list[dict], existing: dict[str, str]) -> list[dict]:
    nodes: list[dict] = []

    def resolve_or_create(name: str) -> str:
        iri = existing.get(name.strip().lower())
        if iri:
            return iri
        iri = f"{AI_BASE}/{_slug(name)}"
        nodes.append({"@id": iri, "@type": [str(PRODUCT)], LABEL: _literal(name)})
        existing[name.strip().lower()] = iri
        return iri

    stage_iris: list[str] = []
    by_id: dict[str, dict] = {}
    for block in blocks:
        stage_iri = f"{AI_BASE}/{_slug(block['label'])}"
        node = {
            "@id": stage_iri,
            "@type": [str(ANALYTICAL_PROCESS)],
            LABEL: _literal(block["label"]),
            COMMENT: _literal(block.get("comment", "")),
        }
        code = (block.get("code") or "").strip()
        if code:
            node[CODE_ARTIFACT] = _literal(code)
            node[CODE_LANGUAGE] = _literal(block.get("language") or "python")
            if block.get("entrypoint"):
                node[CODE_ENTRYPOINT] = _literal(block["entrypoint"])
        input_refs = [resolve_or_create(name) for name in block.get("inputs", [])]
        output_refs = [resolve_or_create(name) for name in block.get("outputs", [])]
        if input_refs:
            node[str(HAS_INPUT)] = [{"@id": iri} for iri in input_refs]
        if output_refs:
            node[str(HAS_OUTPUT)] = [{"@id": iri} for iri in output_refs]

        metric = block.get("metric")
        if metric and metric.get("label"):
            metric_iri = f"{AI_BASE}/{_slug(metric['label'])}"
            nodes.append({
                "@id": metric_iri,
                "@type": [str(METRIC_CLASS)],
                LABEL: _literal(metric["label"]),
                str(FORMULA): _literal(metric.get("formula", "")),
                str(UNIT): _literal(metric.get("unit", "")),
                str(GROUNDED_IN): _literal(metric.get("groundedIn", "")),
            })
            node[str(COMPUTES_METRIC)] = [{"@id": metric_iri}]

        nodes.append(node)
        by_id[stage_iri] = node
        stage_iris.append(stage_iri)

    for upstream, downstream in zip(stage_iris, stage_iris[1:]):
        by_id[upstream].setdefault(INTERMEDIATE, []).append({"@id": downstream})
    return nodes


def decompose_script(source: str, instructions: str | None = None) -> dict:
    """source: the full script text pasted by the user for this single request.
    Returns {"blocks": <raw LLM fields for preview>, "jsonld": <mintable nodes>}.
    Nothing is persisted here - the caller reviews and imports explicitly."""
    if not source or not source.strip():
        raise ValueError("Provide a script to decompose.")
    graph = construct(ALL_TRIPLES)
    existing = _existing_products(graph)
    user_content = f"{instructions or DEFAULT_INSTRUCTIONS}\n\nScript to decompose:\n\n```\n{source}\n```"
    result = call_structured(
        system=SYSTEM,
        user_content=user_content,
        tool_name="report_code_blocks",
        tool_description="Report the standalone code blocks extracted from the script.",
        tool_schema=DECOMPOSE_TOOL_SCHEMA,
        max_tokens=8000,
    )
    blocks = result.get("blocks", [])
    if not blocks:
        raise ValueError("The model did not return any code blocks for this script.")
    nodes = _render_blocks(blocks, existing)
    return {"blocks": blocks, "jsonld": nodes}
