"""Grounded conversational agent for the Ontology Playground.

Unlike generate.py (which mints a whole new draft graph on every send), this reads
the pipeline *already loaded in Fuseki* - its stages, metric formulas and the actual
code artifacts on each node - and answers the user's question directly from that
context. "what is the formula for the stop-overlap score?" yields the formula as
text, not a regenerated RDF; and a follow-up keeps the prior turns as history so the
agent stops "creating a new instance every time".

The endpoint only *answers* and *names the edits to make* (`actions`); it never writes
to the graph. The frontend carries each action out through the existing propose->apply
endpoints (edit.py / modify.py), which also hold the pre-edit snapshot used for Revert.

Smaller/open models routinely *describe* an edit in prose but forget to fill the
structured `actions` array, so the change card never shows and nothing is applied. Two
safety nets fix that here: (1) when the latest message clearly asks for a change but the
model returned no actions, a focused second call extracts them; (2) every action's
target is resolved/repaired against the real node & stage catalog, so a missing or wrong
IRI is filled in from the label the user named rather than surfacing as an error card.
"""
import re

from . import modify
from .client import call_structured
from .generate import _ontology_catalog
from .retrieval import get_code_artifact, load_index

# Cap the code we inline so a big pipeline can't blow the context window; longest
# bodies are truncated first.
_MAX_CODE_CHARS = 12000

# Verbs that mark the latest message as an edit request (gate for the second pass, so
# pure questions never pay for an extra LLM call).
_EDIT_VERBS = (
    "change", "add", "set", "replace", "update", "remove", "delete", "rename",
    "modify", "promote", "adjust", "increase", "decrease", "rewrite", "refactor",
    "insert", "append", "swap", "convert", "introduce", "edit", "tweak", "make",
)

_ACTION_KINDS = ("editCode", "modifyOntology", "createClass")

_ACTION_ITEM = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": list(_ACTION_KINDS)},
        "iri": {"type": "string", "description": "for editCode: the exact IRI (copied from the catalog) of the code-bearing node to edit"},
        "label": {"type": "string", "description": "human label of the target node/stage/metric, or the name of the class to create"},
        "targetStageId": {"type": "string", "description": "for modifyOntology: the exact stage IRI (copied from the catalog) to modify"},
        "instruction": {"type": "string", "description": "the concrete change to apply, phrased as an imperative; for createClass, the user's request for the new class, restated in full"},
        "why": {"type": "string", "description": "one short sentence on what this changes"},
    },
    "required": ["kind", "instruction"],
}

_CLARIFICATION_ITEM = {
    "type": "object",
    "properties": {
        "question": {"type": "string", "description": "one short line framing the choice, e.g. \"This needs a new stage, which I can't create from here. Pick one:\""},
        "options": {
            "type": "array",
            "description": "2-4 concrete, real alternative instructions - each one must be something a SINGLE editCode/modifyOntology action on an EXISTING stage could actually carry out if the user picked it.",
            "items": {"type": "string"},
        },
    },
    "required": ["question", "options"],
}

CHAT_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {
            "type": "string",
            "description": "A direct, grounded reply to the user, drawn ONLY from the pipeline context provided. If they asked for a formula/logic, state it as text.",
        },
        "isEditRequest": {
            "type": "boolean",
            "description": "true if the user's latest message asks to change/add/set/replace/update/remove anything in the pipeline.",
        },
        "actions": {
            "type": "array",
            "description": "REQUIRED whenever isEditRequest is true and the request is directly achievable: one entry per edit to carry out. Empty when it's a pure question, or when clarificationOptions is set instead.",
            "items": _ACTION_ITEM,
        },
        "clarificationOptions": {
            "type": "array",
            "description": "Set this INSTEAD of actions when the request can't be carried out as literally asked - either it needs something this system structurally can't do (a new stage, deleting a whole metric/stage), or the only way to approximate it would corrupt the graph (e.g. renaming two different inputs to the same generic label to fake a split). Offer real, achievable alternatives rather than attempting a workaround or just refusing.",
            "items": _CLARIFICATION_ITEM,
        },
    },
    "required": ["answer"],
}

EXTRACT_TOOL_SCHEMA = {
    "type": "object",
    "properties": {"actions": {"type": "array", "items": _ACTION_ITEM}},
    "required": ["actions"],
}

SYSTEM = (
    "You are a grounded assistant for an RDF pipeline-lineage 'Ontology Playground'. "
    "A snapshot of the pipeline the user is looking at - its stages, metric formulas, "
    "and the actual code artifacts on each node - is given below. Rules: "
    "(1) Answer the user's question DIRECTLY from that snapshot. If they ask for a "
    "formula, logic, or what a node does, read it from the context and state it - never "
    "reply that you need details that are already present. The snapshot below is the ONE "
    "source of truth for what the graph currently contains - it is regenerated fresh from "
    "the real data on every turn. Earlier turns in this conversation may describe a change "
    "that was proposed, and each carries an 'ACTUAL OUTCOME' line stating whether it was "
    "actually applied, rejected, or reverted - a rejected or not-yet-approved one changed "
    "NOTHING, no matter how confidently the prose above it describes doing so. If the two "
    "ever disagree, the live snapshot wins: never describe the pipeline's lineage or "
    "structure based on what an earlier turn said it WOULD do, only on what the snapshot "
    "shows it actually IS right now. "
    "(2) Never invent or regenerate a new pipeline, and never create duplicate nodes. "
    "(3) When the user asks to CHANGE something you MUST set isEditRequest=true AND add "
    "an entry to `actions` - describing the change in prose is NOT enough, the system "
    "only applies what is in `actions`. Use kind 'editCode' with the node's exact `iri` "
    "(copied verbatim from the catalog) when the change is to a node's code (a formula in "
    "code, a constant, an added parameter); use kind 'modifyOntology' with the stage's "
    "exact `targetStageId` when the change is to the graph's descriptions, a metric's "
    "formula, OR one of the stage's own 'Declared properties' shown in its context below "
    "(a strategy/threshold/window-style setting defined on its class) - modifyOntology "
    "instructions can set these directly, so prefer it over editCode whenever the request "
    "matches a declared property by name; only fall back to editCode when no declared "
    "property covers it and the change is purely to the code's own logic. A change to a "
    "metric's formula is modifyOntology on the stage that computes that metric. Keep "
    "`instruction` concrete and copy IRIs exactly from the catalog. "
    "(4) Prefer the node/metric the user names; only if you truly cannot tell what they "
    "mean, ask in `answer` and leave `actions` empty. "
    "(5) A single editCode/modifyOntology action always targets ONE existing stage, but "
    "within that stage it CAN rename/reformulate an existing metric AND add a genuinely "
    "additional metric alongside what it already computes ('add a metric for X' is a "
    "normal, achievable modifyOntology instruction - do not treat it as unsupported). "
    "What editCode/modifyOntology cannot do is create a new STAGE or NODE, or delete a "
    "whole stage/metric entirely - but a request for a NEW stage or node (including "
    "'add a second Aggregation stage', 'branch the pipeline so there's another X') IS "
    "achievable, just through a DIFFERENT action: emit a `createClass` action instead "
    "(see rule 9) - it reuses an existing class automatically when one already fits, so "
    "this is the right tool even when nothing new needs to be defined, not just when a "
    "genuinely new class is needed. Reserve clarificationOptions for what truly has no "
    "path at all: splitting an EXISTING stage into several, or deleting a whole "
    "stage/metric. Never attempt a workaround that would corrupt the graph to "
    "approximate those (e.g. renaming two different inputs/outputs to the same generic "
    "label to simulate a split - that is rejected and wastes the user's turn); instead "
    "set clarificationOptions with 2-4 concrete alternatives that ARE achievable in one "
    "action, and leave `actions` empty. "
    "(6) A request to add a new input/output that the code will actually use is a "
    "TWO-PART change, not one: emit BOTH an editCode action AND a modifyOntology action "
    "on the same stage together, never just one. This rule does NOT apply when the input "
    "being added is a NEW CLASS the ontology lacks - that is a single createClass action "
    "and nothing else (see rule 9). The editCode `instruction` must say "
    "explicitly HOW the new parameter is used (e.g. 'add vehicle_type and multiply the "
    "result by its fuel-cost factor'), not just that it should be accepted - editCode has "
    "no memory of why you're adding it, only what you write in `instruction`, so a vague "
    "instruction like 'accept vehicle_type as a parameter' predictably produces a "
    "parameter nothing in the function body ever reads, which is wrong even though "
    "nothing errors. Likewise the modifyOntology `instruction` must explicitly ask for a "
    "new hasInput/hasOutput product, not just a comment update. "
    "(7) When the user's message names more than one distinct thing to change (including "
    "'fix both X and Y'), you MUST emit one action per named thing - before finishing, "
    "re-read the user's message and check every part they named has a matching action; "
    "silently completing only one and describing the other as done in `answer` is a "
    "worse failure than leaving both undone, because the user has no way to tell the "
    "difference from `answer` text alone. "
    "(8) Never state in `answer` that something was added/fixed/changed unless a "
    "corresponding entry actually exists in `actions` performing it. `answer` is a "
    "description of what `actions` will do, not a substitute for including the action. "
    "(9) Adding a new NODE to the pipeline is supported via `createClass` - whether or "
    "not an existing class already covers the concept. Use it both when the user asks "
    "for a kind of thing the ontology has no term for ('add a lookup table class', 'we "
    "need a dimension class for calendar dates') AND when they ask for another instance "
    "of a kind that already exists ('add a second Aggregation stage', 'branch the "
    "pipeline so there's another cleaning step') - the backend automatically reuses the "
    "matching class in the second case and only adds the new node, which is exactly "
    "what a request like that wants. Do NOT withhold the action or emit no action just "
    "because a matching class already exists - that would silently do nothing while "
    "`answer` describes it as handled. The `instruction` must restate their request in "
    "full, including which existing node(s) it connects to, if they said. Do not use "
    "clarificationOptions for this, and do not force the concept into an existing node "
    "instead of creating a new one. "
    "A createClass action MUST be the ONLY action in your response - never pair it with "
    "editCode or modifyOntology. The class does not exist yet; it is a proposal the user "
    "reviews and approves, and the proposal already carries the new node and its links to "
    "existing stages. Any other action in the same turn would be applied immediately, "
    "against a graph in which the class is still absent, and would write without the "
    "user's approval. If the user also asked for a code or metric change, say in `answer` "
    "that it comes after they approve the class."
)

