"""Generate proposed ontology-conformant RDF pipeline nodes from real script source
code. The LLM only returns simple structured fields (label, comment, input/output
names, metric formula) - this module, not the model, mints IRIs and serializes the
actual JSON-LD. That avoids malformed RDF or IRI collisions with existing data:
generated nodes live under a distinct `.../freqrec/ai/...` path so re-generating a
script that's already hand-modeled never silently overwrites the real node - the
user reviews and imports explicitly via the existing import endpoint.
"""
import json
import re

from rdflib import RDF, RDFS, URIRef

from ..store import construct
from .client import call_structured

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
CODE_ARTIFACT = f"{RPS}codeArtifact"
CODE_LANGUAGE = f"{RPS}codeLanguage"
CODE_ENTRYPOINT = f"{RPS}codeEntrypoint"
LABEL = str(RDFS.label)
COMMENT = str(RDFS.comment)

ALL_TRIPLES = "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }"

GENERATE_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "proposals": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "scriptFile": {"type": "string"},
                    "label": {"type": "string"},
                    "processClass": {"type": "string", "description": "IRI of the ontology class for this process/stage; choose from the provided ontology catalog."},
                    "comment": {"type": "string"},
                    "code": {"type": "string", "description": "A standalone function implementing THIS node's logic - takes the named inputs as arguments and returns the named outputs. Logic only: no file paths, no open()/read_csv()/to_json(), no I/O, no globals. When the user pasted code, extract/adapt this node's part; when only a description was given, write a minimal vanilla implementation."},
                    "entrypoint": {"type": "string", "description": "The function name in `code` (e.g. jaccard_similarity)."},
                    "language": {"type": "string", "description": "Programming language of `code` (default python)."},
                    "inputs": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {"name": {"type": "string"}, "classIri": {"type": "string"}}, "required": ["name"]}]}},
                    "outputs": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {"name": {"type": "string"}, "classIri": {"type": "string"}}, "required": ["name"]}]}},
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
                "required": ["scriptFile", "label", "comment", "inputs", "outputs"],
            },
        }
    },
    "required": ["proposals"],
}

CLARIFY_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "ready": {"type": "boolean"},
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "options": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["question"],
            },
        },
        "normalizedInstructions": {"type": "string"},
    },
    "required": ["ready", "questions", "normalizedInstructions"],
}

DEFAULT_INSTRUCTIONS = (
    "Model the pipeline as one or more AnalyticalProcess nodes. If the input is a SINGLE "
    "step (one function / a short description), emit ONE node. If it is a LARGER script "
    "with several distinct steps (e.g. a normalization step, then a similarity metric, "
    "then a distribution step), SPLIT it into one node PER step, in flow order, so each "
    "node is a single responsibility. A `label` is the step's conceptual name (snake_case, "
    "like the function it performs, not the filename). `inputs`/`outputs` are short "
    "human-readable names for the files or datasets each step reads/writes (an output of "
    "one step is typically the input of the next); infer from open()/read_csv()/json.load()"
    "/pd.read_* calls and any docstring Input/Output section, not full paths. For EACH node "
    "emit `code`: a standalone function (name it in `entrypoint`) implementing that step's "
    "logic, taking the named inputs as arguments and returning the named outputs - logic "
    "only, no file paths or I/O or globals. When the user pasted code, extract/adapt each "
    "step's part; when they only described the process, write a minimal vanilla "
    "implementation. Only include a `metric` when a node computes a specific named, "
    "formulaic measure (not just any arithmetic) - give its exact formula."
)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")


def _normalize_label(text: str) -> str:
    """Collapse case/punctuation/whitespace differences ("GTFS-Data" vs "gtfs
    data") so near-identical names from the LLM still resolve to the same
    existing node instead of minting a disconnected duplicate."""
    return re.sub(r"[^a-z0-9]+", " ", text.strip().lower()).strip()


def _existing_products(graph) -> dict[str, str]:
    """normalized label -> IRI, for every existing product/source/metric node - so
    generated inputs/outputs that already exist get linked, not duplicated."""
    lookup = {}
    for subject, label in graph.subject_objects(RDFS.label):
        types = set(graph.objects(subject, RDF.type))
        if any(str(t).startswith(RPS) or str(t).startswith(FREQREC) for t in types):
            lookup[_normalize_label(str(label))] = str(subject)
    return lookup


