from pathlib import Path

from pyshacl import validate
from rdflib import Graph, Namespace, RDF, RDFS

ROOT = Path(__file__).parent.parent
RPS = Namespace("https://w3id.org/rdf-pipeline-studio#")


def run_validation(graph: Graph) -> bool:
    shapes = Graph().parse(ROOT / "data" / "shapes.ttl", format="turtle")
    return bool(validate(graph, shacl_graph=shapes, inference="rdfs")[0])


def test_seed_conforms():
    assert run_validation(Graph().parse(ROOT / "data" / "seed.ttl", format="turtle"))


def test_stage_requires_output():
    graph = Graph()
    graph.add((Namespace("https://example.org/").stage, RDF.type, RPS.analyticalProcess))
    assert not run_validation(graph)


def test_product_requires_label():
    graph = Graph()
    graph.add((Namespace("https://example.org/").product, RDF.type, RPS.product))
    assert not run_validation(graph)
