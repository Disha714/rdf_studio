import json
from pathlib import Path

from rdflib import Graph, Literal, RDF, RDFS, URIRef
from rdflib.namespace import OWL

from app.main import CLEAN_EXPORT_TRIPLES, ONTOLOGY_TRIPLES, RPS, build_pipeline_document, extract_ontology_graph, extract_pipeline_graph, parse_pipeline_json

ROOT = Path(__file__).parent.parent


def test_pipeline_json_is_derived_from_rdf():
    graph = Graph().parse(ROOT / "data" / "seed.ttl", format="turtle")
    document = build_pipeline_document(graph)
    assert document["format"] == "rdf-pipeline-studio"
    assert document["nodes"] == []
    assert document["edges"] == []
    assert list(graph.subjects(RDF.type, OWL.Class)) == []
    object_properties = {str(subject) for subject in graph.subjects(RDF.type, OWL.ObjectProperty)}
    assert any(value.endswith("hasInput") for value in object_properties)
    assert any(value.endswith("hasOutput") for value in object_properties)


def test_pipeline_json_excludes_canvas_layout_metadata():
    graph = Graph().parse(ROOT / "data" / "seed.ttl", format="turtle")
    resource_class = URIRef("https://example.org/ontology#CustomClass")
    orders = URIRef("https://example.org/pipeline/orders")
    graph.add((resource_class, RDF.type, OWL.Class))
    graph.add((orders, RDF.type, resource_class))
    graph.add((orders, RDFS.label, Literal("Orders")))
    graph.add((orders, URIRef("https://w3id.org/rdf-pipeline-studio#canvasX"), Literal("123.45")))
    document = build_pipeline_document(graph)
    orders = next(node for node in document["nodes"] if node["id"].endswith("orders"))
    assert all(not prop["predicate"].endswith(("canvasX", "canvasY")) for prop in orders["properties"])


def test_pipeline_json_round_trips_layout_and_edge_handles():
    graph = Graph().parse(ROOT / "data" / "seed.ttl", format="turtle")
    resource_class = URIRef("https://example.org/ontology#CustomClass")
    upstream = URIRef("https://example.org/pipeline/upstream")
    downstream = URIRef("https://example.org/pipeline/downstream")
    relation = URIRef("https://w3id.org/rdf-pipeline-studio#hasInput")
    graph.add((resource_class, RDF.type, OWL.Class))
    graph.add((upstream, RDF.type, resource_class))
    graph.add((downstream, RDF.type, resource_class))
    graph.add((upstream, URIRef(f"{RPS}canvasX"), Literal("25")))
    graph.add((upstream, URIRef(f"{RPS}canvasY"), Literal("75")))
    graph.add((upstream, relation, downstream))
    statement = URIRef("https://example.org/pipeline/statement")
    graph.add((statement, RDF.type, RDF.Statement))
    graph.add((statement, RDF.subject, upstream))
    graph.add((statement, RDF.predicate, relation))
    graph.add((statement, RDF.object, downstream))
    graph.add((statement, URIRef(f"{RPS}sourceHandle"), Literal("bottom")))
    graph.add((statement, URIRef(f"{RPS}targetHandle"), Literal("left")))

    document = build_pipeline_document(graph)
    upstream_node = next(node for node in document["nodes"] if node["id"] == str(upstream))
    edge = next(edge for edge in document["edges"] if edge["source"] == str(upstream))
    assert upstream_node["position"] == {"x": 25.0, "y": 75.0}
    assert edge["sourceHandle"] == "bottom"
    assert edge["targetHandle"] == "left"

    parsed = parse_pipeline_json(json.dumps(document).encode(), {resource_class})
    assert (upstream, URIRef(f"{RPS}canvasX"), Literal("25.0")) in parsed
    assert (upstream, relation, downstream) in parsed
    parsed_statement = next(parsed.subjects(RDF.subject, upstream))
    assert (parsed_statement, URIRef(f"{RPS}sourceHandle"), Literal("bottom")) in parsed


