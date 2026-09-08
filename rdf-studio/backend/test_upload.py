import asyncio
from rdflib import Graph
from app.main import parse_rdf_upload, extract_ontology_graph
from app.store import upload, update

with open('/home/disha/iisc/knowledgebase/policy_builder_ontology.ttl', 'rb') as f:
    raw = f.read()

print("Parsing RDF...")
graph = parse_rdf_upload(raw, 'policy_builder_ontology.ttl', allow_json_ld=False)

print("Extracting ontology graph...")
ontology_graph, classes, properties, _ = extract_ontology_graph(graph, set(), set())

print("Clearing Fuseki...")
update("CLEAR ALL")

print("Uploading ontology...")
upload(ontology_graph)
print("Upload successful!")
