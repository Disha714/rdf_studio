"""Task 3 - prompt-driven editing of a node's code artifact, ephemeral until
committed. "change epsilon to 0.3" / "add L2 normalization" -> the model reads
the node's current `rps:codeArtifact` (plus its promoted parameters) and returns
the *whole edited function* + a short explanation; nothing is written until the
user commits.

A node with NO code yet is also a valid target: the model writes a standalone
function from scratch, grounded in the stage's own label/comment/metric formula
(the same fields modify.py exposes) rather than an existing artifact. That path
also mints codeLanguage/codeEntrypoint (which only ever existed for pre-existing
artifacts before), and reverting it deletes the artifact entirely rather than
writing an empty string back - there was nothing there before.

Same propose->apply discipline as modify.py: the proposal is held in memory and
only `apply_edit` writes to Fuseki, where it overwrites `rps:codeArtifact` and
bumps `rps:artifactVersion` so every committed edit is versioned/auditable. The
frontend renders the before/after with Monaco's diff editor - this module only
carries the two code strings, it does not compute the diff itself.
"""
import re
import time
import uuid

from rdflib import RDFS

from .client import call_structured
from ..store import query_json, update

RPS = "https://w3id.org/rdf-pipeline-studio#"
FREQREC = "https://bmtc.datakaveri.org/freqrec#"
CODE_ARTIFACT = f"{RPS}codeArtifact"
CODE_LANGUAGE = f"{RPS}codeLanguage"
ARTIFACT_VERSION = f"{RPS}artifactVersion"
HAS_PARAMETER = f"{RPS}hasParameter"

PROPOSALS: dict[str, dict] = {}

EDIT_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "newCode": {"type": "string", "description": "the FULL edited function/artifact, not just the changed lines - ready to replace rps:codeArtifact verbatim"},
        "explanation": {"type": "string", "description": "one or two sentences on what changed and why"},
        "entrypoint": {"type": "string", "description": "only when writing code from scratch: the function name in newCode; omit/ignore otherwise"},
        "newParams": {
            "type": "array",
            "description": "only constants that should be PROMOTED to tunable parameters as part of this edit (usually empty)",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "default": {"type": "string"},
                    "type": {"type": "string", "enum": ["string", "integer", "decimal", "boolean"]},
                },
                "required": ["name", "default"],
            },
        },
    },
    "required": ["newCode", "explanation"],
}

SYSTEM = (
    "You make a minimal, surgical edit to one standalone Python code artifact in response "
    "to a plain-English instruction. Rules: (1) return the COMPLETE edited function, keeping "
    "everything the instruction did not ask you to change byte-for-byte identical - preserve "
    "names, structure, comments and formatting; (2) the code stays logic only - no file paths, "
    "no I/O, no globals; (3) if the instruction changes a hardcoded constant that is clearly a "
    "tunable knob (e.g. epsilon, threshold, k), you may also report it in newParams so it can "
    "become a first-class parameter. Never rewrite the whole thing when a one-line change suffices."
)

SCRATCH_SYSTEM = (
    "This node has NO code yet - write ONE standalone Python function implementing it from "
    "scratch, grounded in the stage description, formula and inputs/outputs given below. "
    "Rules: (1) logic only - no file paths, no I/O, no globals, no argparse/main block; "
    "(2) parameters should mirror the stage's declared inputs; (3) if the description implies "
    "a formula, implement that exact arithmetic, not an approximation; (4) report the function "
    "name you chose as entrypoint; (5) only use newParams for a genuinely tunable constant the "
    "instruction calls out (usually empty for a first draft)."
)


def _sparql_literal(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f'"{escaped}"'


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.strip().lower()).strip("-")


def _load_artifact(iri: str) -> dict | None:
    rows = query_json(
        f"PREFIX rps: <{RPS}> PREFIX rdfs: <{RDFS}> "
        f"SELECT ?code ?lang ?entry ?label ?version WHERE {{ "
        f"<{iri}> rps:codeArtifact ?code . "
        f"OPTIONAL {{ <{iri}> rps:codeLanguage ?lang }} "
        f"OPTIONAL {{ <{iri}> rps:codeEntrypoint ?entry }} "
        f"OPTIONAL {{ <{iri}> rdfs:label ?label }} "
        f"OPTIONAL {{ <{iri}> rps:artifactVersion ?version }} }} LIMIT 1"
    )
    bindings = rows.get("results", {}).get("bindings", [])
    if not bindings:
        return None
    row = bindings[0]

    params = query_json(
        f"PREFIX rps: <{RPS}> SELECT ?name ?default ?type WHERE {{ "
        f"<{iri}> rps:hasParameter ?p . "
        f"OPTIONAL {{ ?p rps:paramName ?name }} OPTIONAL {{ ?p rps:paramDefault ?default }} "
        f"OPTIONAL {{ ?p rps:paramType ?type }} }} ORDER BY ?name"
    ).get("results", {}).get("bindings", [])

    return {
        "code": row["code"]["value"],
        "language": row.get("lang", {}).get("value", "python"),
        "entrypoint": row.get("entry", {}).get("value", ""),
        "label": row.get("label", {}).get("value", iri),
        "version": int(row["version"]["value"]) if row.get("version") else 1,
        "params": [
            {"name": p.get("name", {}).get("value", ""), "default": p.get("default", {}).get("value", ""), "type": p.get("type", {}).get("value", "string")}
            for p in params
        ],
    }


