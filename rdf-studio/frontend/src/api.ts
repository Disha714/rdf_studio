export type BindingValue = { type: string; value: string; datatype?: string; 'xml:lang'?: string };
export type Binding = Record<string, BindingValue>;
export type SparqlResponse = { type: 'result'; head: { vars: string[] }; results?: { bindings: Binding[] }; boolean?: boolean } | { type: 'graph'; turtle: string; triples: number };
export type ValidationTerm = { type: string; value: string } | null;
export type ValidationRule = { id: string; shape: string; targetClass: ValidationTerm; path: ValidationTerm; message: string; constraints: { type: string; value: string }[]; targetCount: number; violationCount: number; status: 'passed' | 'failed' };
export type ValidationViolation = { focusNode: ValidationTerm; path: ValidationTerm; value: ValidationTerm; message: string; severity: ValidationTerm; constraint: ValidationTerm };
export type ValidationResponse = { conforms: boolean; report: string; triples: number; rules: ValidationRule[]; violations: ValidationViolation[] };

export type AiStatus = { hasApiKey: boolean; provider: 'anthropic' | 'openai' | 'ollama' | null; model: string | null };
export type Stage = { id: string; label: string };
export type StructuralIssue = { severity: 'error' | 'warning'; subject: string; subjectLabel: string; message: string };
export type PlausibilityFinding = { subject: string; severity: 'info' | 'warning'; message: string };
export type VerifyResponse = { stageCount: number; structuralIssues: StructuralIssue[]; plausibilityFindings: PlausibilityFinding[] };
export type StageCodeMetricVerdict = { metric: string; consistent: boolean; explanation: string };
export type StageCodeCheck = { stage: string; consistent: boolean; explanation: string; perMetric: StageCodeMetricVerdict[] };
export type UploadedScript = { filename: string; source: string };
export type GenerateKgResponse = { proposals: Record<string, unknown>[]; jsonld: Record<string, unknown>[] };
export type LlmProvider = 'anthropic' | 'openai' | 'ollama' | 'llm';
export type AiModelOptions = { provider?: LlmProvider; model?: string; modelCode?: string };
export type ClarificationQuestion = { question: string; options?: string[] };
export type ClarifyKgResponse = { ready: boolean; questions: ClarificationQuestion[]; normalizedInstructions: string };
export type MetricUpdate = { metricLabel: string; newFormula: string } | null;
export type NewProduct = { name: string; role: 'input' | 'output' };
export type Proposal = { id: string; instruction: string; targetStageId: string; targetStageLabel: string; previousComment: string; updatedComment: string; metricUpdate: MetricUpdate; newProducts: NewProduct[]; codeSuggestion: string | null; rationale: string; expectedImpact: string; createdAt: number };
export type ModificationExample = { targetStageId: string; targetStageLabel: string; instruction: string; rationale: string };
export type ApplyResult = { proposalId: string; sparqlApplied: string; structuralIssues: StructuralIssue[] };
export type RevertProposalResult = { proposalId: string; sparqlApplied: string; manualRemoval: string[] };

// --- Grounded Playground chat ---
export type ChatTurn = { role: 'user' | 'assistant'; text: string };
export type ChatAction = { kind: 'editCode' | 'modifyOntology' | 'createClass'; iri: string; label: string; targetStageId: string; instruction: string; why: string };
export type ChatResponse = { answer: string; actions: ChatAction[]; clarificationOptions?: ClarificationQuestion[] };

// --- AI-proposed ontology classes (review-only until the user approves) ---
export type ProposedProperty = { iri: string; localName: string; label: string; comment: string; rangeIri: string; kind: 'datatype' | 'object'; required: boolean; multiple: boolean };
export type ProposedClass = { iri: string; namespace: string; localName: string; label: string; comment: string; parentClassIri: string; properties: ProposedProperty[] };
export type ProposedLink = { predicateIri: string; predicateLabel: string; targetIri: string; targetLabel: string; targetClassIri: string; direction: 'in' | 'out' };
export type ProposedPropertyValue = { predicateIri: string; predicateLabel: string; value: string };
export type ProposedInstance = { iri: string; name: string; classIri: string; classLabel: string; comment: string; links: ProposedLink[]; propertyValues: ProposedPropertyValue[] };
/** When `reuse` is set, an existing class already covers the request and nothing is minted. */
export type ClassProposal = { reuse: { classIri: string; classLabel: string; rationale: string } | null; classes: ProposedClass[]; instances: ProposedInstance[]; warnings: string[] };
/** The only predicates, targets, and settable properties a link/value may legally use;
 *  anything else is dropped server-side, so the review card must offer nothing but these. */