def _existing_dataset_catalog(graph) -> str:
    """The labels of every dataset-like node (sources of record, products) already
    in the graph. Fed to the LLM so it reuses these exact names for inputs/outputs
    that refer to the same artifact - exact label match is what links a generated
    node to the existing graph instead of minting a disconnected duplicate."""
    labels = set()
    for dataset_type in (PRODUCT, INTERMEDIATE_PRODUCT, FINAL_PRODUCT, SOURCE_OF_RECORD):
        for subject in graph.subjects(RDF.type, dataset_type):
            label = next(graph.objects(subject, RDFS.label), None)
            if label:
                labels.add(str(label))
    if not labels:
        return ""
    listing = "\n".join(f"- {label}" for label in sorted(labels))
    return (
        "Datasets already modeled in this pipeline. If the script reads or writes "
        "one of THESE artifacts, use its name below EXACTLY as written (this is what "
        "links your proposal to the existing graph). Only invent a new name for a "
        "genuinely new artifact:\n" + listing
    )


def _ontology_catalog(graph) -> str:
    classes = []
    for class_iri in sorted(set(graph.subjects(RDF.type, URIRef("http://www.w3.org/2002/07/owl#Class"))), key=str):
        label = next(graph.objects(class_iri, RDFS.label), None)
        comment = next(graph.objects(class_iri, RDFS.comment), None)
        classes.append(f"- {label or class_iri}: {class_iri}" + (f" — {comment}" if comment else ""))
    properties = []
    property_types = {
        URIRef("http://www.w3.org/2002/07/owl#ObjectProperty"),
        URIRef("http://www.w3.org/2002/07/owl#DatatypeProperty"),
    }
    for property_type in property_types:
        for property_iri in graph.subjects(RDF.type, property_type):
            label = next(graph.objects(property_iri, RDFS.label), None)
            domain = next(graph.objects(property_iri, RDFS.domain), None)
            range_ = next(graph.objects(property_iri, RDFS.range), None)
            kind = "object" if str(property_type).endswith("ObjectProperty") else "datatype"
            parts = [f"- {label or property_iri}: {property_iri} ({kind})"]
            if domain:
                parts.append(f"domain {domain}")
            if range_:
                parts.append(f"range {range_}")
            properties.append("; ".join(parts))
    return (
        "Current meta-model ontology catalog. Use these classes and properties; "
        "do not invent a class/relation if a listed one fits.\n\nClasses:\n"
        + ("\n".join(classes) if classes else "- none")
        + "\n\nProperties:\n"
        + ("\n".join(sorted(properties)) if properties else "- none")
    )


def _available_classes(graph) -> set[str]:
    return {str(class_iri) for class_iri in graph.subjects(RDF.type, URIRef("http://www.w3.org/2002/07/owl#Class"))}


def _label(graph, subject) -> str:
    value = next(graph.objects(subject, RDFS.label), None)
    return str(value) if value is not None else str(subject)


def _stage_block(graph, stage) -> str:
    label = next(graph.objects(stage, RDFS.label), "")
    comment = next(graph.objects(stage, RDFS.comment), "")
    inputs = [str(next(graph.objects(o, RDFS.label), o)) for o in graph.objects(stage, HAS_INPUT)]
    outputs = [str(next(graph.objects(o, RDFS.label), o)) for o in graph.objects(stage, HAS_OUTPUT)]
    return f"- label: {label}\n  comment: {comment}\n  inputs: {inputs}\n  outputs: {outputs}"


def _example_stages_block(graph, example_stage_ids: list[str] | None) -> str:
    """Few-shot context: either the specific stage(s) the user picked (in flow
    order, from the Studio's own stage list), or - if none picked - whatever
    stage happens to be first, as a reasonable default."""
    if example_stage_ids:
        stages = [
            URIRef(stage_id) for stage_id in example_stage_ids
            if (URIRef(stage_id), RDF.type, ANALYTICAL_PROCESS) in graph
        ]
    else:
        first = next(graph.subjects(RDF.type, ANALYTICAL_PROCESS), None)
        stages = [first] if first else []
    if not stages:
        return ""
    blocks = "\n".join(_stage_block(graph, stage) for stage in stages)
    return (
        "Example(s) of existing, already-reviewed stage(s) in this same pipeline "
        f"(follow this level of granularity and naming style):\n{blocks}"
    )


def _literal(value: str) -> list[dict]:
    return [{"@value": value}]


def _resource_name_class(item, default_class: URIRef, available_classes: set[str]) -> tuple[str, str]:
    if isinstance(item, dict):
        name = str(item.get("name") or item.get("label") or "").strip()
        class_iri = str(item.get("classIri") or "").strip()
    else:
        name = str(item).strip()
        class_iri = ""
    if not class_iri or class_iri not in available_classes:
        class_iri = str(default_class)
    return name, class_iri


