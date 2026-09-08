"""Propose -> apply for a plain-English pipeline modification, RDF-only.

This is a graph-editing assistant, not a code-execution one: "apply" writes an
RDF patch to Fuseki via the same SPARQL UPDATE mechanism the rest of the Studio
already uses (see PipelinePage.tsx), then re-runs the structural consistency
check. There is no sandbox and no code execution - the product never has the
user's real data or environment to run anything in. If the user pastes code for
the target stage, the LLM may also return a code suggestion as plain text for
them to apply themselves; it is never executed here.
"""
import re
import time
import uuid

from rdflib import OWL, RDF, RDFS, URIRef

from . import rdf_consistency
from .client import call_structured
from ..store import construct, update

RPS = "https://w3id.org/rdf-pipeline-studio#"
FREQREC = "https://bmtc.datakaveri.org/freqrec#"
AI_BASE = "https://bmtc.datakaveri.org/freqrec/ai"

ANALYTICAL_PROCESS = URIRef(f"{RPS}analyticalProcess")
PRODUCT = URIRef(f"{RPS}product")
INTERMEDIATE_PRODUCT = URIRef(f"{RPS}intermediateProduct")
FINAL_PRODUCT = URIRef(f"{RPS}finalProduct")
SOURCE_OF_RECORD = URIRef(f"{FREQREC}SourceOfRecord")
HAS_INPUT = URIRef(f"{RPS}hasInput")
HAS_OUTPUT = URIRef(f"{RPS}hasOutput")
COMPUTES_METRIC = URIRef(f"{RPS}computesMetric")
IS_INTERMEDIATE_TO = URIRef(f"{RPS}isIntermedateProcessto")
METRIC_CLASS = URIRef(f"{FREQREC}Metric")
FORMULA = URIRef(f"{FREQREC}formula")
UNIT = URIRef(f"{FREQREC}unit")
GROUNDED_IN = URIRef(f"{FREQREC}groundedIn")

# Every artifact-ish runtime type - a new product minted here could be any of these roles,
# but they all conventionally share ONE domain class (e.g. ea:PipelineArtifact) in a
# well-formed ontology; see _shared_domain_type.
_PRODUCT_RUNTIME_TYPES = (PRODUCT, INTERMEDIATE_PRODUCT, FINAL_PRODUCT, SOURCE_OF_RECORD)
_CORE_TAXONOMY_TYPES = {str(t) for t in (ANALYTICAL_PROCESS, PRODUCT, INTERMEDIATE_PRODUCT, FINAL_PRODUCT, SOURCE_OF_RECORD, METRIC_CLASS)}

ALL_TRIPLES = "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }"

PROPOSALS: dict[str, dict] = {}

MODIFY_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "targetStageId": {"type": "string"},
        "updatedComment": {"type": "string", "description": "the stage's new rdfs:comment, reflecting the requested change"},
        "newStageLabel": {"type": ["string", "null"], "description": "only if the request renames the stage itself (its rdfs:label); null otherwise"},
        "metricUpdate": {
            "type": ["object", "null"],
            "properties": {
                "metricLabel": {"type": "string", "description": "the metric's CURRENT label - must match an existing metric this stage computes, even if this update renames it"},
                "newFormula": {"type": "string", "description": "REQUIRED whenever metricUpdate is present, even if the request only renames the metric and the formula's arithmetic is unchanged - repeat the current formula verbatim in that case"},
                "newLabel": {"type": ["string", "null"], "description": "only if the request renames this metric (its rdfs:label); null otherwise"},
            },
            "required": ["metricLabel", "newFormula"],
        },
        "newProducts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "role": {"type": "string", "enum": ["input", "output"]},
                },
                "required": ["name", "role"],
            },
        },
        "newMetrics": {
            "type": "array",
            "description": "A genuinely NEW metric this stage should ALSO compute, alongside whatever it already computes - never use this to change an existing metric (use metricUpdate for that; putting an existing metric's label here would create a confusing duplicate).",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "formula": {"type": "string"},
                    "unit": {"type": "string", "description": "e.g. INR/km; omit if not applicable"},
                    "groundedIn": {"type": "string", "description": "the source records this metric derives from"},
                },
                "required": ["label", "formula"],
            },
        },
        "renamedProducts": {
            "type": "array",
            "description": "Rename an EXISTING input/output product of this stage - not for new ones (use newProducts for those).",
            "items": {
                "type": "object",
                "properties": {
                    "currentLabel": {"type": "string", "description": "the product's CURRENT label, exactly as shown in the stage's inputs/outputs"},
                    "newLabel": {"type": "string"},
                    "role": {"type": "string", "enum": ["input", "output"], "description": "whether this product is currently one of the stage's inputs or outputs"},
                },
                "required": ["currentLabel", "newLabel", "role"],
            },
        },
        "removedProducts": {
            "type": "array",
            "description": "Remove an EXISTING input/output link from this stage (deletes the hasInput/hasOutput edge only - the product resource itself is left alone in case another stage still references it).",
            "items": {
                "type": "object",
                "properties": {
                    "currentLabel": {"type": "string", "description": "the product's CURRENT label, exactly as shown in the stage's inputs/outputs"},
                    "role": {"type": "string", "enum": ["input", "output"], "description": "whether this product is currently one of the stage's inputs or outputs"},
                },
                "required": ["currentLabel", "role"],
            },
        },
        "codeSuggestion": {"type": ["string", "null"], "description": "only if code was pasted in - the modified script text; null otherwise"},
        "parameterUpdates": {
            "type": "array",
            "description": (
                "Update the VALUE of one of this stage's OWN declared properties - listed "
                "under 'Declared properties' in the stage description below (e.g. a "
                "strategy, threshold, or window setting defined when the stage's class was "
                "created). This is the correct way to satisfy a request about the stage's "
                "own configuration - prefer it over codeSuggestion whenever the requested "
                "change matches one of these declared properties. Only use a predicateIri "
                "that appears verbatim in that catalog; never invent one."
            ),
            "items": {
                "type": "object",
                "properties": {
                    "predicateIri": {"type": "string", "description": "Exact property IRI copied verbatim from the stage's declared-properties catalog."},
                    "newValue": {"type": "string", "description": "The new literal value to set."},
                },
                "required": ["predicateIri", "newValue"],
            },
        },
        "rationale": {"type": "string"},
        "expectedImpact": {"type": "string"},
    },
    "required": ["targetStageId", "updatedComment", "rationale", "expectedImpact"],
}