export type ClassLinkOptions = { predicates: { iri: string; label: string }[]; targets: { iri: string; label: string }[]; properties: { iri: string; label: string }[] };
/** `schemaJsonld` and `instanceJsonld` must be imported in that order, via /import/ontology
 *  then /import/pipeline — see classgen.split_nodes for why they cannot be one document. */
export type ClassProposalResponse = { proposal: ClassProposal; jsonld: Record<string, unknown>[]; schemaJsonld: Record<string, unknown>[]; instanceJsonld: Record<string, unknown>[]; turtle: string; options: ClassLinkOptions };

// --- CodeGraph (executable ontology) ---
export type DecomposeBlock = { label: string; comment: string; code: string; entrypoint?: string; language?: string; inputs: string[]; outputs: string[]; metric?: { label: string; formula: string; unit?: string; groundedIn?: string } | null };
export type DecomposeResponse = { blocks: DecomposeBlock[]; jsonld: Record<string, unknown>[] };
export type AttachMatch = { blockLabel: string; entrypoint: string; language: string; code: string; stageIri: string; stageLabel: string; matched: boolean };
export type AttachProposeResponse = { matches: AttachMatch[]; existingStages: number };
export type CodeAssignment = { iri: string; code: string; entrypoint?: string; language?: string };
export type InferredArg = { name?: string; classIri: string | null; classLabel: string | null };
export type InferSignatureResponse = { inputs: InferredArg[]; output: { classIri: string | null; classLabel: string | null } };
export type PromotedParam = { name: string; default: string; type: string };
export type CodeEditProposal = { id: string; iri: string; label: string; instruction: string; language: string; previousCode: string; newCode: string; explanation: string; newParams: PromotedParam[]; fromVersion: number; toVersion: number; unchanged: boolean; createdAt: number };
export type CodeEditApplyResult = { proposalId: string; iri: string; version: number; promotedParams: string[] };
export type CodeEditRevertResult = { proposalId: string; iri: string; version: number; removedParams: string[] };
export type ExecOutput = { filename: string; bytes: number; truncated: boolean; text?: string; base64?: string };
export type ExecuteResponse = { ok: boolean; returncode: number | null; timedOut: boolean; durationMs: number; stdout: string; stderr: string; outputs: ExecOutput[] };
export type CapabilityCard = { iri: string; label: string; purpose: string; entrypoint: string; language: string; signature: string; inputs: string[]; outputs: string[]; params: string[]; score: number };
export type RetrieveResponse = { query: string; k: number; total: number; results: CapabilityCard[] };

// --- JSON-LD tools (Table / Frame) ---
export type JsonLdTableRow = { subject: string; predicate: string; object: string; language: string | null; datatype: string | null; graph: string | null };
export type JsonLdTableResponse = { rows: JsonLdTableRow[]; count: number };
export type JsonLdSource = 'live' | 'paste';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000/api';