def _render_jsonld(proposals: list[dict], existing: dict[str, str], available_classes: set[str]) -> list[dict]:
    nodes: list[dict] = []

    def resolve_or_create(name: str, class_iri: str) -> str:
        key = _normalize_label(name)
        iri = existing.get(key)
        if iri:
            return iri
        iri = f"{AI_BASE}/{_slug(name)}"
        nodes.append({"@id": iri, "@type": [class_iri], LABEL: _literal(name)})
        existing[key] = iri
        return iri

    stage_iris: list[str] = []
    stage_by_iri: dict[str, dict] = {}
    for proposal in proposals:
        stage_iri = f"{AI_BASE}/{_slug(proposal['label'])}"
        process_class = proposal.get("processClass") if proposal.get("processClass") in available_classes else str(ANALYTICAL_PROCESS)
        stage_node = {
            "@id": stage_iri,
            "@type": [process_class],
            LABEL: _literal(proposal["label"]),
            COMMENT: _literal(proposal.get("comment", "")),
        }
        # Attach the standalone code artifact to the node (executable ontology): the
        # chat now produces code-bearing nodes, and splits a multi-step script into
        # one node per step.
        code = (proposal.get("code") or "").strip()
        if code:
            stage_node[CODE_ARTIFACT] = _literal(code)
            stage_node[CODE_LANGUAGE] = _literal(proposal.get("language") or "python")
            if proposal.get("entrypoint"):
                stage_node[CODE_ENTRYPOINT] = _literal(proposal["entrypoint"])
        input_refs = [resolve_or_create(name, class_iri) for name, class_iri in (_resource_name_class(item, PRODUCT, available_classes) for item in proposal.get("inputs", [])) if name]
        output_refs = [resolve_or_create(name, class_iri) for name, class_iri in (_resource_name_class(item, PRODUCT, available_classes) for item in proposal.get("outputs", [])) if name]
        if input_refs:
            stage_node[str(HAS_INPUT)] = [{"@id": iri} for iri in input_refs]
        if output_refs:
            stage_node[str(HAS_OUTPUT)] = [{"@id": iri} for iri in output_refs]

        metric = proposal.get("metric")
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
            stage_node[str(COMPUTES_METRIC)] = [{"@id": metric_iri}]

        nodes.append(stage_node)
        stage_iris.append(stage_iri)
        stage_by_iri[stage_iri] = stage_node

    # When a script was split into several steps, chain them in flow order so they
    # render as a connected pipeline (same relation the rest of the app uses). Only
    # add a link when the steps don't already connect through a shared product.
    for upstream, downstream in zip(stage_iris, stage_iris[1:]):
        node = stage_by_iri[upstream]
        outs = {ref["@id"] for ref in node.get(str(HAS_OUTPUT), [])}
        ins = {ref["@id"] for ref in stage_by_iri[downstream].get(str(HAS_INPUT), [])}
        if not (outs & ins):
            node.setdefault(str(IS_INTERMEDIATE_TO), []).append({"@id": downstream})
    return nodes


def clarify_kg_request(scripts: list[dict], instructions: str | None, provider: str | None = None, model: str | None = None, model_code: str | None = None) -> dict:
    """Ask only for clarifications that materially affect ontology mapping.

    The UI can then append the user's answers to the instructions and call the
    normal generation endpoint. This keeps generated RDF review-only until the
    user explicitly approves it in Playground.
    """
    if not scripts and not (instructions or "").strip():
        return {
            "ready": False,
            "questions": [{"question": "What process should this pipeline represent? You can describe the steps, paste code, upload files, or combine those.", "options": []}],
            "normalizedInstructions": instructions or "",
        }
    graph = construct(ALL_TRIPLES)
    ontology = _ontology_catalog(graph)
    script_list = "\n".join(f"- {script['filename']} ({len(script.get('source', ''))} characters)" for script in scripts) or "none"
    result = call_structured(
        system=(
            "You decide whether an RDF pipeline generation request has enough "
            "information to map resources to the existing meta-model ontology. "
            "Ask clarifying questions only when missing details would materially "
            "change classes, process boundaries, inputs, outputs, or important "
            "properties. If code or description is sufficient, return ready true."
            "When there are plausible ontology class/property choices, include "
            "2-5 concrete option strings so the user can choose instead of typing "
            "from scratch. The user may also answer with different instructions."
        ),
        user_content=(
            f"User instructions:\n{instructions or ''}\n\n"
            f"{ontology}\n\n"
            f"Uploaded files:\n{script_list}\n\n"
            "Return at most 4 concise questions. Include options when the catalog "
            "has likely choices. If ready, questions must be empty "
            "and normalizedInstructions should preserve the user's intent plus any "
            "clear mapping constraints."
        ),
        tool_name="report_pipeline_clarifications",
        tool_description="Report whether pipeline generation can proceed or needs clarification.",
        tool_schema=CLARIFY_TOOL_SCHEMA,
        max_tokens=2000,
        provider=provider,
        model=model,
        model_code=model_code,
    )
    questions = []
    for item in result.get("questions", []):
        if isinstance(item, dict):
            question = str(item.get("question", "")).strip()
            options = [str(option).strip() for option in item.get("options", []) if str(option).strip()]
        else:
            question = str(item).strip()
            options = []
        if question:
            questions.append({"question": question, "options": options[:5]})
    ready = bool(result.get("ready")) or not questions
    return {
        "ready": ready,
        "questions": [] if ready else questions[:4],
        "normalizedInstructions": result.get("normalizedInstructions") or instructions or "",
    }


