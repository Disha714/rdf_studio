"""Infer a typed signature for a node's code artifact: each function parameter
and the return value tagged with a class ALREADY DEFINED in the ontology. The
LLM only picks class labels from the ontology's own list; Python validates each
against the real classes and never lets a made-up type through. The user reviews
and saves the signature from the Inspector - nothing is persisted here.
"""
from rdflib import OWL, RDF, RDFS

from .client import call_structured
from ..store import construct, query_json

RPS = "https://w3id.org/rdf-pipeline-studio#"
OWL_CLASSES = "CONSTRUCT { ?s ?p ?o } WHERE { ?s a <http://www.w3.org/2002/07/owl#Class> . ?s ?p ?o }"


def _ontology_classes(graph) -> tuple[dict[str, str], dict[str, str]]:
    """The classes already defined in the ontology that inputs/outputs may be
    typed with. Returns (label_lower -> classIri, classIri -> label)."""
    by_label: dict[str, str] = {}
    by_iri: dict[str, str] = {}
    for cls in graph.subjects(RDF.type, OWL.Class):
        label = next(graph.objects(cls, RDFS.label), None)
        name = str(label) if label is not None else str(cls).split("#")[-1].split("/")[-1]
        by_label[name.strip().lower()] = str(cls)
        by_iri[str(cls)] = name
    return by_label, by_iri

INFER_SCHEMA = {
    "type": "object",
    "properties": {
        "inputs": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "class": {"type": "string"}},
                "required": ["name", "class"],
            },
        },
        "output": {"type": "object", "properties": {"class": {"type": "string"}}},
    },
    "required": ["inputs"],
}


def infer_signature(iri: str) -> dict:
    if not iri:
        raise ValueError("A node IRI is required.")
    rows = query_json(f"PREFIX rps: <{RPS}> SELECT ?code WHERE {{ <{iri}> rps:codeArtifact ?code }} LIMIT 1")
    bindings = rows.get("results", {}).get("bindings", [])
    if not bindings:
        raise ValueError("This node has no code artifact to infer a signature from - add code first.")
    code = bindings[0]["code"]["value"]

    by_label, by_iri = _ontology_classes(construct(OWL_CLASSES))
    if not by_iri:
        raise ValueError("The ontology has no classes to type against.")
    class_lines = "\n".join(f"- {name} ({iri_})" for iri_, name in sorted(by_iri.items(), key=lambda kv: kv[1]))

    result = call_structured(
        system=(
            "You type a function's parameters and its return value using ONLY classes from the "
            "given ontology - never invent a class. Prefer the data-structure class that matches "
            "each value's shape (Matrix, Table, Vector, Scalar, HashMap), or a domain class "
            "(Product, Metric, Source of Record) when that fits better."
        ),
        user_content=f"Ontology classes:\n{class_lines}\n\nFor each parameter and the return value of this function, choose the best-fitting ontology class label:\n\n```\n{code}\n```",
        tool_name="report_signature",
        tool_description="Report the function's ontology-typed signature.",
        tool_schema=INFER_SCHEMA,
        max_tokens=1500,
    )

    def resolve(raw: str | None):
        if not raw or not str(raw).strip():
            return None, None
        raw = str(raw).strip()
        if raw in by_iri:
            return raw, by_iri[raw]
        key = raw.lower()
        if key in by_label:
            return by_label[key], by_iri[by_label[key]]
        for label, class_iri in by_label.items():
            if key in label or label in key:
                return class_iri, by_iri[class_iri]
        return None, None

    inputs = []
    for item in result.get("inputs", []):
        class_iri, class_label = resolve(item.get("class"))
        inputs.append({"name": item.get("name", ""), "classIri": class_iri, "classLabel": class_label})
    out = result.get("output") or {}
    out_iri, out_label = resolve(out.get("class"))
    return {"inputs": inputs, "output": {"classIri": out_iri, "classLabel": out_label}}