export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.detail ?? `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}

export const api = {
  query: (query: string) => request<SparqlResponse>('/sparql/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) }),
  update: (update: string) => request<{status: string}>('/sparql/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update }) }),
  graph: () => request<Binding[]>('/graph'),
  validate: () => request<ValidationResponse>('/validate', { method: 'POST' }),
  import: (file: File, replace: boolean) => { const data = new FormData(); data.append('file', file); return request<{triples: number; filename: string}>(`/rdf/import?replace=${replace}`, { method: 'POST', body: data }); },
  importOntology: (file: File, replace: boolean) => { const data = new FormData(); data.append('file', file); return request<{mode: string; triples: number; ontologyTriples: number; pipelineTriples: number; filename: string; classes: number; properties: number; resources: number; replaced: boolean}>(`/import/ontology?replace=${replace}`, { method: 'POST', body: data }); },
  importPipeline: (file: File, replace: boolean) => { const data = new FormData(); data.append('file', file); return request<{mode: string; triples: number; filename: string; resources: number; replaced: boolean}>(`/import/pipeline?replace=${replace}`, { method: 'POST', body: data }); },
  exportUrl: (format: string) => `${API_URL}/rdf/export?format=${format}`,
  pipelineExportUrl: (format = 'json') => `${API_URL}/export/pipeline?format=${format}`,
  ontologyExportUrl: (format: string) => `${API_URL}/export/ontology?format=${format}`,
  aiStatus: () => request<AiStatus>('/ai/status'),
  aiListStages: () => request<{ stages: Stage[] }>('/ai/stages'),
  aiVerify: () => request<VerifyResponse>('/ai/verify', { method: 'POST' }),
  aiVerifyStageCode: (stageId: string, code: string) => request<StageCodeCheck>('/ai/verify/stage-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stageId, code }) }),
  aiClarifyKg: (scripts: UploadedScript[], instructions: string, options?: AiModelOptions) => request<ClarifyKgResponse>('/ai/clarify-kg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scripts, instructions: instructions || undefined, ...options }) }),
  aiGenerateKg: (scripts: UploadedScript[], instructions: string, exampleStageIds: string[], options?: AiModelOptions & { currentJsonld?: Record<string, unknown>[] }) => request<GenerateKgResponse>('/ai/generate-kg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scripts, instructions: instructions || undefined, exampleStageIds: exampleStageIds.length ? exampleStageIds : undefined, currentJsonld: options?.currentJsonld, provider: options?.provider, model: options?.model, modelCode: options?.modelCode }) }),
  aiSuggestModificationExamples: () => request<{ examples: ModificationExample[] }>('/ai/modify/examples', { method: 'POST' }),
  aiProposeModification: (instruction: string, targetStageId: string, pastedCode: string) => request<Proposal>('/ai/modify/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, targetStageId: targetStageId || undefined, pastedCode: pastedCode || undefined }) }),
  aiApplyProposal: (proposalId: string) => request<ApplyResult>('/ai/modify/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalId }) }),
  aiRevertProposal: (proposalId: string) => request<RevertProposalResult>('/ai/modify/revert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalId }) }),
  aiChat: (messages: ChatTurn[], options?: AiModelOptions) => request<ChatResponse>('/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, ...options }) }),
  aiProposeClass: (instruction: string, scripts: UploadedScript[], options?: AiModelOptions) => request<ClassProposalResponse>('/ai/class/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, scripts, ...options }) }),
  aiRenderClass: (proposal: ClassProposal) => request<ClassProposalResponse>('/ai/class/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposal }) }),
  codegraphDecompose: (source: string, instructions: string) => request<DecomposeResponse>('/codegraph/decompose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, instructions: instructions || undefined }) }),
  codegraphAttachPropose: (source: string) => request<AttachProposeResponse>('/codegraph/attach-code/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) }),
  codegraphAttachApply: (assignments: CodeAssignment[]) => request<{ applied: number }>('/codegraph/attach-code/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignments }) }),
  codegraphInferSignature: (iri: string) => request<InferSignatureResponse>('/codegraph/infer-signature', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ iri }) }),
  codegraphEditPropose: (iri: string, instruction: string) => request<CodeEditProposal>('/codegraph/edit/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ iri, instruction }) }),
  codegraphEditApply: (proposalId: string) => request<CodeEditApplyResult>('/codegraph/edit/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalId }) }),
  codegraphEditRevert: (proposalId: string) => request<CodeEditRevertResult>('/codegraph/edit/revert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalId }) }),
  codegraphRetrieve: (query: string, k: number) => request<RetrieveResponse>('/codegraph/retrieve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, k }) }),
  codegraphExecute: (code: string, language: string, entrypoint: string, files: File[]) => {
    const data = new FormData();
    data.append('code', code);
    data.append('language', language || 'python');
    data.append('entrypoint', entrypoint || '');
    for (const file of files) data.append('files', file, file.name);
    return request<ExecuteResponse>('/codegraph/execute', { method: 'POST', body: data });
  },
  jsonldTable: (source: JsonLdSource, document?: string) => request<JsonLdTableResponse>('/jsonld/table', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, document }) }),
  jsonldFrame: (source: JsonLdSource, frame: string, document?: string) => request<Record<string, unknown>>('/jsonld/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, document, frame }) }),
};

const iriLocalName = (iri: string) => {
  const clean = iri.replace(/[\/#]$/, '');
  const index = Math.max(clean.lastIndexOf('#'), clean.lastIndexOf('/'));
  return decodeURIComponent(index >= 0 ? clean.slice(index + 1) : clean);
};

export const compact = (iri: string) => {
  const known = iri
    .replace('https://w3id.org/rdf-pipeline-studio#', '')
    .replace('https://example.org/pipeline/', '')
    .replace('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'rdf:')
    .replace('http://www.w3.org/2000/01/rdf-schema#', 'rdfs:')
    .replace('http://www.w3.org/2002/07/owl#', 'owl:');
  return known === iri && /^https?:\/\//.test(iri) ? iriLocalName(iri) : known;
};

export const displayName = (iri: string, label?: string) => {
  const text = label?.trim();
  return text && !/^https?:\/\//.test(text) ? text : compact(iri);
};
