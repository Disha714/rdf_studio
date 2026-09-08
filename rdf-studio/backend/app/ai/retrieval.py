"""Task 4 - CodeGraph retrieval: RAG over *code*, not documents.

Given a natural-language objective, rank the graph's code-bearing nodes and
return a compact "capability card" per hit - the signature, one-line purpose and
param knobs (the *idea of what to do*), not the raw data and not the full body.
The full body is fetched separately by IRI (get_code_artifact / the Inspector),
mirroring the boss's "retrieving code, not data".

Ranking is lexical BM25 over each artifact's label + comment + entrypoint +
input/output labels + parameter names - zero new infrastructure, everything
lives in Fuseki. Embeddings are deliberately deferred (plan M3); the scorer here
is swappable behind `rank_artifacts`.
"""
import math
import re

from ..store import query_json

RPS = "https://w3id.org/rdf-pipeline-studio#"
RDFS = "http://www.w3.org/2000/01/rdf-schema#"

# One row per code-bearing node, with its interface aggregated so a single query
# feeds the whole index.
INDEX_QUERY = f"""
PREFIX rps: <{RPS}>
PREFIX rdfs: <{RDFS}>
SELECT ?iri ?label ?comment ?entry ?lang
  (GROUP_CONCAT(DISTINCT ?inLabel; separator="|") AS ?inputs)
  (GROUP_CONCAT(DISTINCT ?outLabel; separator="|") AS ?outputs)
  (GROUP_CONCAT(DISTINCT ?pname; separator="|") AS ?params)
  (GROUP_CONCAT(DISTINCT ?inCls; separator="|") AS ?inTypes)
  (GROUP_CONCAT(DISTINCT ?outCls; separator="|") AS ?outTypes)
WHERE {{
  ?iri rps:codeArtifact ?code .
  OPTIONAL {{ ?iri rdfs:label ?label }}
  OPTIONAL {{ ?iri rdfs:comment ?comment }}
  OPTIONAL {{ ?iri rps:codeEntrypoint ?entry }}
  OPTIONAL {{ ?iri rps:codeLanguage ?lang }}
  OPTIONAL {{ ?iri rps:hasInput ?in . OPTIONAL {{ ?in rdfs:label ?inLabel }} }}
  OPTIONAL {{ ?iri rps:hasOutput ?out . OPTIONAL {{ ?out rdfs:label ?outLabel }} }}
  OPTIONAL {{ ?iri rps:hasParameter ?p . OPTIONAL {{ ?p rps:paramName ?pname }} }}
  OPTIONAL {{ ?iri rps:signatureInput ?si . ?si rps:argClass ?inClsIri . OPTIONAL {{ ?inClsIri rdfs:label ?inCls }} }}
  OPTIONAL {{ ?iri rps:signatureOutput ?so . ?so rps:argClass ?outClsIri . OPTIONAL {{ ?outClsIri rdfs:label ?outCls }} }}
}}
GROUP BY ?iri ?label ?comment ?entry ?lang
"""

_TOKEN = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    # snake_case / camelCase both fall out of lowercasing then splitting on
    # non-alphanumerics; good enough to match "cohort similarity" -> jaccard's
    # "cohort", "similarity" tokens.
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    return _TOKEN.findall(spaced.lower())


def _split(value: str) -> list[str]:
    return [part for part in (value or "").split("|") if part.strip()]


def load_index() -> list[dict]:
    rows = query_json(INDEX_QUERY).get("results", {}).get("bindings", [])
    index: list[dict] = []
    for row in rows:
        get = lambda k: row.get(k, {}).get("value", "")
        iri = get("iri")
        record = {
            "iri": iri,
            "label": get("label") or iri.rsplit("/", 1)[-1].rsplit("#", 1)[-1],
            "comment": get("comment"),
            "entrypoint": get("entry"),
            "language": get("lang") or "python",
            "inputs": _split(get("inputs")),
            "outputs": _split(get("outputs")),
            "params": _split(get("params")),
            "inputTypes": _split(get("inTypes")),
            "outputTypes": _split(get("outTypes")),
        }
        searchable = " ".join(
            [record["label"], record["comment"], record["entrypoint"]]
            + record["inputs"] + record["outputs"] + record["params"]
            + record["inputTypes"] + record["outputTypes"]
        )
        record["_tokens"] = _tokenize(searchable)
        index.append(record)
    return index


def _bm25(query_tokens: list[str], index: list[dict], k1: float = 1.5, b: float = 0.75) -> list[float]:
    n = len(index)
    if n == 0:
        return []
    doc_len = [len(rec["_tokens"]) for rec in index]
    avg_len = sum(doc_len) / n or 1.0
    # document frequency per token
    df: dict[str, int] = {}
    for rec in index:
        for term in set(rec["_tokens"]):
            df[term] = df.get(term, 0) + 1
    scores = [0.0] * n
    for term in set(query_tokens):
        if term not in df:
            continue
        idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
        for i, rec in enumerate(index):
            tf = rec["_tokens"].count(term)
            if not tf:
                continue
            denom = tf + k1 * (1 - b + b * doc_len[i] / avg_len)
            scores[i] += idf * (tf * (k1 + 1) / denom)
    return scores


