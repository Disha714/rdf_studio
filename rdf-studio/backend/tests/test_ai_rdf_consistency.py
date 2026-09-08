from rdflib import Graph, Literal, RDF, RDFS, URIRef

from app.ai import rdf_consistency as rc

NS = "https://example.org/pipeline/"


def stage(graph, iri, label="Stage", comment="Does a thing.", inputs=(), outputs=(), metrics=()):
    subject = URIRef(iri)
    graph.add((subject, RDF.type, rc.ANALYTICAL_PROCESS))
    if label is not None:
        graph.add((subject, RDFS.label, Literal(label)))
    if comment is not None:
        graph.add((subject, RDFS.comment, Literal(comment)))
    for value in inputs:
        graph.add((subject, rc.HAS_INPUT, URIRef(value)))
    for value in outputs:
        graph.add((subject, rc.HAS_OUTPUT, URIRef(value)))
    for value in metrics:
        graph.add((subject, rc.COMPUTES_METRIC, URIRef(value)))
    return subject


def product(graph, iri, kind=None, label="Product"):
    subject = URIRef(iri)
    graph.add((subject, RDF.type, kind or rc.PRODUCT))
    graph.add((subject, RDFS.label, Literal(label)))
    return subject


def metric(graph, iri, formula="a / b", unit="unit", grounded_in="Source", label="Metric"):
    subject = URIRef(iri)
    graph.add((subject, RDF.type, rc.METRIC_CLASS))
    graph.add((subject, RDFS.label, Literal(label)))
    if formula is not None:
        graph.add((subject, rc.FORMULA, Literal(formula)))
    if unit is not None:
        graph.add((subject, rc.UNIT, Literal(unit)))
    if grounded_in is not None:
        graph.add((subject, rc.GROUNDED_IN, Literal(grounded_in)))
    return subject


def messages(issues, severity=None):
    return [item["message"] for item in issues if severity is None or item["severity"] == severity]


def test_clean_graph_has_no_issues():
    graph = Graph()
    out = product(graph, f"{NS}out", kind=rc.FINAL_PRODUCT)
    stage(graph, f"{NS}s1", outputs=[str(out)])
    assert rc.check_pipeline_graph(graph) == []


def test_dangling_reference_is_flagged():
    graph = Graph()
    stage(graph, f"{NS}s1", inputs=[f"{NS}nowhere"])
    issues = rc.check_pipeline_graph(graph)
    assert any("dangling reference" in message for message in messages(issues, "error"))


def test_product_with_no_producer_is_flagged():
    graph = Graph()
    product(graph, f"{NS}orphan", kind=rc.FINAL_PRODUCT)
    issues = rc.check_pipeline_graph(graph)
    assert any("no stage produces this" in message.lower() for message in messages(issues, "warning"))


def test_intermediate_product_with_no_consumer_is_flagged():
    graph = Graph()
    intermediate = product(graph, f"{NS}mid", kind=rc.INTERMEDIATE_PRODUCT)
    stage(graph, f"{NS}s1", outputs=[str(intermediate)])
    issues = rc.check_pipeline_graph(graph)
    assert any("no stage consumes" in message.lower() for message in messages(issues, "warning"))


def test_intermediate_product_with_consumer_is_not_flagged():
    graph = Graph()
    intermediate = product(graph, f"{NS}mid", kind=rc.INTERMEDIATE_PRODUCT)
    stage(graph, f"{NS}s1", outputs=[str(intermediate)])
    stage(graph, f"{NS}s2", inputs=[str(intermediate)])
    issues = rc.check_pipeline_graph(graph)
    assert not any("no stage consumes" in message.lower() for message in messages(issues))


def test_stage_missing_label_and_comment_is_flagged():
    graph = Graph()
    stage(graph, f"{NS}s1", label=None, comment=None)
    issues = rc.check_pipeline_graph(graph)
    assert any("no rdfs:label" in message for message in messages(issues, "error"))
    assert any("no rdfs:comment" in message for message in messages(issues, "warning"))


def test_stage_with_no_output_is_flagged():
    graph = Graph()
    stage(graph, f"{NS}s1")
    issues = rc.check_pipeline_graph(graph)
    assert any("produces nothing" in message for message in messages(issues, "warning"))


def test_metric_missing_formula_is_flagged():
    graph = Graph()
    m = metric(graph, f"{NS}m1", formula=None)
    stage(graph, f"{NS}s1", metrics=[str(m)], outputs=[f"{NS}out"])
    product(graph, f"{NS}out", kind=rc.FINAL_PRODUCT)
    issues = rc.check_pipeline_graph(graph)
    assert any("missing its formula" in message for message in messages(issues, "warning"))


def test_metric_not_computed_by_any_stage_is_flagged():
    graph = Graph()
    metric(graph, f"{NS}m1")
    issues = rc.check_pipeline_graph(graph)
    assert any("no stage computes it" in message for message in messages(issues, "warning"))


def test_dependency_cycle_is_flagged():
    graph = Graph()
    a_out = product(graph, f"{NS}a_out", kind=rc.INTERMEDIATE_PRODUCT)
    b_out = product(graph, f"{NS}b_out", kind=rc.INTERMEDIATE_PRODUCT)
    stage(graph, f"{NS}a", inputs=[str(b_out)], outputs=[str(a_out)])
    stage(graph, f"{NS}b", inputs=[str(a_out)], outputs=[str(b_out)])
    issues = rc.check_pipeline_graph(graph)
    assert any("dependency cycle" in message for message in messages(issues, "error"))


def test_acyclic_chain_is_not_flagged_as_cycle():
    graph = Graph()
    mid = product(graph, f"{NS}mid", kind=rc.INTERMEDIATE_PRODUCT)
    final = product(graph, f"{NS}final", kind=rc.FINAL_PRODUCT)
    stage(graph, f"{NS}a", outputs=[str(mid)])
    stage(graph, f"{NS}b", inputs=[str(mid)], outputs=[str(final)])
    issues = rc.check_pipeline_graph(graph)
    assert not any("dependency cycle" in message for message in messages(issues))
