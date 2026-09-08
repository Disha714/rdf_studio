"""CodeGraph endpoints: turning the knowledge graph into an executable ontology.

Task 2 (pipeline decomposition) lives here. Task 1 (persisting a code artifact
on a node) is done directly via SPARQL from the Inspector - the same "RDF is the
only store" pattern the rest of the app uses - so it needs no endpoint. Later
tasks (retrieval, harness, MCP) will hang off this same router.
"""
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from .ai import attach, decompose, edit, execute, retrieval, signature
from .models import (
    AttachApplyRequest,
    AttachProposeRequest,
    DecomposeRequest,
    EditProposeRequest,
    InferSignatureRequest,
    ProposalIdRequest,
    RetrieveRequest,
)

router = APIRouter(prefix="/api/codegraph")


def _guard(fn, *args):
    try:
        return fn(*args)
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/decompose")
def decompose_endpoint(body: DecomposeRequest):
    return _guard(decompose.decompose_script, body.source, body.instructions)


# --- Attach code from a script onto EXISTING pipeline stages (match by label) ---

@router.post("/attach-code/propose")
def attach_propose_endpoint(body: AttachProposeRequest):
    return _guard(attach.propose_attach, body.source)


@router.post("/attach-code/apply")
def attach_apply_endpoint(body: AttachApplyRequest):
    return _guard(attach.apply_attach, [a.model_dump() for a in body.assignments])


@router.post("/infer-signature")
def infer_signature_endpoint(body: InferSignatureRequest):
    return _guard(signature.infer_signature, body.iri)


# --- Task 3: prompt-driven code editing (ephemeral until committed) ---

@router.post("/edit/propose")
def edit_propose_endpoint(body: EditProposeRequest):
    return _guard(edit.propose_edit, body.iri, body.instruction)


@router.post("/edit/apply")
def edit_apply_endpoint(body: ProposalIdRequest):
    return _guard(edit.apply_edit, body.proposalId)


@router.post("/edit/revert")
def edit_revert_endpoint(body: ProposalIdRequest):
    return _guard(edit.revert_edit, body.proposalId)


# --- Task 4: retrieval over code (RAG) ---

@router.post("/retrieve")
def retrieve_endpoint(body: RetrieveRequest):
    return _guard(retrieval.rank_artifacts, body.query, body.k)


# --- Local execution: run a node's code against uploaded input files (dev-only) ---

@router.post("/execute")
async def execute_endpoint(
    code: str = Form(...),
    language: str = Form("python"),
    entrypoint: str = Form(""),
    files: list[UploadFile] = File(default=[]),
):
    inputs = [(file.filename or "input", await file.read()) for file in files]
    try:
        return await run_in_threadpool(execute.run_code, code, language, inputs, entrypoint)
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc
