"""Lineage verification, RDF-only.

Two tiers:
- Deterministic (no LLM, no filesystem): rdf_consistency.check_pipeline_graph -
  dangling references, orphan products, missing metadata, dependency cycles.
- LLM plausibility pass: reads the pipeline's own text (stage descriptions,
  declared inputs/outputs, metric formulas/units/groundedIn) and flags places
  where the model doesn't read as internally coherent. This is no longer a
  code-vs-RDF check - there's no code unless the user explicitly pastes it.

verify_stage_against_code() is the opt-in exception: the user pastes one
stage's script text for a single request (never stored, never read from disk)
and gets the old formula-vs-code check, scoped to that stage.
"""
from rdflib import RDF, RDFS, URIRef

from . import rdf_consistency
from .client import call_structured
from ..store import construct

RPS = "https://w3id.org/rdf-pipeline-studio#"
FREQREC = "https://bmtc.datakaveri.org/freqrec#"

ANALYTICAL_PROCESS = URIRef(f"{RPS}analyticalProcess")
HAS_INPUT = URIRef(f"{RPS}hasInput")
HAS_OUTPUT = URIRef(f"{RPS}hasOutput")
COMPUTES_METRIC = URIRef(f"{RPS}computesMetric")
METRIC_CLASS = URIRef(f"{FREQREC}Metric")
FORMULA = URIRef(f"{FREQREC}formula")
UNIT = URIRef(f"{FREQREC}unit")
GROUNDED_IN = URIRef(f"{FREQREC}groundedIn")

ALL_TRIPLES = "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }"

PLAUSIBILITY_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "description": "the stage or metric label this finding is about"},
                    "severity": {"type": "string", "enum": ["info", "warning"]},
                    "message": {"type": "string"},
                },
                "required": ["subject", "severity", "message"],
            },
        }
    },
    "required": ["findings"],
}

STAGE_CODE_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "consistent": {"type": "boolean"},
        "explanation": {"type": "string"},
        "perMetric": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "metric": {"type": "string"},
                    "consistent": {"type": "boolean"},
                    "explanation": {"type": "string"},
                },
                "required": ["metric", "consistent", "explanation"],
            },
        },
    },
    "required": ["consistent", "explanation", "perMetric"],
}


def _label(graph, subject) -> str:
    value = next(graph.objects(subject, RDFS.label), None)
    return str(value) if value is not None else str(subject)


def _pipeline_text_summary(graph) -> str:
    lines = []
    for stage in sorted(graph.subjects(RDF.type, ANALYTICAL_PROCESS), key=lambda s: _label(graph, s)):
        label = _label(graph, stage)
        comment = str(next(graph.objects(stage, RDFS.comment), ""))
        inputs = [_label(graph, o) for o in graph.objects(stage, HAS_INPUT)]
        outputs = [_label(graph, o) for o in graph.objects(stage, HAS_OUTPUT)]
        metrics = [_label(graph, o) for o in graph.objects(stage, COMPUTES_METRIC)]
        lines.append(
            f"Stage: {label}\n  Description: {comment}\n  Inputs: {', '.join(inputs) or 'none'}\n"
            f"  Outputs: {', '.join(outputs) or 'none'}\n  Computes: {', '.join(metrics) or 'none'}"
        )
    for metric in sorted(graph.subjects(RDF.type, METRIC_CLASS), key=lambda m: _label(graph, m)):
        label = _label(graph, metric)
        formula = str(next(graph.objects(metric, FORMULA), ""))
        unit = str(next(graph.objects(metric, UNIT), ""))
        grounded = str(next(graph.objects(metric, GROUNDED_IN), ""))
        lines.append(f"Metric: {label}\n  Formula: {formula}\n  Unit: {unit}\n  Grounded in: {grounded}")
    return "\n\n".join(lines)


def run_lineage_verification() -> dict:
    graph = construct(ALL_TRIPLES)
    structural_issues = rdf_consistency.check_pipeline_graph(graph)

    result = call_structured(
        system=(
            "You review an RDF pipeline-lineage model for internal coherence. You only "
            "see the model's own text (stage descriptions, declared inputs/outputs, "
            "metric formulas/units/groundedIn) - not the real code. Flag places where "
            "the model doesn't read as internally consistent: a formula referencing a "
            "quantity not covered by its own groundedIn, a unit that doesn't match the "
            "formula's shape, a stage description implying inputs/outputs it doesn't "
            "declare, etc. Don't invent problems - only flag things the text itself "
            "makes evident."
        ),
        user_content=f"Pipeline model:\n\n{_pipeline_text_summary(graph)}",
        tool_name="report_plausibility_findings",
        tool_description="Report internal-coherence findings about this RDF pipeline model.",
        tool_schema=PLAUSIBILITY_TOOL_SCHEMA,
    )

    return {
        "stageCount": len(set(graph.subjects(RDF.type, ANALYTICAL_PROCESS))),
        "structuralIssues": structural_issues,
        "plausibilityFindings": result.get("findings", []),
    }


def verify_stage_against_code(stage_id: str, code: str) -> dict:
    graph = construct(ALL_TRIPLES)
    stage = URIRef(stage_id)
    if (stage, RDF.type, ANALYTICAL_PROCESS) not in graph:
        raise ValueError(f"Unknown stage: {stage_id}")

    label = _label(graph, stage)
    comment = str(next(graph.objects(stage, RDFS.comment), ""))
    inputs = [_label(graph, o) for o in graph.objects(stage, HAS_INPUT)]
    outputs = [_label(graph, o) for o in graph.objects(stage, HAS_OUTPUT)]
    metrics = [
        {
            "label": _label(graph, metric),
            "formula": str(next(graph.objects(metric, FORMULA), "")),
            "unit": str(next(graph.objects(metric, UNIT), "")),
            "groundedIn": str(next(graph.objects(metric, GROUNDED_IN), "")),
        }
        for metric in graph.objects(stage, COMPUTES_METRIC)
    ]
    metric_lines = "\n".join(
        f"- {m['label']}: formula = `{m['formula']}`, unit = {m['unit']}, grounded in: {m['groundedIn']}" for m in metrics
    ) or "(this stage declares no metrics)"

    user_content = (
        f"RDF description of this stage:\n- Label: {label}\n- Comment: {comment}\n"
        f"- Declared inputs: {', '.join(inputs) or 'none'}\n- Declared outputs: {', '.join(outputs) or 'none'}\n"
        f"- Declared metrics:\n{metric_lines}\n\n"
        f"Pasted script source for this stage:\n```python\n{code}\n```\n\n"
        "Check whether the code actually does what the RDF claims: does it read/produce "
        "the declared inputs/outputs, and does it compute each declared metric's formula "
        "correctly? Be skeptical - only say consistent if the code plainly matches."
    )
    result = call_structured(
        system="You audit one RDF pipeline stage's lineage claims against its real implementation.",
        user_content=user_content,
        tool_name="report_stage_code_check",
        tool_description="Report whether the pasted code matches this stage's RDF claims.",
        tool_schema=STAGE_CODE_TOOL_SCHEMA,
        max_tokens=8000,
    )
    return {"stage": label, **result}