def _label(graph, subject) -> str:
    value = next(graph.objects(subject, RDFS.label), None)
    return str(value) if value is not None else str(subject)


def _resolve_metric(graph, stage, metric_label: str):
    """Find the metric a stage computes by its CURRENT label. The model sometimes
    echoes back a label it thinks is already current (e.g. one it proposed renaming
    to in an earlier turn) rather than the graph's real one - if there's exactly one
    metric on this stage, that ambiguity doesn't matter, so fall back to it rather
    than silently doing nothing."""
    metrics = list(graph.objects(stage, COMPUTES_METRIC))
    match = next((m for m in metrics if _label(graph, m) == metric_label), None)
    if match is not None:
        return match
    if len(metrics) == 1:
        return metrics[0]
    return None


def _resolve_product(graph, stage, current_label: str, role: str):
    """Find an existing input/output product of a stage by its CURRENT label, same
    single-candidate fallback as _resolve_metric for when the model's memory of the
    label has drifted (e.g. after an earlier rename in this conversation)."""
    predicate = HAS_INPUT if role == "input" else HAS_OUTPUT
    candidates = list(graph.objects(stage, predicate))
    match = next((p for p in candidates if _label(graph, p) == current_label), None)
    if match is not None:
        return match
    if len(candidates) == 1:
        return candidates[0]
    return None


def _usable_products(raw) -> list[dict]:
    """A product with no name has no IRI and no label, so there is nothing to insert.

    Smaller models routinely omit `name`. Unfiltered, that reached apply_proposal's
    `product['name']` as a KeyError, which _guard rendered for the user as the bare
    message "'name'" - losing the whole proposal, including its valid comment and formula
    writes. Filter here, where the model's output becomes the stored proposal, so that
    apply_proposal and revert_proposal can both index ["name"] safely. newMetrics is
    filtered the same way, on label and formula.
    """
    return [item for item in (raw or []) if isinstance(item, dict) and str(item.get("name") or "").strip()]


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")