def _load_stage_context(iri: str) -> dict:
    """Grounding for writing code from scratch: the node's label, description, the
    formula of any metric it computes, and its declared inputs/outputs. Raises only
    if the IRI isn't a real node in the graph at all."""
    rows = query_json(
        f"PREFIX rps: <{RPS}> PREFIX rdfs: <{RDFS}> PREFIX freqrec: <{FREQREC}> "
        f"SELECT ?label ?comment ?formula "
        f'(GROUP_CONCAT(DISTINCT ?inLabel; separator="|") AS ?inputs) '
        f'(GROUP_CONCAT(DISTINCT ?outLabel; separator="|") AS ?outputs) WHERE {{ '
        f"OPTIONAL {{ <{iri}> rdfs:label ?label }} "
        f"OPTIONAL {{ <{iri}> rdfs:comment ?comment }} "
        f"OPTIONAL {{ <{iri}> rps:computesMetric ?metric . ?metric freqrec:formula ?formula }} "
        f"OPTIONAL {{ <{iri}> rps:hasInput ?in . OPTIONAL {{ ?in rdfs:label ?inLabel }} }} "
        f"OPTIONAL {{ <{iri}> rps:hasOutput ?out . OPTIONAL {{ ?out rdfs:label ?outLabel }} }} "
        f"FILTER EXISTS {{ <{iri}> ?anyP ?anyO }} "
        f"}} GROUP BY ?label ?comment ?formula"
    )
    bindings = rows.get("results", {}).get("bindings", [])
    if not bindings:
        raise ValueError(f"Unknown node: {iri}")
    row = bindings[0]
    return {
        "label": row.get("label", {}).get("value", iri),
        "comment": row.get("comment", {}).get("value", ""),
        "formula": row.get("formula", {}).get("value", ""),
        "inputs": [v for v in row.get("inputs", {}).get("value", "").split("|") if v],
        "outputs": [v for v in row.get("outputs", {}).get("value", "").split("|") if v],
    }


def propose_edit(iri: str, instruction: str) -> dict:
    if not iri:
        raise ValueError("A node IRI is required.")
    if not instruction or not instruction.strip():
        raise ValueError("Describe the change you want to make.")
    artifact = _load_artifact(iri)

    if artifact is not None:
        param_lines = "\n".join(f"- {p['name']} = {p['default']} ({p['type']})" for p in artifact["params"]) or "(none)"
        user_content = (
            f"Instruction: {instruction}\n\n"
            f"Existing tunable parameters:\n{param_lines}\n\n"
            f"Current {artifact['language']} artifact (entrypoint `{artifact['entrypoint'] or 'unknown'}`):\n"
            f"```{artifact['language']}\n{artifact['code']}\n```"
        )
        system = SYSTEM
    else:
        stage = _load_stage_context(iri)
        user_content = (
            f"Instruction: {instruction}\n\n"
            f"Label: {stage['label']}\n"
            f"Description: {stage['comment'] or '(none)'}\n"
            f"Formula (if it computes a metric): {stage['formula'] or '(none)'}\n"
            f"Inputs: {', '.join(stage['inputs']) or '(none declared)'}\n"
            f"Outputs: {', '.join(stage['outputs']) or '(none declared)'}"
        )
        system = SCRATCH_SYSTEM

    result = call_structured(
        system=system,
        user_content=user_content,
        tool_name="report_code_edit",
        tool_description="Report the edited code artifact and what changed.",
        tool_schema=EDIT_TOOL_SCHEMA,
        max_tokens=8000,
    )
    new_code = (result.get("newCode") or "").strip()
    if not new_code:
        raise ValueError("The model did not return any edited code - try rephrasing the instruction.")

    existing_names = {p["name"].strip().lower() for p in artifact["params"]} if artifact else set()
    new_params = [
        {"name": p.get("name", "").strip(), "default": str(p.get("default", "")), "type": p.get("type") or "string"}
        for p in (result.get("newParams") or [])
        if p.get("name") and p["name"].strip().lower() not in existing_names
    ]

    from_version = artifact["version"] if artifact else 0
    label = artifact["label"] if artifact else stage["label"]
    entrypoint = artifact["entrypoint"] if artifact else (result.get("entrypoint") or "").strip() or _slug(label).replace("-", "_") or "run"
    language = artifact["language"] if artifact else "python"

    proposal_id = uuid.uuid4().hex[:12]
    proposal = {
        "id": proposal_id,
        "iri": iri,
        "label": label,
        "instruction": instruction,
        "language": language,
        "entrypoint": entrypoint,
        "isNew": artifact is None,
        "previousCode": artifact["code"] if artifact else "",
        "newCode": new_code,
        "explanation": result.get("explanation", ""),
        "newParams": new_params,
        "fromVersion": from_version,
        "toVersion": from_version + 1,
        "unchanged": artifact is not None and new_code == artifact["code"],
        "createdAt": time.time(),
    }
    PROPOSALS[proposal_id] = proposal
    return proposal