EXTRACT_SYSTEM = (
    "The user asked to modify the pipeline below. Convert their request into structured "
    "edit actions. Never return an empty list when the message asks to change, add, set, "
    "replace, update, or remove anything. Use kind 'editCode' with the exact node IRI from "
    "the catalog for a change to code; use kind 'modifyOntology' with the exact stage IRI "
    "for a change to a metric's formula, a description, a product, or one of the stage's "
    "own declared properties (a strategy/threshold/window-style setting shown in its "
    "context) - prefer modifyOntology over editCode whenever the request matches a "
    "declared property by name (a metric-formula change targets the stage that computes "
    "that metric). Copy every IRI verbatim from the "
    "catalog - do not invent IRIs. A new input/output the code will actually use needs BOTH "
    "an editCode action (instruction must say how the parameter is actually used, not just "
    "that it's accepted) and a modifyOntology action (instruction must ask for a new "
    "hasInput/hasOutput product) - never just one. Use kind 'createClass' whenever the user "
    "wants a NEW NODE added to the pipeline - a new stage, a new artifact, anything - whether "
    "or not a matching class already exists (it reuses one automatically when it does, and "
    "only adds the new node); its `instruction` is their request restated in full, and it "
    "needs no IRI. A createClass action must be the ONLY action you return - never pair it "
    "with editCode or modifyOntology, and do not additionally wire the new node to a stage, "
    "because the proposal already carries that link. Otherwise, if the message names multiple "
    "distinct changes, emit one action per named change - do not drop any of them."
)


def _code_context() -> tuple[str, list[dict]]:
    """Every code-bearing node's entrypoint + body (grounds questions about the code and
    edits to it), plus a compact [{iri,label,entrypoint}] catalog for target resolution.
    Reuses the retrieval index."""
    index = load_index()
    nodes = [{"iri": r["iri"], "label": r["label"], "entrypoint": r.get("entrypoint", "")} for r in index]
    if not index:
        return "(no code artifacts are present on any node)", nodes
    blocks: list[str] = []
    budget = _MAX_CODE_CHARS
    for record in sorted(index, key=lambda r: len(r.get("comment", ""))):
        try:
            artifact = get_code_artifact(record["iri"])
        except ValueError:
            continue
        code = artifact["code"] or ""
        if len(code) > budget:
            code = code[:budget] + "\n# … (truncated)"
        budget = max(0, budget - len(code))
        params = ", ".join(f"{p['name']}={p['default']}" for p in artifact["params"]) or "none"
        blocks.append(
            f"Node IRI: {artifact['iri']}\nLabel: {artifact['label']}\n"
            f"Entrypoint: {artifact['entrypoint'] or 'unknown'} · Params: {params}\n"
            f"```{artifact['language']}\n{code}\n```"
        )
        if budget <= 0:
            break
    return "\n\n".join(blocks), nodes