def _sparql_literal(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'"{escaped}"'


def _shared_domain_type(graph, runtime_types) -> str | None:
    """The single domain (non-core-taxonomy) class that EVERY existing instance of ANY of
    these runtime types also carries - e.g. every Product/IntermediateProduct/FinalProduct/
    SourceOfRecord instance also being ea:PipelineArtifact. A newProducts/newMetrics entry
    only ever gets a runtime type (rps:product, freqrec:Metric); without this, it would
    never pick up the domain-specific class the rest of the ontology's products/metrics
    all share (the exact gap classgen.py's instances no longer have, since they dual-type
    from a reused class - this is the same fix for modify.py's own node-minting path).
    Returns None rather than guessing when there are no instances to learn from, or they
    disagree - same discipline as classgen.py's _secondary_types."""
    instances = set()
    for runtime_type in runtime_types:
        instances.update(graph.subjects(RDF.type, runtime_type))
    if not instances:
        return None
    domain_sets = [
        {str(t) for t in graph.objects(instance, RDF.type) if str(t) not in _CORE_TAXONOMY_TYPES}
        for instance in instances
    ]
    first = domain_sets[0]
    if first and len(first) == 1 and all(domain == first for domain in domain_sets[1:]):
        return next(iter(first))
    return None


def _stage_catalog(graph) -> str:
    lines = []
    for stage in sorted(graph.subjects(RDF.type, ANALYTICAL_PROCESS), key=lambda s: _label(graph, s)):
        comment = str(next(graph.objects(stage, RDFS.comment), ""))
        lines.append(f"- {stage} (label: {_label(graph, stage)}): {comment}")
    return "\n".join(lines)


def _declared_parameters(graph, stage) -> list[dict]:
    """Datatype properties declared (via rdfs:domain) on any class this stage is an
    rdf:type of - e.g. a tunable setting like a null-handling strategy defined when
    the stage's class was created via the class generator. Each entry carries the
    property's current value(s) so the model can propose changing them via
    parameterUpdates instead of reaching for a code edit that leaves them stale."""
    properties: dict = {}
    for cls in graph.objects(stage, RDF.type):
        for prop in graph.subjects(RDFS.domain, cls):
            if prop in properties or (prop, RDF.type, OWL.DatatypeProperty) not in graph:
                continue
            properties[prop] = {
                "iri": str(prop),
                "label": _label(graph, prop),
                "values": [str(v) for v in graph.objects(stage, prop)],
            }
    return list(properties.values())


def _stage_description(graph, stage) -> str:
    label = _label(graph, stage)
    comment = str(next(graph.objects(stage, RDFS.comment), ""))
    inputs = [_label(graph, o) for o in graph.objects(stage, HAS_INPUT)]
    outputs = [_label(graph, o) for o in graph.objects(stage, HAS_OUTPUT)]
    metrics = []
    for metric in graph.objects(stage, COMPUTES_METRIC):
        formula = str(next(graph.objects(metric, FORMULA), ""))
        metrics.append(f"{_label(graph, metric)} (formula: {formula})")
    params = _declared_parameters(graph, stage)
    param_lines = "\n".join(
        f"  - {p['label']} ({p['iri']}) = {', '.join(p['values']) or '(not set)'}" for p in params
    ) or "  (none)"
    return (
        f"Stage IRI: {stage}\nLabel: {label}\nComment: {comment}\n"
        f"Inputs: {', '.join(inputs) or 'none'}\nOutputs: {', '.join(outputs) or 'none'}\n"
        f"Computes: {', '.join(metrics) or 'none'}\n"
        f"Declared properties (update via parameterUpdates, using the exact IRI in parentheses):\n{param_lines}"
    )


def _flow_order(graph) -> list:
    """Topologically sort stages by pipeline flow: explicit isIntermedateProcessto
    edges, unioned with edges implied by one stage's hasOutput feeding another's
    hasInput. Parallel/independent stages break ties alphabetically by label so
    the order is stable. Any leftover (a cycle) is appended in label order."""
    stages = list(graph.subjects(RDF.type, ANALYTICAL_PROCESS))
    label = lambda s: _label(graph, s)

    successors: dict = {s: set() for s in stages}
    for source, target in graph.subject_objects(IS_INTERMEDIATE_TO):
        if source in successors and target in successors:
            successors[source].add(target)
    for output_stage, product in graph.subject_objects(HAS_OUTPUT):
        if output_stage not in successors:
            continue
        for input_stage in graph.subjects(HAS_INPUT, product):
            if input_stage in successors:
                successors[output_stage].add(input_stage)

    indegree = {s: 0 for s in stages}
    for source, targets in successors.items():
        for target in targets:
            indegree[target] += 1

    ready = sorted((s for s in stages if indegree[s] == 0), key=label)
    order: list = []
    while ready:
        node = ready.pop(0)
        order.append(node)
        newly_ready = []
        for neighbor in successors[node]:
            indegree[neighbor] -= 1
            if indegree[neighbor] == 0:
                newly_ready.append(neighbor)
        ready = sorted(ready + newly_ready, key=label)

    remaining = [s for s in stages if s not in order]
    order.extend(sorted(remaining, key=label))
    return order


def list_stages() -> list[dict]:
    graph = construct(ALL_TRIPLES)
    return [{"id": str(stage), "label": _label(graph, stage)} for stage in _flow_order(graph)]


SUGGEST_EXAMPLES_SCHEMA = {
    "type": "object",
    "properties": {
        "examples": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "targetStageId": {"type": "string"},
                    "instruction": {"type": "string", "description": "a concrete, plain-English modification request a user might make for this stage"},
                    "rationale": {"type": "string", "description": "one short sentence on why this would be a useful, realistic change"},
                },
                "required": ["targetStageId", "instruction", "rationale"],
            },
        }
    },
    "required": ["examples"],
}


