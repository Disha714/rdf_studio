from typing import Any

import requests
from rdflib import Graph
from SPARQLWrapper import BASIC, JSON, POST, SPARQLWrapper

from .config import FUSEKI_PASSWORD, FUSEKI_READ_TIMEOUT, FUSEKI_URL, FUSEKI_USER

AUTH = (FUSEKI_USER, FUSEKI_PASSWORD)
TIMEOUT = (10, FUSEKI_READ_TIMEOUT)


def query_json(query: str) -> dict[str, Any]:
    client = SPARQLWrapper(f"{FUSEKI_URL}/query")
    client.setHTTPAuth(BASIC)
    client.setCredentials(FUSEKI_USER, FUSEKI_PASSWORD)
    client.setQuery(query)
    client.setReturnFormat(JSON)
    return client.query().convert()


def construct(query: str) -> Graph:
    response = requests.post(
        f"{FUSEKI_URL}/query",
        data={"query": query},
        headers={"Accept": "text/turtle"},
        auth=AUTH,
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    graph = Graph()
    graph.parse(data=response.text, format="turtle")
    return graph


def update(sparql: str) -> None:
    response = requests.post(
        f"{FUSEKI_URL}/update",
        data={"update": sparql},
        auth=AUTH,
        timeout=TIMEOUT,
    )
    response.raise_for_status()


def upload(graph: Graph) -> int:
    payload = graph.serialize(format="nt")
    response = requests.post(
        f"{FUSEKI_URL}/data?default",
        data=payload.encode(),
        headers={"Content-Type": "application/n-triples"},
        auth=AUTH,
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    return len(graph)


def initialize_seed() -> None:
    update("""
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        PREFIX rps: <https://w3id.org/rdf-pipeline-studio#>
        INSERT DATA {
          rps:canvasX a owl:DatatypeProperty ; rdfs:label "canvas X position" .
          rps:canvasY a owl:DatatypeProperty ; rdfs:label "canvas Y position" .
          rps:sourceHandle a owl:DatatypeProperty ; rdfs:label "source connection point" .
          rps:targetHandle a owl:DatatypeProperty ; rdfs:label "target connection point" .
          rps:required a owl:DatatypeProperty ; rdfs:label "attribute is required" .
          rps:multiple a owl:DatatypeProperty ; rdfs:label "attribute allows multiple values" .
          rps:cardinality a owl:DatatypeProperty ; rdfs:label "relationship cardinality" .
          rps:globalRelationship a owl:DatatypeProperty ; rdfs:label "reusable class relationship" .
          rps:resourceDomain a owl:ObjectProperty ; rdfs:label "resource-specific property owner" .
          rps:hasInput a owl:ObjectProperty ; rdfs:label "has input" .
          rps:hasOutput a owl:ObjectProperty ; rdfs:label "has output" .
          rps:computesMetric a owl:ObjectProperty ; rdfs:label "computes metric" .
        }
    """)