def _build_context() -> dict:
    """Everything the two LLM calls and the resolver need, derived from one graph read:
    the prose snapshot, the code bodies, and label->IRI catalogs for stages, code nodes
    and metrics (a metric maps to the stage that computes it)."""
    graph = modify.construct(modify.ALL_TRIPLES)
    order = modify._flow_order(graph)
    pipeline_ctx = "\n\n".join(modify._stage_description(graph, stage) for stage in order) or "(no stages are loaded in the graph)"
    stages = [{"iri": str(stage), "label": modify._label(graph, stage)} for stage in order]
    metric_to_stage: dict[str, str] = {}
    for stage in order:
        for metric in graph.objects(stage, modify.COMPUTES_METRIC):
            metric_to_stage[modify._label(graph, metric).strip().lower()] = str(stage)
    code_ctx, code_nodes = _code_context()
    catalog_lines = [f"- {node['label']} (code node) -> {node['iri']}" + (f" [entrypoint {node['entrypoint']}]" if node["entrypoint"] else "") for node in code_nodes]
    catalog_lines += [f"- {stage['label']} (stage) -> {stage['iri']}" for stage in stages]
    catalog_lines += [f"- {label} (metric, computed by stage {iri})" for label, iri in metric_to_stage.items()]
    return {
        "pipeline_ctx": pipeline_ctx,
        "code_ctx": code_ctx,
        "stages": stages,
        "code_nodes": code_nodes,
        "metric_to_stage": metric_to_stage,
        "catalog": "\n".join(catalog_lines) or "(empty)",
        # Rule 9 asks the model to reuse an existing class before proposing a new one,
        # which it can only do if it can see what the ontology already defines.
        "ontology_ctx": _ontology_catalog(graph),
    }


def _history(messages: list[dict]) -> str:
    lines = []
    for turn in messages:
        speaker = "User" if turn.get("role", "user") == "user" else "Assistant"
        lines.append(f"{speaker}: {turn.get('text', '')}")
    return "\n".join(lines)


def _looks_like_edit(text: str) -> bool:
    tokens = set(re.findall(r"[a-z]+", text.lower()))
    return any(verb in tokens for verb in _EDIT_VERBS)


def _normalize(raw_actions) -> list[dict]:
    actions = []
    for item in raw_actions or []:
        kind = item.get("kind")
        instruction = (item.get("instruction") or "").strip()
        if kind not in _ACTION_KINDS or not instruction:
            continue
        actions.append({
            "kind": kind,
            "iri": (item.get("iri") or "").strip(),
            "label": (item.get("label") or "").strip(),
            "targetStageId": (item.get("targetStageId") or "").strip(),
            "instruction": instruction,
            "why": (item.get("why") or "").strip(),
        })
    return actions


def _match_by_text(text: str, candidates: list[dict]) -> str:
    """Pick the catalog entry whose label (or entrypoint) appears in the text - used to
    repair a missing/invalid IRI from the name the user actually typed."""
    haystack = text.lower()
    best = ""
    best_len = 0
    for entry in candidates:
        for key in (entry.get("label", ""), entry.get("entrypoint", "")):
            key = (key or "").strip().lower()
            if key and key in haystack and len(key) > best_len:
                best, best_len = entry["iri"], len(key)
    return best


def _enforce_class_exclusivity(actions: list[dict]) -> tuple[list[dict], bool]:
    """A createClass turn carries no other action.

    "Add a lookup class as an input to stage S" reads to the model as rule 6's two-part
    input/output change, so it emits createClass AND modifyOntology. But modifyOntology
    applies the moment the turn completes, while the class is still an unapproved proposal:
    the write lands on a graph where the class does not exist, minting a generic rps:product
    node instead - and it writes without the user ever approving anything, which is the one
    thing this feature must not do. The class proposal already carries its own instance and
    its links to existing stages, so the extra action is redundant as well as premature.
    """
    class_actions = [action for action in actions if action["kind"] == "createClass"]
    if not class_actions:
        return actions, False
    return class_actions, len(class_actions) != len(actions)