def suggest_modification_examples() -> list[dict]:
    """LLM-generated example instructions, grounded in the pipeline actually
    loaded in this Studio - not hardcoded placeholders."""
    graph = construct(ALL_TRIPLES)
    stages = _flow_order(graph)
    if not stages:
        return []
    summary = "\n\n".join(_stage_description(graph, stage) for stage in stages)

    result = call_structured(
        system=(
            "You suggest example plain-English modification requests for an RDF "
            "pipeline-lineage model, to show a user what this Modify feature can do. "
            "Ground every example in what the pipeline actually does - reference real "
            "stage names, real metric formulas, real thresholds/units where relevant. "
            "Spread examples across different stages rather than clustering on one. "
            "Keep each instruction short and concrete, like something a real user "
            "would type."
        ),
        user_content=f"Pipeline:\n\n{summary}\n\nPropose 4-5 example modification requests.",
        tool_name="report_examples",
        tool_description="Report example modification requests for this pipeline.",
        tool_schema=SUGGEST_EXAMPLES_SCHEMA,
        max_tokens=4000,
    )

    stage_labels = {str(stage): _label(graph, stage) for stage in stages}
    examples = []
    for item in result.get("examples", []):
        target = item.get("targetStageId")
        if target not in stage_labels or not item.get("instruction"):
            continue
        examples.append({
            "targetStageId": target,
            "targetStageLabel": stage_labels[target],
            "instruction": item["instruction"],
            "rationale": item.get("rationale", ""),
        })
    return examples


