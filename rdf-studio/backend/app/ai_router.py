from fastapi import APIRouter, HTTPException

from .ai import chat, classgen, generate, modify, verify
from .ai.client import active_provider
from .models import ChatRequest, ClarifyKgRequest, GenerateKgRequest, ProposalIdRequest, ProposeClassRequest, ProposeModificationRequest, RenderClassRequest, VerifyStageCodeRequest

router = APIRouter(prefix="/api/ai")


def _guard(fn, *args):
    try:
        return fn(*args)
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/status")
def status():
    info = active_provider()
    return {"hasApiKey": bool(info["provider"]), "provider": info["provider"], "model": info["model"]}


@router.get("/stages")
def stages():
    return {"stages": modify.list_stages()}


@router.post("/verify")
def verify_lineage():
    return _guard(verify.run_lineage_verification)


@router.post("/verify/stage-code")
def verify_stage_code(body: VerifyStageCodeRequest):
    return _guard(verify.verify_stage_against_code, body.stageId, body.code)


@router.post("/generate-kg")
def generate_kg(body: GenerateKgRequest):
    scripts = [script.model_dump() for script in body.scripts]
    return _guard(generate.generate_kg_from_code, scripts, body.instructions, body.exampleStageIds, body.provider, body.model, body.modelCode, body.currentJsonld)


@router.post("/clarify-kg")
def clarify_kg(body: ClarifyKgRequest):
    scripts = [script.model_dump() for script in body.scripts]
    return _guard(generate.clarify_kg_request, scripts, body.instructions, body.provider, body.model, body.modelCode)


@router.post("/class/propose")
def propose_class(body: ProposeClassRequest):
    """Review-only: proposes a new class (or names the existing one that already fits).
    Nothing is written - the user approves via /api/import/ontology + /api/import/pipeline."""
    scripts = [script.model_dump() for script in body.scripts]
    return _guard(classgen.propose_class, body.instruction, scripts, body.provider, body.model, body.modelCode)


@router.post("/class/render")
def render_class(body: RenderClassRequest):
    """Re-validate and re-serialize a proposal the user edited. No LLM call."""
    return _guard(classgen.render_class_proposal, body.proposal)


@router.post("/modify/examples")
def suggest_modification_examples():
    return {"examples": _guard(modify.suggest_modification_examples)}


@router.post("/modify/propose")
def propose_modification(body: ProposeModificationRequest):
    return _guard(modify.propose_modification, body.instruction, body.targetStageId, body.pastedCode)


@router.post("/modify/apply")
def apply_proposal(body: ProposalIdRequest):
    return _guard(modify.apply_proposal, body.proposalId)


@router.post("/modify/revert")
def revert_proposal(body: ProposalIdRequest):
    return _guard(modify.revert_proposal, body.proposalId)


@router.post("/chat")
def chat_endpoint(body: ChatRequest):
    messages = [turn.model_dump() for turn in body.messages]
    return _guard(chat.answer_playground, messages, body.provider, body.model, body.modelCode)