def _resolve_actions(actions: list[dict], context: dict) -> list[dict]:
    code_nodes = context["code_nodes"]
    stages = context["stages"]
    metric_to_stage = context["metric_to_stage"]
    code_iris = {node["iri"] for node in code_nodes}
    stage_iris = {stage["iri"] for stage in stages}
    resolved = []
    for action in actions:
        text = f"{action['label']} {action['instruction']}"
        if action["kind"] == "createClass":
            # Targets a class that does not exist yet, so there is no IRI to resolve or
            # repair - classgen.py mints it once the user approves the proposal.
            resolved.append(action)
            continue
        if action["kind"] == "editCode":
            # A stage with no code yet is still a legitimate editCode target (adding
            # code from scratch) - only repair the IRI when it matches NEITHER a
            # code-bearing node NOR a real stage, i.e. it's actually wrong/invented.
            if action["iri"] not in code_iris and action["iri"] not in stage_iris:
                action["iri"] = _match_by_text(text, code_nodes) or _match_by_text(text, stages)
        else:  # modifyOntology
            if action["targetStageId"] not in stage_iris:
                target = _match_by_text(text, stages)
                if not target:
                    haystack = text.lower()
                    target = next((iri for label, iri in metric_to_stage.items() if label and label in haystack), "")
                action["targetStageId"] = target
        resolved.append(action)
    return resolved


def _extract_actions(messages: list[dict], latest: str, context: dict, provider, model, model_code) -> list[dict]:
    """Second, single-purpose pass: the primary reply described a change but emitted no
    action, so ask a focused call to turn the request into structured actions."""
    user_content = (
        f"Target catalog (copy IRIs verbatim):\n{context['catalog']}\n\n"
        f"Pipeline stages:\n{context['pipeline_ctx']}\n\n"
        f"Code artifacts on nodes:\n{context['code_ctx']}\n\n"
        f"Conversation so far:\n{_history(messages)}\n\n"
        f"Extract the edit action(s) for the user's latest request: {latest}"
    )
    result = call_structured(
        system=EXTRACT_SYSTEM,
        user_content=user_content,
        tool_name="extract_edit_actions",
        tool_description="Extract the concrete edit actions the user asked for.",
        tool_schema=EXTRACT_TOOL_SCHEMA,
        max_tokens=2000,
        provider=provider,
        model=model,
        model_code=model_code,
    )
    return _normalize(result.get("actions"))


def answer_playground(messages: list[dict], provider: str | None = None, model: str | None = None, model_code: str | None = None) -> dict:
    if not messages:
        raise ValueError("Send at least one message.")
    latest = next((turn.get("text", "") for turn in reversed(messages) if turn.get("role") == "user"), "")
    if not latest.strip():
        raise ValueError("The latest message is empty.")

    context = _build_context()
    user_content = (
        f"Target catalog (copy IRIs verbatim into actions):\n{context['catalog']}\n\n"
        f"{context['ontology_ctx']}\n\n"
        f"Pipeline stages (flow order):\n{context['pipeline_ctx']}\n\n"
        f"Code artifacts on nodes:\n{context['code_ctx']}\n\n"
        f"Conversation so far:\n{_history(messages)}\n\n"
        f"Answer the user's latest message. If it requests a change, set isEditRequest=true and emit the matching action(s)."
    )
    result = call_structured(
        system=SYSTEM,
        user_content=user_content,
        tool_name="report_chat_response",
        tool_description="Report the grounded answer and any edits to carry out.",
        tool_schema=CHAT_TOOL_SCHEMA,
        max_tokens=8000,
        provider=provider,
        model=model,
        model_code=model_code,
    )
    answer = (result.get("answer") or "").strip()
    if not answer:
        raise ValueError("The model did not return an answer - try rephrasing.")

    clarification_options = [
        {"question": item["question"].strip(), "options": [opt.strip() for opt in item.get("options") or [] if opt.strip()]}
        for item in (result.get("clarificationOptions") or [])
        if item.get("question") and item.get("options")
    ]
    clarification_options = [item for item in clarification_options if item["options"]]

    actions = _normalize(result.get("actions"))
    # Net for models that describe an edit in prose but forget to fill `actions` - but
    # not when the model deliberately chose clarificationOptions instead, since forcing
    # an extraction here would reintroduce the exact workaround-that-corrupts-the-graph
    # behavior clarificationOptions exists to avoid.
    if not actions and not clarification_options and (result.get("isEditRequest") or _looks_like_edit(latest)):
        try:
            actions = _extract_actions(messages, latest, context, provider, model, model_code)
        except Exception:
            actions = []  # never let the extraction pass break a valid answer
    actions, dropped = _enforce_class_exclusivity(actions)
    if dropped:
        answer += (
            "\n\nThe new class has to be reviewed and approved before anything can be wired "
            "to it, so I have not made any other change to the graph in this turn. Approve "
            "the class below - it already includes its link to the stage - then ask for any "
            "further edits."
        )
    actions = _resolve_actions(actions, context)
    return {"answer": answer, "actions": actions, "clarificationOptions": clarification_options}