def propose_modification(instruction: str, target_stage_id: str | None = None, pasted_code: str | None = None) -> dict:
    graph = construct(ALL_TRIPLES)
    if target_stage_id:
        stage = URIRef(target_stage_id)
        if (stage, RDF.type, ANALYTICAL_PROCESS) not in graph:
            raise ValueError(f"Unknown stage: {target_stage_id}")
        context = f"You must target exactly this stage:\n{_stage_description(graph, stage)}"
    else:
        context = f"Pick the single most appropriate stage to modify from this pipeline:\n{_stage_catalog(graph)}"

    code_block = f"\n\nThe user also pasted this stage's current script for reference:\n```python\n{pasted_code}\n```\nInclude a codeSuggestion (the full modified script) since code was provided." if pasted_code else "\n\nNo code was provided - leave codeSuggestion null."

    user_content = f"Requested change: {instruction}\n\n{context}{code_block}"
    result = call_structured(
        system=(
            "You propose a minimal, targeted modification to one stage of an RDF "
            "pipeline-lineage model, in response to a plain-English request. Always "
            "return an updated rdfs:comment for the stage that reflects the change. "
            "If the request renames the stage itself, set newStageLabel to the new "
            "name - otherwise leave it null; updating the comment alone does NOT "
            "rename anything. Only include metricUpdate if the change MODIFIES a "
            "metric this stage already computes - metricLabel must exactly match the "
            "metric's CURRENT label so it can be found, even when newLabel renames "
            "it. If the request ADDS an additional metric alongside what the stage "
            "already computes, that is newMetrics, never metricUpdate - putting a new "
            "metric's name in metricUpdate.metricLabel would silently overwrite the "
            "existing metric instead of adding a second one, which is wrong and has "
            "happened before; when in doubt about add-vs-modify, re-read the request "
            "for words like 'add'/'also'/'second' (newMetrics) vs 'change'/'update' "
            "(metricUpdate). Only include newProducts for genuinely new inputs/outputs the "
            "change introduces - use renamedProducts to rename an EXISTING "
            "input/output (keyed by its CURRENT label), and removedProducts to drop "
            "one entirely. If the request says a stage no longer needs some input/ "
            "output, you MUST add it to removedProducts - do not just describe the "
            "removal in updatedComment, that does not delete the underlying link. "
            "Every input/output on a stage must keep a distinct, specific name - never "
            "rename two different ones to the same generic label (e.g. both becoming "
            "'input_data.json'), that request will be rejected. This endpoint can only "
            "modify ONE existing stage - it cannot create a new stage or split this one "
            "into several; if the request asks for that, say so in updatedComment/"
            "rationale rather than faking it via renames. If the request describes a "
            "change to a setting already listed under the stage's 'Declared properties' "
            "(e.g. a strategy, threshold, or window), use parameterUpdates to set its new "
            "value - do not simulate this by only rewriting a codeSuggestion, since that "
            "would leave the declared property showing its old value even though the "
            "described behavior changed."
        ),
        user_content=user_content,
        tool_name="report_modification",
        tool_description="Report the proposed RDF patch (and optional code suggestion) for this change.",
        tool_schema=MODIFY_TOOL_SCHEMA,
        max_tokens=16000,
    )
    missing = [key for key in ("targetStageId", "updatedComment", "rationale", "expectedImpact") if key not in result]
    if missing:
        raise ValueError(f"Model response was missing fields {missing} - try again.")

    target = result["targetStageId"]
    target_ref = URIRef(target)
    if (target_ref, RDF.type, ANALYTICAL_PROCESS) not in graph:
        if target_stage_id:
            target = target_stage_id
            target_ref = URIRef(target)
        else:
            raise ValueError(f"Model proposed an unknown target stage: {target}")

    # Snapshot the pre-edit metric formula/label so a later revert can restore them.
    metric_update = result.get("metricUpdate")
    if metric_update and metric_update.get("metricLabel"):
        if not metric_update.get("newFormula"):
            # Schema marks this required, but not every provider enforces "required"
            # strictly on structured tool output - catch it here at propose time with
            # a clear message instead of a bare KeyError later at apply time.
            raise ValueError("Model's metricUpdate is missing newFormula - try again.")
        metric = _resolve_metric(graph, target_ref, metric_update["metricLabel"])
        if metric is None:
            raise ValueError(
                f"Model's metricUpdate names a metric ('{metric_update['metricLabel']}') that "
                f"doesn't match any metric this stage currently computes - try again."
            )
        metric_update = {
            **metric_update,
            "previousFormula": str(next(graph.objects(metric, FORMULA), "")),
            "previousLabel": _label(graph, metric),
        }

    # Resolve each renamed product against the stage's CURRENT inputs/outputs so
    # revert has something real to restore, same discipline as the metric above.
    renamed_products = []
    for item in result.get("renamedProducts") or []:
        if not item.get("currentLabel") or not item.get("newLabel") or item.get("role") not in ("input", "output"):
            continue
        product = _resolve_product(graph, target_ref, item["currentLabel"], item["role"])
        if product is None:
            raise ValueError(
                f"Model's renamedProducts names a {item['role']} ('{item['currentLabel']}') that "
                f"doesn't match any current {item['role']} of this stage - try again."
            )
        renamed_products.append({
            "productId": str(product),
            "previousLabel": _label(graph, product),
            "newLabel": item["newLabel"],
        })

    # Same resolve-by-current-label discipline, but for dropping the hasInput/
    # hasOutput link entirely rather than renaming it.
    removed_products = []
    for item in result.get("removedProducts") or []:
        if not item.get("currentLabel") or item.get("role") not in ("input", "output"):
            continue
        product = _resolve_product(graph, target_ref, item["currentLabel"], item["role"])
        if product is None:
            raise ValueError(
                f"Model's removedProducts names a {item['role']} ('{item['currentLabel']}') that "
                f"doesn't match any current {item['role']} of this stage - try again."
            )
        removed_products.append({
            "productId": str(product),
            "label": _label(graph, product),
            "role": item["role"],
        })

    # Only a predicate already declared (via rdfs:domain) on one of this stage's
    # rdf:type classes may be updated - same discipline as the resolves above, so a
    # hallucinated IRI is caught at propose time rather than silently no-op'd at apply.
    declared_params = {p["iri"]: p for p in _declared_parameters(graph, target_ref)}
    parameter_updates = []
    for item in result.get("parameterUpdates") or []:
        predicate_iri = (item.get("predicateIri") or "").strip()
        new_value = item.get("newValue")
        if not predicate_iri or new_value is None:
            continue
        declared = declared_params.get(predicate_iri)
        if declared is None:
            raise ValueError(
                f"Model's parameterUpdates names a property ('{predicate_iri}') that isn't "
                f"declared on this stage - try again using one of its declared properties."
            )
        parameter_updates.append({
            "predicateIri": predicate_iri,
            "label": declared["label"],
            "previousValues": declared["values"],
            "newValue": str(new_value),
        })

    # Reject a rename batch that would collapse two distinct inputs/outputs onto the
    # same label - e.g. renaming both "Route length" and "Revenue per trip" to a
    # generic "input_data.json" leaves them indistinguishable on the canvas. Checked
    # against every product still on the stage after removals, not just the ones
    # being renamed, since a rename could also collide with one left untouched.
    removed_ids = {r["productId"] for r in removed_products}
    surviving_products = [
        p for p in list(graph.objects(target_ref, HAS_INPUT)) + list(graph.objects(target_ref, HAS_OUTPUT))
        if str(p) not in removed_ids
    ]
    renamed_label_by_id = {r["productId"]: r["newLabel"] for r in renamed_products}
    names_by_final_label: dict[str, list[str]] = {}
    for product in surviving_products:
        final_label = renamed_label_by_id.get(str(product), _label(graph, product))
        names_by_final_label.setdefault(final_label, []).append(_label(graph, product))
    collision = next(((label, names) for label, names in names_by_final_label.items() if len(names) > 1), None)
    if collision:
        label, names = collision
        raise ValueError(
            f"Rejected: this would leave {', '.join(repr(n) for n in names)} sharing the same "
            f"label ('{label}') on this stage, making them indistinguishable. Each input/output "
            f"needs a unique name - try again with distinct labels."
        )

    # A new metric whose label matches one this stage already computes (or another
    # new one in the same batch) isn't "new" - it's the overwrite bug this exists to
    # prevent, just approached from the other direction. Reject it explicitly rather
    # than silently minting a same-labelled duplicate metric resource.
    new_metrics = [
        {"label": item["label"].strip(), "formula": item["formula"], "unit": item.get("unit") or "", "groundedIn": item.get("groundedIn") or ""}
        for item in (result.get("newMetrics") or [])
        if item.get("label") and item.get("formula")
    ]
    if new_metrics:
        existing_labels = {_label(graph, m) for m in graph.objects(target_ref, COMPUTES_METRIC)}
        seen = set()
        for item in new_metrics:
            if item["label"] in existing_labels:
                raise ValueError(
                    f"Rejected: newMetrics proposes '{item['label']}', which matches a metric this "
                    f"stage already computes - use metricUpdate to modify an existing metric, "
                    f"newMetrics is only for a genuinely additional one."
                )
            if item["label"] in seen:
                raise ValueError(f"Rejected: newMetrics lists '{item['label']}' more than once.")
            seen.add(item["label"])

    proposal_id = uuid.uuid4().hex[:12]
    proposal = {
        "id": proposal_id,
        "instruction": instruction,
        "targetStageId": target,
        "targetStageLabel": _label(graph, target_ref),
        "previousComment": str(next(graph.objects(target_ref, RDFS.comment), "")),
        "updatedComment": result["updatedComment"],
        "previousStageLabel": _label(graph, target_ref),
        "newStageLabel": result.get("newStageLabel") or None,
        "metricUpdate": metric_update,
        "newProducts": _usable_products(result.get("newProducts")),
        "newMetrics": new_metrics,
        "renamedProducts": renamed_products,
        "removedProducts": removed_products,
        "parameterUpdates": parameter_updates,
        "codeSuggestion": result.get("codeSuggestion"),
        "rationale": result["rationale"],
        "expectedImpact": result["expectedImpact"],
        "createdAt": time.time(),
    }
    PROPOSALS[proposal_id] = proposal
    return proposal


