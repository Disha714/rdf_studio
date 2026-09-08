import asyncio
from rdflib import Graph
from app.main import parse_rdf_upload, extract_ontology_graph

with open('/home/disha/iisc/knowledgebase/policy_builder_ontology.ttl', 'rb') as f:
    raw = f.read()

print("Parsing RDF...")
graph = parse_rdf_upload(raw, 'policy_builder_ontology.ttl', allow_json_ld=True)
print(f"Graph parsed, size: {len(graph)}")

print("Extracting ontology graph...")
ontology_graph, classes, properties, _ = extract_ontology_graph(graph, set(), set())
print(f"Ontology extracted, size: {len(ontology_graph)}")
print(f"Classes: {len(classes)}, Properties: {len(properties)}")
