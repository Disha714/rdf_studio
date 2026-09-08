from pydantic import BaseModel, Field


class SparqlRequest(BaseModel):
    query: str = Field(min_length=1)


class UpdateRequest(BaseModel):
    update: str = Field(min_length=1)


class UploadedScript(BaseModel):
    filename: str = Field(min_length=1)
    source: str = Field(min_length=1)


class GenerateKgRequest(BaseModel):
    # At least one of scripts/exampleStageIds is required - enforced in
    # generate.generate_kg_from_code, not here, since either alone is valid
    # (new code vs. reproducing an existing stage from its own RDF).
    scripts: list[UploadedScript] = Field(default_factory=list)
    instructions: str | None = None
    exampleStageIds: list[str] | None = None
    currentJsonld: list[dict] | None = None
    provider: str | None = None
    model: str | None = None
    modelCode: str | None = None


class ClarifyKgRequest(BaseModel):
    scripts: list[UploadedScript] = Field(default_factory=list)
    instructions: str | None = None
    provider: str | None = None
    model: str | None = None
    modelCode: str | None = None


class ProposeClassRequest(BaseModel):
    instruction: str = Field(min_length=1)
    scripts: list[UploadedScript] = Field(default_factory=list)
    provider: str | None = None
    model: str | None = None
    modelCode: str | None = None


class RenderClassRequest(BaseModel):
    # A proposal as edited in the review card. Re-validated server-side before it is
    # serialized, so a user's edits pass the same guards the model's output does.
    proposal: dict


class ProposeModificationRequest(BaseModel):
    instruction: str = Field(min_length=1)
    targetStageId: str | None = None
    pastedCode: str | None = None


class ChatTurn(BaseModel):
    role: str = Field(min_length=1)
    text: str = Field(min_length=1)


class ChatRequest(BaseModel):
    messages: list[ChatTurn] = Field(min_length=1)
    provider: str | None = None
    model: str | None = None
    modelCode: str | None = None


class ProposalIdRequest(BaseModel):
    proposalId: str = Field(min_length=1)


class VerifyStageCodeRequest(BaseModel):
    stageId: str = Field(min_length=1)
    code: str = Field(min_length=1)


# --- CodeGraph (executable ontology) ---

class DecomposeRequest(BaseModel):
    source: str = Field(min_length=1)
    instructions: str | None = None


class InferSignatureRequest(BaseModel):
    iri: str = Field(min_length=1)


class EditProposeRequest(BaseModel):
    iri: str = Field(min_length=1)
    instruction: str = Field(min_length=1)


class RetrieveRequest(BaseModel):
    query: str = Field(min_length=1)
    k: int = Field(default=5, ge=1, le=25)


class AttachProposeRequest(BaseModel):
    source: str = Field(min_length=1)


class CodeAssignment(BaseModel):
    iri: str = Field(min_length=1)
    code: str = Field(min_length=1)
    entrypoint: str | None = None
    language: str | None = None


class AttachApplyRequest(BaseModel):
    assignments: list[CodeAssignment] = Field(min_length=1)


# --- JSON-LD tools (Table / Frame) ---

class JsonLdTableRequest(BaseModel):
    source: str = Field(default="live", pattern="^(live|paste)$")
    document: str | None = None  # required when source == "paste"; raw JSON-LD text
    include_ui_metadata: bool = False


class JsonLdFrameRequest(BaseModel):
    source: str = Field(default="live", pattern="^(live|paste)$")
    document: str | None = None  # required when source == "paste"
    frame: str = Field(min_length=1)  # JSON-LD frame document, as JSON text
    include_ui_metadata: bool = False
