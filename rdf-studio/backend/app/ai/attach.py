"""Attach code to an ALREADY-EXISTING pipeline's stages.

When a pipeline is already modeled (e.g. the fetched freqrec graph, whose stages
carry no code), this takes a pasted script, splits it into blocks (reusing the
decompose LLM step), then MATCHES each block to an existing analyticalProcess node
by label/entrypoint and writes the block's code onto THAT node - instead of
minting a new one. This is the "decompose on top of Fetch" flow: the code lands on
the real stages, no duplicates.

Two steps, like the rest of the app: `propose_attach` returns the matches for
review (nothing written); `apply_attach` writes the confirmed assignments.
"""
import re

from . import decompose
from ..store import query_json, update

RPS = "https://w3id.org/rdf-pipeline-studio#"
RDFS = "http://www.w3.org/2000/01/rdf-schema#"


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


def _existing_stages() -> dict[str, tuple[str, str]]:
    """normalized label -> (iri, label) for every existing analytical-process node."""
    rows = query_json(
        f"PREFIX rps: <{RPS}> PREFIX rdfs: <{RDFS}> "
        f"SELECT ?s ?label WHERE {{ ?s a <{RPS}analyticalProcess> . OPTIONAL {{ ?s rdfs:label ?label }} }}"
    ).get("results", {}).get("bindings", [])
    stages: dict[str, tuple[str, str]] = {}
    for row in rows:
        iri = row.get("s", {}).get("value", "")
        label = row.get("label", {}).get("value", "") or iri.rsplit("/", 1)[-1].rsplit("#", 1)[-1]
        stages[_norm(label)] = (iri, label)
    return stages


def propose_attach(source: str) -> dict:
    """Split the script, match each block to an existing stage by label/entrypoint,
    and return the mapping for review. Nothing is written."""
    blocks = decompose.decompose_script(source).get("blocks", [])
    if not blocks:
        raise ValueError("The model did not extract any code blocks from this script.")
    stages = _existing_stages()
    matches = []
    for block in blocks:
        match = stages.get(_norm(block.get("entrypoint", ""))) or stages.get(_norm(block.get("label", "")))
        matches.append({
            "blockLabel": block.get("label", ""),
            "entrypoint": block.get("entrypoint", ""),
            "language": block.get("language") or "python",
            "code": block.get("code", ""),
            "stageIri": match[0] if match else "",
            "stageLabel": match[1] if match else "",
            "matched": bool(match),
        })
    return {"matches": matches, "existingStages": len(stages)}


def _lit(value: str) -> str:
    return '"' + (value or "").replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + '"'


def apply_attach(assignments: list[dict]) -> dict:
    """Write code onto existing stages. assignments: [{iri, code, entrypoint, language}].
    Overwrites any existing code artifact on that stage."""
    applied = 0
    for item in assignments:
        iri = item.get("iri", "")
        code = item.get("code", "")
        if not iri or not code.strip():
            continue
        language = item.get("language") or "python"
        entry = item.get("entrypoint", "")
        entry_triple = f" ; rps:codeEntrypoint {_lit(entry)}" if entry else ""
        update(
            f"PREFIX rps: <{RPS}> "
            f"DELETE WHERE {{ <{iri}> rps:codeArtifact ?c }}; "
            f"DELETE WHERE {{ <{iri}> rps:codeLanguage ?l }}; "
            f"DELETE WHERE {{ <{iri}> rps:codeEntrypoint ?e }}; "
            f"INSERT DATA {{ <{iri}> rps:codeArtifact {_lit(code)} ; rps:codeLanguage {_lit(language)}{entry_triple} }}"
        )
        applied += 1
    return {"applied": applied}