def generate_kg_from_code(scripts: list[dict], instructions: str | None, example_stage_ids: list[str] | None = None, provider: str | None = None, model: str | None = None, model_code: str | None = None, current_jsonld: list[dict] | None = None) -> dict:
    """scripts: [{"filename": str, "source": str}, ...] - uploaded by the user for
    this single request. Nothing is read from or persisted to disk.

    Either scripts or example_stage_ids (or both) must be given:
    - scripts (with example_stage_ids optionally guiding style) - "new production":
      model genuinely new code.
    - example_stage_ids alone, no scripts - "reproducibility": regenerate a
      proposal for the selected stage(s) purely from their own existing RDF
      description, as a check on whether an independent read of the model's own
      metadata reproduces a similar representation.
    """
    if not scripts and not example_stage_ids and not current_jsonld and not (instructions or "").strip():
        raise ValueError("Provide at least one script, description, or selected stage to reproduce.")
    graph = construct(ALL_TRIPLES)
    existing = _existing_products(graph)
    catalog = _existing_dataset_catalog(graph)
    ontology = _ontology_catalog(graph)
    available_classes = _available_classes(graph)

    if current_jsonld:
        example = _example_stages_block(graph, example_stage_ids)
        sources = "\n\n".join(f"### {script['filename']}\n```text\n{script['source']}\n```" for script in scripts) if scripts else "No additional files were provided."
        mode_note = (
            "Revise the current draft JSON-LD according to the requested change. "
            "Return a full replacement proposal, not a patch. Preserve correct "
            "ontology classes and existing good mappings unless the user explicitly "
            "asked to change them.\n\n"
            f"Current draft JSON-LD:\n{json.dumps(current_jsonld, indent=2)}\n\n"
        )
        source_kind = "Additional source material"
    elif scripts:
        example = _example_stages_block(graph, example_stage_ids)
        sources = "\n\n".join(f"### {script['filename']}\n```text\n{script['source']}\n```" for script in scripts)
        mode_note = ""
        source_kind = "Scripts"
    elif (instructions or "").strip():
        example = _example_stages_block(graph, example_stage_ids)
        sources = instructions or ""
        mode_note = (
            "No code files were provided. Model the pipeline from the user's process "
            "description. Ask for no further clarification here; use conservative "
            "process boundaries and only create resources that the description supports.\n\n"
        )
        source_kind = "Process description"
    else:
        stages = [
            URIRef(stage_id) for stage_id in example_stage_ids
            if (URIRef(stage_id), RDF.type, ANALYTICAL_PROCESS) in graph
        ]
        if not stages:
            raise ValueError("None of the selected stages exist in the current graph.")
        example = ""
        sources = "\n\n".join(f"### {_label(graph, stage)}\n{_stage_block(graph, stage)}" for stage in stages)
        mode_note = (
            "No new code was provided - reproduce a proposal for the stage(s) below "
            "purely from their existing RDF description (label, comment, inputs, "
            "outputs). This checks whether an independent read of the model's own "
            "description yields a similar representation.\n\n"
        )
        source_kind = "Stages"

    user_content = f"{mode_note}{instructions or DEFAULT_INSTRUCTIONS}\n\n{ontology}\n\n{catalog}\n\n{example}\n\n{source_kind} to model:\n\n{sources}"

    result = call_structured(
        system=(
            "You read pipeline scripts (or, when no code is given, an existing stage's "
            "own RDF description) and propose ontology-conformant lineage nodes, each "
            "carrying a standalone code artifact implementing that node's logic. Split a "
            "multi-step script into one node per step. Be conservative: only claim an "
            "input/output/metric the source material actually shows. Choose processClass "
            "and input/output classIri from the provided ontology catalog when possible. "
            "Code must be logic only (no file paths or I/O) so it can be reused later."
        ),
        user_content=user_content,
        tool_name="report_pipeline_proposals",
        tool_description="Propose one pipeline node per pipeline step, each with its code.",
        tool_schema=GENERATE_TOOL_SCHEMA,
        max_tokens=8000,
        provider=provider,
        model=model,
        model_code=model_code,
    )
    proposals = result.get("proposals", [])
    nodes = _render_jsonld(proposals, existing, available_classes)
    return {"proposals": proposals, "jsonld": nodes}
