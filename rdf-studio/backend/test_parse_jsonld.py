import asyncio
from rdflib import Graph
from app.main import parse_rdf_upload, extract_ontology_graph

with open('/home/disha/iisc/knowledgebase/policy_builder_ontology.jsonld', 'rb') as f:
    raw = f.read()

print("Parsing RDF...")
graph = parse_rdf_upload(raw, 'policy_builder_ontology.jsonld', allow_json_ld=True)
print(f"Graph parsed, size: {len(graph)}")