def get_proposal(proposal_id: str) -> dict:
    proposal = PROPOSALS.get(proposal_id)
    if not proposal:
        raise KeyError(f"Unknown edit proposal: {proposal_id}")
    return proposal


def apply_edit(proposal_id: str) -> dict:
    proposal = get_proposal(proposal_id)
    iri = proposal["iri"]
    is_new = proposal.get("isNew", False)

    if not is_new:
        # Confirm the node still carries a code artifact before overwriting it.
        current = query_json(f"PREFIX rps: <{RPS}> ASK {{ <{iri}> rps:codeArtifact ?c }}")
        if not current.get("boolean"):
            raise ValueError("The target node no longer has a code artifact.")

    inserts = [
        f"<{iri}> rps:codeArtifact {_sparql_literal(proposal['newCode'])} .",
        f"<{iri}> rps:artifactVersion {proposal['toVersion']} .",
    ]
    deletes = [f"<{iri}> rps:codeArtifact ?oldCode . <{iri}> rps:artifactVersion ?oldVersion"]
    where_parts = [f"OPTIONAL {{ <{iri}> rps:codeArtifact ?oldCode }} OPTIONAL {{ <{iri}> rps:artifactVersion ?oldVersion }}"]
    if is_new:
        # These never existed on a codeless node - mint them alongside the artifact.
        inserts.append(f"<{iri}> rps:codeLanguage {_sparql_literal(proposal['language'])} .")
        inserts.append(f"<{iri}> rps:codeEntrypoint {_sparql_literal(proposal['entrypoint'])} .")

    extra = []
    for param in proposal.get("newParams", []):
        piri = f"{iri}#param-{_slug(param['name'])}"
        inserts.append(f"<{iri}> rps:hasParameter <{piri}> .")
        extra.append(
            f"<{piri}> a rps:Parameter ; rps:paramName {_sparql_literal(param['name'])} ; "
            f"rps:paramDefault {_sparql_literal(param['default'])} ; rps:paramType {_sparql_literal(param.get('type') or 'string')} ."
        )

    sparql = (
        f"PREFIX rps: <{RPS}> "
        f"DELETE {{ {' . '.join(deletes)} }} "
        f"INSERT {{ {' '.join(inserts + extra)} }} "
        f"WHERE {{ {' '.join(where_parts)} }}"
    )
    update(sparql)
    proposal["appliedAt"] = time.time()
    return {"proposalId": proposal_id, "iri": iri, "version": proposal["toVersion"], "promotedParams": [p["name"] for p in proposal.get("newParams", [])]}


def revert_edit(proposal_id: str) -> dict:
    """Undo an applied edit. For an edit to pre-existing code, writes the pre-edit
    `previousCode` back and restores the original artifactVersion. For code that was
    written from scratch (isNew), there was nothing before it, so revert deletes the
    artifact/version/language/entrypoint entirely rather than writing an empty string
    back. Params promoted by the edit are removed either way."""
    proposal = get_proposal(proposal_id)
    iri = proposal["iri"]
    is_new = proposal.get("isNew", False)
    if not query_json(f"PREFIX rps: <{RPS}> ASK {{ <{iri}> rps:codeArtifact ?c }}").get("boolean"):
        raise ValueError("The target node no longer has a code artifact.")

    param_iris = [f"{iri}#param-{_slug(param['name'])}" for param in proposal.get("newParams", [])]
    delete_params = "".join(
        f"DELETE WHERE {{ <{piri}> ?pp ?po }}; DELETE WHERE {{ <{iri}> rps:hasParameter <{piri}> }}; "
        for piri in param_iris
    )

    if is_new:
        sparql = (
            f"PREFIX rps: <{RPS}> "
            f"{delete_params}"
            f"DELETE WHERE {{ <{iri}> rps:codeArtifact ?c }}; "
            f"DELETE WHERE {{ <{iri}> rps:artifactVersion ?v }}; "
            f"DELETE WHERE {{ <{iri}> rps:codeLanguage ?l }}; "
            f"DELETE WHERE {{ <{iri}> rps:codeEntrypoint ?e }}"
        )
    else:
        sparql = (
            f"PREFIX rps: <{RPS}> "
            f"{delete_params}"
            f"DELETE {{ <{iri}> rps:codeArtifact ?oldCode . <{iri}> rps:artifactVersion ?oldVersion }} "
            f"INSERT {{ <{iri}> rps:codeArtifact {_sparql_literal(proposal['previousCode'])} . <{iri}> rps:artifactVersion {proposal['fromVersion']} }} "
            f"WHERE {{ OPTIONAL {{ <{iri}> rps:codeArtifact ?oldCode }} OPTIONAL {{ <{iri}> rps:artifactVersion ?oldVersion }} }}"
        )
    update(sparql)
    proposal["revertedAt"] = time.time()
    return {"proposalId": proposal_id, "iri": iri, "version": proposal["fromVersion"], "removedParams": [p["name"] for p in proposal.get("newParams", [])]}