def test_clean_rdf_export_excludes_unrelated_and_ui_data():
    graph = Graph().parse(ROOT / "data" / "seed.ttl", format="turtle")
    graph.parse(data='@prefix foreign: <https://example.org/foreign/> . foreign:item foreign:value 80 .', format="turtle")
    resource_class = URIRef("https://example.org/ontology#CustomClass")
    orders = URIRef("https://example.org/pipeline/orders")
    graph.add((resource_class, RDF.type, OWL.Class))
    graph.add((orders, RDF.type, resource_class))
    graph.add((orders, URIRef("https://w3id.org/rdf-pipeline-studio#canvasX"), Literal("123.45")))
    clean = Graph()
    for triple in graph.query(CLEAN_EXPORT_TRIPLES):
        clean.add(triple)
    assert not any("foreign" in str(term) for triple in clean for term in triple)
    assert not any(str(predicate).endswith(("canvasX", "canvasY")) for _, predicate, _ in clean)
    assert any(str(subject).endswith("orders") for subject in clean.subjects())


def test_ontology_import_extracts_ontology_from_mixed_dataset():
    graph = Graph().parse(ROOT.parent / "sample_outputs" / "rdf-pipeline-dataset.jsonld")
    ontology_graph, classes, properties, ignored_resources = extract_ontology_graph(graph)
    assert classes
    assert properties
    assert len(ignored_resources) == 0
    assert not any(subject in ignored_resources for subject in ontology_graph.subjects())
    assert not any(str(subject).startswith("https://example.org/pipeline/") for subject in ontology_graph.subjects())
    assert not any((predicate == URIRef(f"{RPS}resourceDomain")) for _, predicate, _ in ontology_graph)


def test_ontology_export_excludes_pipeline_resources():
    graph = Graph().parse(ROOT.parent / "sample_outputs" / "rdf-pipeline-dataset.jsonld")
    ontology = Graph()
    for triple in graph.query(ONTOLOGY_TRIPLES):
        ontology.add(triple)
    assert len(ontology) > 0
    assert not any(str(subject).startswith("https://example.org/pipeline/") for subject in ontology.subjects())
    assert not any(str(value).startswith("https://example.org/pipeline/") for _, _, value in ontology)


def test_mixed_dataset_extracts_pipeline_resources_for_canvas():
    ontology = Graph().parse(ROOT.parent / "sample_outputs" / "rdf-pipeline-dataset.jsonld")
    pipeline = Graph().parse(ROOT.parent / "sample_outputs" / "pipeline.jsonld")
    _, classes, _, _ = extract_ontology_graph(ontology)
    pipeline_graph, resources = extract_pipeline_graph(pipeline, classes)
    assert len(resources) == 5
    assert any(str(subject).endswith("/JourneyPlanner") for subject in resources)
    assert any(str(subject).endswith("/JourneyPlanner") and str(predicate).endswith("hasInput") for subject, predicate, _ in pipeline_graph)
    assert any(str(subject).endswith("#latitude") for subject in pipeline_graph.subjects())
    assert not any((subject, RDF.type, OWL.Class) in pipeline_graph for subject in resources)


def test_instance_only_rdf_infers_ontology_and_pipeline_resources():
    graph = Graph().parse(data="""
        @prefix ax: <https://example.org/analytics-meta#> .
        @prefix fr: <https://bmtc.datakaveri.org/freqrec#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

        fr:Stage1 a ax:AnalyticStage ;
          rdfs:label "Build Service Timetable Model" ;
          ax:stageOrder 1 .

        fr:TicketingRecords a ax:SourceOfRecord ;
          rdfs:label "Ticketing Records" .
    """, format="turtle")
    ontology_graph, classes, properties, resources = extract_ontology_graph(graph)
    assert URIRef("https://example.org/analytics-meta#AnalyticStage") in classes
    assert URIRef("https://example.org/analytics-meta#SourceOfRecord") in classes
    assert URIRef("https://example.org/analytics-meta#stageOrder") in properties
    assert (URIRef("https://example.org/analytics-meta#AnalyticStage"), RDF.type, OWL.Class) in ontology_graph
    assert (URIRef("https://example.org/analytics-meta#stageOrder"), RDF.type, OWL.DatatypeProperty) in ontology_graph
    assert len(resources) > 0

    pipeline_graph, pipeline_resources = extract_pipeline_graph(graph, classes)
    assert pipeline_resources == resources
    assert any(str(subject).endswith("#Stage1") for subject in pipeline_resources)
    assert any(str(predicate).endswith("stageOrder") for _, predicate, _ in pipeline_graph)


