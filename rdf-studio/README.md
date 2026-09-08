# RDF Ontology Studio

An open-source, RDF-native workbench for modeling analytical lineage. Fuseki is the only persistence layer: the editors query RDF and write SPARQL updates; no pipeline JSON is stored.

## Stack

- Vite, React, TypeScript, React Flow, Cytoscape.js, Monaco, TanStack Query
- FastAPI, RDFLib, PySHACL, SPARQLWrapper
- Apache Jena Fuseki-compatible server in Docker Compose

## Start with Docker

Requirements: Docker Engine with Compose v2.

```bash
cd rdf-pipeline-studio
cp .env.example .env
docker compose up --build
```

Open the studio at <http://localhost:5173>. FastAPI documentation is at <http://localhost:8000/docs>, and Fuseki is at <http://localhost:3030> (user `admin`, password from `.env`). On the first empty-dataset startup, the backend loads `backend/data/seed.ttl`. The named Docker volume keeps all subsequent RDF changes.

To reset the dataset and reload the seed:

```bash
docker compose down -v
docker compose up --build
```

## Local development

Start Fuseki with `docker compose up fuseki`, then run:

```bash
cd backend
uv venv
source .venv/bin/activate
uv pip install -r requirements.txt
uvicorn app.main:app --reload
```

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

Set `VITE_API_URL` to override the frontend API URL, or `FUSEKI_URL`, `FUSEKI_USER`, and `FUSEKI_PASSWORD` for the backend.

## Example workflow

1. Open **Ontology** and create the classes required by your domain. No application classes are seeded.
2. Add class Properties. A Property type can be an XSD datatype or any class already defined in the ontology.
3. Open **Pipeline**, create resources using your classes, then choose `has input`, `has output`, or a reusable relation you create while linking resources.
4. Use the Pipeline resource modal or selected-resource linking modal to assign relationships between actual resources.
5. Open **SPARQL** or **Validate** to inspect and validate the generated RDF.
6. Use **Import** to merge or replace RDF. **Export** can generate pipeline JSON, ontology-only RDF, or a clean RDF dataset without internal canvas metadata.

Example update:

```sparql
PREFIX rps: <https://w3id.org/rdf-pipeline-studio#>
INSERT DATA {
  <https://example.org/pipeline/newStage> rps:hasOutput
    <https://example.org/pipeline/dailySales> .
}
```

## API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/rdf/import` | Import RDF; optional `?replace=true` |
| `GET /api/rdf/export?format=turtle` | Export Turtle, JSON-LD, RDF/XML, or N-Triples |
| `GET /api/export/pipeline` | Export a live RDF-derived pipeline JSON document |
| `GET /api/export/ontology?format=turtle` | Export the ontology knowledge graph in RDF formats |
| `POST /api/sparql/query` | Execute SELECT, ASK, CONSTRUCT, or DESCRIBE |
| `POST /api/sparql/update` | Execute a SPARQL Update |
| `POST /api/validate` | Validate live RDF using SHACL |
| `GET /api/graph` | Return graph bindings for Cytoscape |

## Tests

```bash
cd backend && uv run pytest
cd frontend && npm run build
```

Source code is intended for distribution under the Apache-2.0 license; see `LICENSE`.
