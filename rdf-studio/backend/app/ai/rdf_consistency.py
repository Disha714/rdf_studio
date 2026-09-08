"""Pure RDF-graph consistency checks - no LLM, no filesystem, no code access.

Catches real authoring mistakes (dangling references, orphan products, missing
metadata, dependency cycles) using nothing but the pipeline graph already loaded
in Fuseki. The rps: (hasInput/hasOutput/computesMetric/analyticalProcess/product)
vocabulary is the Studio's own stable pipeline-linking vocabulary; formula/unit/
groundedIn/Metric are the freqrec ontology's own extension properties, same
namespaces already used in verify.py and modify.py.
"""
from rdflib import Graph, RDF, RDFS, URIRef

RPS = "https://w3id.org/rdf-pipeline-studio#"
FREQREC = "https://bmtc.datakaveri.org/freqrec#"

ANALYTICAL_PROCESS = URIRef(f"{RPS}analyticalProcess")
PRODUCT = URIRef(f"{RPS}product")
INTERMEDIATE_PRODUCT = URIRef(f"{RPS}intermediateProduct")
FINAL_PRODUCT = URIRef(f"{RPS}finalProduct")
HAS_INPUT = URIRef(f"{RPS}hasInput")
HAS_OUTPUT = URIRef(f"{RPS}hasOutput")
COMPUTES_METRIC = URIRef(f"{RPS}computesMetric")
METRIC_CLASS = URIRef(f"{FREQREC}Metric")
FORMULA = URIRef(f"{FREQREC}formula")
UNIT = URIRef(f"{FREQREC}unit")
GROUNDED_IN = URIRef(f"{FREQREC}groundedIn")

PRODUCT_TYPES = (PRODUCT, INTERMEDIATE_PRODUCT, FINAL_PRODUCT)
LINEAGE_PREDICATES = (HAS_INPUT, HAS_OUTPUT, COMPUTES_METRIC)


def _label(graph: Graph, subject) -> str:
    value = next(graph.objects(subject, RDFS.label), None)
    return str(value) if value is not None else str(subject)


def _has_nonempty(graph: Graph, subject, predicate) -> bool:
    value = next(graph.objects(subject, predicate), None)
    return value is not None and str(value).strip() != ""


def _detect_cycles(edges: dict) -> set:
    """Nodes that participate in a dependency cycle (their output eventually
    feeds back into one of their own inputs), via a standard grey/black DFS."""
    on_stack: set = set()
    done: set = set()
    cyclic: set = set()

    def visit(node):
        if node in done:
            return
        on_stack.add(node)
        for neighbor in edges.get(node, ()):
            if neighbor in on_stack:
                cyclic.add(node)
                cyclic.add(neighbor)
            else:
                visit(neighbor)
        on_stack.discard(node)
        done.add(node)

    for node in list(edges):
        visit(node)
    return cyclic


def check_pipeline_graph(graph: Graph) -> list[dict]:
    issues: list[dict] = []

    def flag(severity: str, subject, message: str) -> None:
        issues.append({"severity": severity, "subject": str(subject), "subjectLabel": _label(graph, subject), "message": message})

    declared = {subject for subject, _ in graph.subject_objects(RDF.type)}

    for predicate in LINEAGE_PREDICATES:
        for subject, obj in graph.subject_objects(predicate):
            if isinstance(obj, URIRef) and obj not in declared:
                flag("error", subject, f"{predicate.split('#')[-1]} points to {obj}, which has no rdf:type in the graph (dangling reference).")

    producers = {obj for _, obj in graph.subject_objects(HAS_OUTPUT)}
    consumers = {obj for _, obj in graph.subject_objects(HAS_INPUT)}
    for product_type in PRODUCT_TYPES:
        for product in graph.subjects(RDF.type, product_type):
            if product not in producers:
                flag("warning", product, "No stage produces this (nothing has hasOutput pointing to it).")
    for intermediate in graph.subjects(RDF.type, INTERMEDIATE_PRODUCT):
        if intermediate not in consumers:
            flag("warning", intermediate, "No stage consumes this intermediate product - consider marking it a finalProduct if that's intentional.")

    for stage in graph.subjects(RDF.type, ANALYTICAL_PROCESS):
        if not _has_nonempty(graph, stage, RDFS.label):
            flag("error", stage, "Stage has no rdfs:label.")
        if not _has_nonempty(graph, stage, RDFS.comment):
            flag("warning", stage, "Stage has no rdfs:comment describing what it does.")
        if not any(graph.objects(stage, HAS_OUTPUT)):
            flag("warning", stage, "Stage declares no hasOutput - it produces nothing.")

    used_metrics = {obj for _, obj in graph.subject_objects(COMPUTES_METRIC)}
    for metric in graph.subjects(RDF.type, METRIC_CLASS):
        for predicate, name in ((FORMULA, "formula"), (UNIT, "unit"), (GROUNDED_IN, "groundedIn")):
            if not _has_nonempty(graph, metric, predicate):
                flag("warning", metric, f"Metric is missing its {name}.")
        if metric not in used_metrics:
            flag("warning", metric, "Metric is defined but no stage computes it (no computesMetric link).")

    stage_edges: dict = {stage: set() for stage in graph.subjects(RDF.type, ANALYTICAL_PROCESS)}
    for output_stage, product in graph.subject_objects(HAS_OUTPUT):
        if output_stage not in stage_edges:
            continue
        for input_stage in graph.subjects(HAS_INPUT, product):
            stage_edges[output_stage].add(input_stage)
    for stage in _detect_cycles(stage_edges):
        flag("error", stage, "This stage participates in a dependency cycle (its outputs eventually feed back into its own inputs).")

    return issues