def test_reject_remote_context_pointing_at_private_address():
    from fastapi import HTTPException
    from app.main import _paste_graph

    doc = {"@context": "http://169.254.169.254/latest/meta-data/", "@type": "Person", "name": "Disha"}
    try:
        _paste_graph(json.dumps(doc))
        assert False, "expected HTTPException for @context resolving to a private address"
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "private/internal address" in exc.detail


def test_reject_remote_context_pointing_at_loopback():
    from fastapi import HTTPException
    from app.main import _paste_graph

    doc = {"@context": "http://127.0.0.1:9999/ctx.jsonld", "@type": "Person"}
    try:
        _paste_graph(json.dumps(doc))
        assert False, "expected HTTPException for @context resolving to loopback"
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "private/internal address" in exc.detail


def test_accepts_legitimate_remote_context():
    from unittest import mock
    from app.main import _paste_graph, _REMOTE_CONTEXT_CACHE

    _REMOTE_CONTEXT_CACHE.clear()
    fake_context_doc = {"@context": {"name": "http://schema.org/name", "Person": "http://schema.org/Person"}}

    class FakeResp:
        status_code = 200
        is_redirect = False
        headers: dict = {}

        def iter_content(self, chunk_size=8192):
            yield json.dumps(fake_context_doc).encode()

        def close(self):
            pass

    with mock.patch("requests.get", return_value=FakeResp()):
        doc = {"@context": "https://example.com/context.jsonld", "@type": "Person", "name": "Disha"}
        graph = _paste_graph(json.dumps(doc))
    triples = list(graph)
    assert len(triples) == 2
    assert any(str(o) == "Disha" for _, _, o in triples)


def test_remote_context_redirect_to_private_address_is_blocked():
    from fastapi import HTTPException
    from unittest import mock
    from app.main import _fetch_remote_context, _REMOTE_CONTEXT_CACHE

    _REMOTE_CONTEXT_CACHE.clear()

    class RedirectResp:
        status_code = 302
        is_redirect = True
        headers = {"Location": "http://169.254.169.254/evil"}

        def iter_content(self, chunk_size=8192):
            return iter([])

        def close(self):
            pass

    with mock.patch("requests.get", return_value=RedirectResp()):
        try:
            _fetch_remote_context("https://example.com/redirector")
            assert False, "expected redirect target to be validated and blocked"
        except HTTPException as exc:
            assert exc.status_code == 400
            assert "private/internal address" in exc.detail


def test_remote_context_size_cap_enforced():
    from fastapi import HTTPException
    from unittest import mock
    from app.main import _fetch_remote_context, _REMOTE_CONTEXT_CACHE

    _REMOTE_CONTEXT_CACHE.clear()

    class HugeResp:
        status_code = 200
        is_redirect = False
        headers: dict = {}

        def iter_content(self, chunk_size=8192):
            for _ in range(200):
                yield b"0" * 8192

        def close(self):
            pass

    with mock.patch("requests.get", return_value=HugeResp()):
        try:
            _fetch_remote_context("https://example.com/huge.jsonld")
            assert False, "expected size cap to be enforced"
        except HTTPException as exc:
            assert exc.status_code == 413


def test_serialized_graph_response_nquads_default_graph():
    from app.main import serialized_graph_response

    graph = Graph()
    graph.add((URIRef("https://example.org/s"), URIRef("https://example.org/p"), Literal("hello")))

    resp = serialized_graph_response(graph, "nquads", "pipeline")
    body = resp.body.decode("utf-8") if isinstance(resp.body, bytes) else str(resp.body)

    assert resp.media_type == "application/n-quads"
    assert "urn:x-rdflib:default" not in body
    assert '<https://example.org/s> <https://example.org/p> "hello" .' in body