def get_proposal(proposal_id: str) -> dict:
    proposal = PROPOSALS.get(proposal_id)
    if not proposal:
        raise KeyError(f"Unknown proposal: {proposal_id}")
    return proposal


def apply_proposal(proposal_id: str) -> dict:
    proposal = get_proposal(proposal_id)
    graph = construct(ALL_TRIPLES)
    stage = URIRef(proposal["targetStageId"])
    if (stage, RDF.type, ANALYTICAL_PROCESS) not in graph:
        raise ValueError("The target stage no longer exists in the graph.")

    deletes = [f"<{stage}> <{RDFS.comment}> ?oldComment"]
    inserts = [f"<{stage}> <{RDFS.comment}> {_sparql_literal(proposal['updatedComment'])}"]
    where_parts = [f"OPTIONAL {{ <{stage}> <{RDFS.comment}> ?oldComment }}"]

    if proposal.get("newStageLabel"):
        deletes.append(f"<{stage}> <{RDFS.label}> ?oldLabel")
        inserts.append(f"<{stage}> <{RDFS.label}> {_sparql_literal(proposal['newStageLabel'])}")
        where_parts.append(f"OPTIONAL {{ <{stage}> <{RDFS.label}> ?oldLabel }}")

    metric_update = proposal.get("metricUpdate")
    if metric_update and metric_update.get("metricLabel"):
        metric = _resolve_metric(graph, stage, metric_update["metricLabel"])
        if metric is None:
            raise ValueError(
                f"Can't find the metric ('{metric_update['metricLabel']}') this proposal targets - "
                f"it may have already been renamed since this change was proposed."
            )
        new_formula = metric_update.get("newFormula")
        if not new_formula:
            raise ValueError("This proposal's metricUpdate has no newFormula recorded - it may be malformed.")
        deletes.append(f"<{metric}> <{FORMULA}> ?oldFormula")
        inserts.append(f"<{metric}> <{FORMULA}> {_sparql_literal(new_formula)}")
        # Bind ?oldFormula against the specific resolved metric, not a generic
        # ?m - a stage can compute more than one metric.
        where_parts.append(f"OPTIONAL {{ <{metric}> <{FORMULA}> ?oldFormula }}")
        if metric_update.get("newLabel"):
            deletes.append(f"<{metric}> <{RDFS.label}> ?oldMetricLabel")
            inserts.append(f"<{metric}> <{RDFS.label}> {_sparql_literal(metric_update['newLabel'])}")
            where_parts.append(f"OPTIONAL {{ <{metric}> <{RDFS.label}> ?oldMetricLabel }}")

    # Resolved to a stable IRI at propose time, so no re-lookup-by-label needed here.
    for index, renamed in enumerate(proposal.get("renamedProducts", [])):
        product_iri = renamed["productId"]
        var = f"?oldProductLabel{index}"
        deletes.append(f"<{product_iri}> <{RDFS.label}> {var}")
        inserts.append(f"<{product_iri}> <{RDFS.label}> {_sparql_literal(renamed['newLabel'])}")
        where_parts.append(f"OPTIONAL {{ <{product_iri}> <{RDFS.label}> {var} }}")

    # Drops the hasInput/hasOutput LINK only, not the product resource itself (it
    # may still be linked from elsewhere). The WHERE clause must stay OPTIONAL here
    # too - a required (non-OPTIONAL) triple that fails to match would zero out the
    # WHOLE combined update, silently dropping the comment/formula/label writes above.
    for removed in proposal.get("removedProducts", []):
        product_iri = removed["productId"]
        predicate = HAS_INPUT if removed["role"] == "input" else HAS_OUTPUT
        deletes.append(f"<{stage}> <{predicate}> <{product_iri}>")
        where_parts.append(f"OPTIONAL {{ <{stage}> <{predicate}> <{product_iri}> }}")

    # Replaces whatever value(s) this declared property currently holds with the
    # single new one - correct for the common rps:multiple=false case (a strategy/
    # threshold/window setting); for a multi-valued property this collapses the list
    # to one value, which is the same "set it to X" semantics a plain-English request
    # implies.
    for index, param in enumerate(proposal.get("parameterUpdates", [])):
        predicate_iri = param["predicateIri"]
        var = f"?oldParamValue{index}"
        deletes.append(f"<{stage}> <{predicate_iri}> {var}")
        inserts.append(f"<{stage}> <{predicate_iri}> {_sparql_literal(param['newValue'])}")
        where_parts.append(f"OPTIONAL {{ <{stage}> <{predicate_iri}> {var} }}")

    # A brand-new product/metric only ever gets its runtime type (rps:product,
    # freqrec:Metric) here - without also picking up whatever domain class the rest of
    # the ontology's products/metrics share (e.g. ea:PipelineArtifact), it would be the
    # one node of its kind NOT modeled in the user's own ontology, invisible to anything
    # that reasons over that domain class specifically.
    product_domain_type = _shared_domain_type(graph, _PRODUCT_RUNTIME_TYPES)
    metric_domain_type = _shared_domain_type(graph, (METRIC_CLASS,))

    extra_inserts = []
    for product in proposal.get("newProducts", []):
        iri = f"{AI_BASE}/{_slug(product['name'])}"
        types = f"<{PRODUCT}>" + (f", <{product_domain_type}>" if product_domain_type else "")
        extra_inserts.append(f'<{iri}> a {types} ; <{RDFS.label}> {_sparql_literal(product["name"])} .')
        predicate = HAS_INPUT if product.get("role") == "input" else HAS_OUTPUT
        extra_inserts.append(f"<{stage}> <{predicate}> <{iri}> .")

    # Mints an ADDITIONAL metric resource under the same distinct AI-generated
    # namespace as newProducts uses, then links it alongside whatever this stage
    # already computes - existing computesMetric edges/metrics are untouched.
    for metric_item in proposal.get("newMetrics", []):
        iri = f"{AI_BASE}/{_slug(metric_item['label'])}"
        types = f"<{METRIC_CLASS}>" + (f", <{metric_domain_type}>" if metric_domain_type else "")
        metric_triples = f'<{iri}> a {types} ; <{RDFS.label}> {_sparql_literal(metric_item["label"])} ; <{FORMULA}> {_sparql_literal(metric_item["formula"])}'
        if metric_item.get("unit"):
            metric_triples += f' ; <{UNIT}> {_sparql_literal(metric_item["unit"])}'
        if metric_item.get("groundedIn"):
            metric_triples += f' ; <{GROUNDED_IN}> {_sparql_literal(metric_item["groundedIn"])}'
        extra_inserts.append(metric_triples + " .")
        extra_inserts.append(f"<{stage}> <{COMPUTES_METRIC}> <{iri}> .")

    delete_clause = " . ".join(deletes)
    insert_clause = " . ".join(inserts) + (" . " + " ".join(extra_inserts) if extra_inserts else "")
    where_clause = " ".join(where_parts)
    sparql = f"DELETE {{ {delete_clause} }} INSERT {{ {insert_clause} }} WHERE {{ {where_clause} }}"

    update(sparql)

    fresh_graph = construct(ALL_TRIPLES)
    consistency = rdf_consistency.check_pipeline_graph(fresh_graph)
    proposal["appliedAt"] = time.time()
    return {"proposalId": proposal_id, "sparqlApplied": sparql, "structuralIssues": consistency}