def _capability_card(record: dict, score: float) -> dict:
    """The compact card the agent reasons over: what the block does + its typed
    interface + knobs, without the code body."""
    sig_in = ", ".join(record["inputTypes"]) if record["inputTypes"] else ", ".join(record["inputs"])
    signature = f"{record['entrypoint'] or 'fn'}({sig_in})"
    if record["outputTypes"]:
        signature += f" -> {', '.join(record['outputTypes'])}"
    return {
        "iri": record["iri"],
        "label": record["label"],
        "purpose": record["comment"],
        "entrypoint": record["entrypoint"],
        "language": record["language"],
        "signature": signature,
        "inputs": record["inputs"],
        "outputs": record["outputs"],
        "params": record["params"],
        "score": round(score, 4),
    }


def get_code_artifact(iri: str) -> dict:
    """The full standalone code + interface + params for one node - what an agent
    fetches after a search card tells it which block it wants."""
    if not iri:
        raise ValueError("An IRI is required.")
    rows = query_json(
        f"PREFIX rps: <{RPS}> PREFIX rdfs: <{RDFS}> "
        f"SELECT ?code ?lang ?entry ?label ?comment ?version WHERE {{ "
        f"<{iri}> rps:codeArtifact ?code . "
        f"OPTIONAL {{ <{iri}> rps:codeLanguage ?lang }} OPTIONAL {{ <{iri}> rps:codeEntrypoint ?entry }} "
        f"OPTIONAL {{ <{iri}> rdfs:label ?label }} OPTIONAL {{ <{iri}> rdfs:comment ?comment }} "
        f"OPTIONAL {{ <{iri}> rps:artifactVersion ?version }} }} LIMIT 1"
    ).get("results", {}).get("bindings", [])
    if not rows:
        raise ValueError(f"No code artifact on {iri}.")
    row = rows[0]
    get = lambda k: row.get(k, {}).get("value", "")
    params = query_json(
        f"PREFIX rps: <{RPS}> SELECT ?name ?default ?type WHERE {{ "
        f"<{iri}> rps:hasParameter ?p . OPTIONAL {{ ?p rps:paramName ?name }} "
        f"OPTIONAL {{ ?p rps:paramDefault ?default }} OPTIONAL {{ ?p rps:paramType ?type }} }} ORDER BY ?name"
    ).get("results", {}).get("bindings", [])
    return {
        "iri": iri,
        "label": get("label") or iri.rsplit("/", 1)[-1].rsplit("#", 1)[-1],
        "purpose": get("comment"),
        "language": get("lang") or "python",
        "entrypoint": get("entry"),
        "version": int(get("version")) if get("version") else 1,
        "code": get("code"),
        "params": [
            {"name": p.get("name", {}).get("value", ""), "default": p.get("default", {}).get("value", ""), "type": p.get("type", {}).get("value", "string")}
            for p in params
        ],
    }


def get_ontology_context(iris: list[str]) -> dict:
    """The typed constraints around a set of nodes: their classes, the
    data-structure/ontology types on their signature inputs/outputs, and how they
    connect - the "what can attach to what" an assembler needs to stay on-ontology.
    Read-only; no inference (asserted triples only, per the OWL-defer constraint)."""
    if not iris:
        raise ValueError("At least one IRI is required.")
    contexts = []
    for iri in iris:
        types = [b["t"]["value"] for b in query_json(
            f"PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> SELECT ?t WHERE {{ <{iri}> rdf:type ?t }}"
        ).get("results", {}).get("bindings", [])]
        sig = query_json(
            f"PREFIX rps: <{RPS}> PREFIX rdfs: <{RDFS}> "
            f"SELECT ?dir ?name ?cls WHERE {{ "
            f"{{ <{iri}> rps:signatureInput ?a . BIND('in' AS ?dir) }} UNION {{ <{iri}> rps:signatureOutput ?a . BIND('out' AS ?dir) }} "
            f"OPTIONAL {{ ?a rps:argName ?name }} OPTIONAL {{ ?a rps:argClass ?c . OPTIONAL {{ ?c rdfs:label ?cls }} }} }}"
        ).get("results", {}).get("bindings", [])
        downstream = [b["d"]["value"] for b in query_json(
            f"PREFIX rps: <{RPS}> SELECT ?d WHERE {{ <{iri}> rps:isIntermedateProcessto ?d }}"
        ).get("results", {}).get("bindings", [])]
        contexts.append({
            "iri": iri,
            "types": types,
            "inputTypes": [b["cls"]["value"] for b in sig if b.get("dir", {}).get("value") == "in" and b.get("cls")],
            "outputTypes": [b["cls"]["value"] for b in sig if b.get("dir", {}).get("value") == "out" and b.get("cls")],
            "feedsInto": downstream,
        })
    return {"contexts": contexts}


def list_capabilities() -> dict:
    """The whole catalog of code-bearing nodes as capability cards - for planning."""
    index = load_index()
    return {"total": len(index), "capabilities": [_capability_card(rec, 0.0) for rec in index]}


def rank_artifacts(query: str, k: int = 5) -> dict:
    if not query or not query.strip():
        raise ValueError("Provide an objective to retrieve code for.")
    index = load_index()
    if not index:
        return {"query": query, "k": k, "results": [], "total": 0}
    query_tokens = _tokenize(query)
    scores = _bm25(query_tokens, index)
    ranked = sorted(zip(index, scores), key=lambda pair: pair[1], reverse=True)
    # Keep only cards that actually matched a query term; fall back to the top
    # card so the caller always sees the best available capability.
    hits = [(rec, sc) for rec, sc in ranked if sc > 0][:k] or ranked[:1]
    return {
        "query": query,
        "k": k,
        "total": len(index),
        "results": [_capability_card(rec, sc) for rec, sc in hits],
    }