def revert_proposal(proposal_id: str) -> dict:
    """Undo an applied modification: restore the stage's previous rdfs:comment and, if a
    metric formula was changed, the previous formula. New products the change introduced
    have no prior state, so they are reported for manual removal rather than deleted."""
    proposal = get_proposal(proposal_id)
    graph = construct(ALL_TRIPLES)
    stage = URIRef(proposal["targetStageId"])
    if (stage, RDF.type, ANALYTICAL_PROCESS) not in graph:
        raise ValueError("The target stage no longer exists in the graph.")

    deletes = [f"<{stage}> <{RDFS.comment}> ?curComment"]
    inserts = [f"<{stage}> <{RDFS.comment}> {_sparql_literal(proposal['previousComment'])}"]
    where_parts = [f"OPTIONAL {{ <{stage}> <{RDFS.comment}> ?curComment }}"]

    if proposal.get("newStageLabel") and proposal.get("previousStageLabel"):
        deletes.append(f"<{stage}> <{RDFS.label}> ?curLabel")
        inserts.append(f"<{stage}> <{RDFS.label}> {_sparql_literal(proposal['previousStageLabel'])}")
        where_parts.append(f"OPTIONAL {{ <{stage}> <{RDFS.label}> ?curLabel }}")

    metric_update = proposal.get("metricUpdate")
    previous_formula = (metric_update or {}).get("previousFormula")
    # After a rename, the metric must now be found by its NEW label (what apply wrote),
    # falling back to the original in case apply's label write didn't happen.
    lookup_label = (metric_update or {}).get("newLabel") or (metric_update or {}).get("metricLabel")
    if metric_update and lookup_label and previous_formula is not None:
        metric = _resolve_metric(graph, stage, lookup_label)
        if metric is None:
            raise ValueError(f"Can't find the metric ('{lookup_label}') to revert - it may have already changed since this was applied.")
        deletes.append(f"<{metric}> <{FORMULA}> ?curFormula")
        inserts.append(f"<{metric}> <{FORMULA}> {_sparql_literal(previous_formula)}")
        where_parts.append(f"OPTIONAL {{ <{metric}> <{FORMULA}> ?curFormula }}")
        if metric_update.get("newLabel") and metric_update.get("previousLabel"):
            deletes.append(f"<{metric}> <{RDFS.label}> ?curMetricLabel")
            inserts.append(f"<{metric}> <{RDFS.label}> {_sparql_literal(metric_update['previousLabel'])}")
            where_parts.append(f"OPTIONAL {{ <{metric}> <{RDFS.label}> ?curMetricLabel }}")

    for index, renamed in enumerate(proposal.get("renamedProducts", [])):
        product_iri = renamed["productId"]
        var = f"?curProductLabel{index}"
        deletes.append(f"<{product_iri}> <{RDFS.label}> {var}")
        inserts.append(f"<{product_iri}> <{RDFS.label}> {_sparql_literal(renamed['previousLabel'])}")
        where_parts.append(f"OPTIONAL {{ <{product_iri}> <{RDFS.label}> {var} }}")

    # Re-add the link apply dropped. Pure INSERT, nothing to delete/match first - the
    # WHERE clause above already guarantees at least one solution row (the comment's
    # own OPTIONAL), so this fires exactly once regardless of whether anything else
    # in this proposal changed.
    for removed in proposal.get("removedProducts", []):
        product_iri = removed["productId"]
        predicate = HAS_INPUT if removed["role"] == "input" else HAS_OUTPUT
        inserts.append(f"<{stage}> <{predicate}> <{product_iri}>")

    for index, param in enumerate(proposal.get("parameterUpdates", [])):
        predicate_iri = param["predicateIri"]
        var = f"?curParamValue{index}"
        deletes.append(f"<{stage}> <{predicate_iri}> {var}")
        where_parts.append(f"OPTIONAL {{ <{stage}> <{predicate_iri}> {var} }}")
        for previous in param.get("previousValues", []):
            inserts.append(f"<{stage}> <{predicate_iri}> {_sparql_literal(previous)}")

    sparql = f"DELETE {{ {' . '.join(deletes)} }} INSERT {{ {' . '.join(inserts)} }} WHERE {{ {' '.join(where_parts)} }}"
    update(sparql)
    proposal["revertedAt"] = time.time()
    return {
        "proposalId": proposal_id,
        "sparqlApplied": sparql,
        "manualRemoval": [p["name"] for p in proposal.get("newProducts", [])] + [m["label"] for m in proposal.get("newMetrics", [])],
    }
