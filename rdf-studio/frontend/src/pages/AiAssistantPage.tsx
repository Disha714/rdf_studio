import { useEffect, useState, type ReactNode } from 'react';
import Editor from '@monaco-editor/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Edge, Node } from '@xyflow/react';
import { AlertTriangle, CheckCircle2, FileCode2, GitBranch, Upload, Wand2, XCircle } from 'lucide-react';
import { api, type ModificationExample, type Stage, type UploadedScript } from '../api';
import { GENERATED_PREFIX, fetchExternalNodeInfo, mergeExternalNodeInfo, proposalToMatrixResources, type JsonLdNode } from '../aiGraph';
import { ErrorBox, Page } from '../components/Page';
import { useTheme } from '../theme';
import { MatrixHybridGraph, type MatrixResource } from './PipelinePage';

type Tab = 'verify' | 'generate' | 'modify';

// Same palette already used by .validation-rule.passed/.failed and
// .descriptor-table summary em, reused here so severity pills stay theme-aware
// without inventing new colors.
const SEVERITY_TOKENS: Record<string, { dark: [string, string]; light: [string, string] }> = {
  error: { dark: ['#451d2b', '#ff91aa'], light: ['#ffe5eb', '#b42347'] },
  warning: { dark: ['#4a3417', '#ffb36b'], light: ['#fff1de', '#a85d00'] },
  info: { dark: ['#17223a', '#8fb0ff'], light: ['#eaf0fb', '#2457b8'] },
};

function Severity({ level }: { level: string }) {
  const { theme } = useTheme();
  const tokens = SEVERITY_TOKENS[level] ?? SEVERITY_TOKENS.info;
  const [background, color] = theme === 'light' ? tokens.light : tokens.dark;
  const Icon = level === 'error' ? XCircle : level === 'warning' ? AlertTriangle : CheckCircle2;
  return <span className="rule-status" style={{ background, color, display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}><Icon size={11} /> {level}</span>;
}

function Chip({ children, onRemove }: { children: ReactNode; onRemove?: () => void }) {
  const { theme } = useTheme();
  const [background, color] = theme === 'light' ? SEVERITY_TOKENS.info.light : SEVERITY_TOKENS.info.dark;
  return <span className="rule-status" style={{ background, color, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
    <FileCode2 size={11} /> {children}
    {onRemove && <button type="button" onClick={onRemove} aria-label="Remove" style={{ all: 'unset', cursor: 'pointer', lineHeight: 1, fontWeight: 800 }}>×</button>}
  </span>;
}

// A small popover shown right over the graph when a node box is clicked -
// just its label and description, nothing else.
function NodeDescriptionPopover({ resource, onClose }: { resource: MatrixResource; onClose: () => void }) {
  return <div className="card" style={{ position: 'absolute', right: 16, bottom: 16, maxWidth: '320px', zIndex: 30, boxShadow: '0 16px 40px #0008' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
      <strong>{resource.label}</strong>
      <button type="button" onClick={onClose} aria-label="Close" style={{ all: 'unset', cursor: 'pointer', fontWeight: 800, lineHeight: 1 }}>×</button>
    </div>
    <p style={{ margin: '6px 0 0', fontSize: '12px' }}>{resource.resourceComment || 'No description available for this node.'}</p>
  </div>;
}

const NO_NODES: Node[] = [];
const NO_EDGES: Edge[] = [];

function StatusBanner() {
  const status = useQuery({ queryKey: ['ai-status'], queryFn: api.aiStatus });
  if (!status.data) return null;
  if (!status.data.hasApiKey) return <div className="error">No LLM configured - set LLM_BASE_URL + LLM_MODEL (self-hosted), ANTHROPIC_API_KEY, OPENAI_API_KEY, or OLLAMA_MODEL in rdf-studio/.env and restart the backend.</div>;
  return <p style={{ margin: '-0.5rem 0 0.75rem', fontSize: '12px' }}>Using <strong>{status.data.provider}</strong> ({status.data.model})</p>;
}

// A compact grid of flow-ordered stage cards - wraps into a few rows instead
// of a tall scrolling list.
function StagePicker({ stages, selected, onToggle, max }: { stages: Stage[]; selected: string[]; onToggle: (id: string) => void; max?: number }) {
  return <div className="ai-stage-grid">
    {stages.map(stage => {
      const isSelected = selected.includes(stage.id);
      const atLimit = !!max && selected.length >= max && !isSelected;
      return <button key={stage.id} type="button" className={`ai-stage-card${isSelected ? ' active' : ''}`} onClick={() => onToggle(stage.id)} disabled={atLimit} title={stage.id}>
        <strong>{stage.label}</strong>
      </button>;
    })}
  </div>;
}

function StageCodeCheck() {
  const stagesQuery = useQuery({ queryKey: ['ai-stages'], queryFn: api.aiListStages });
  const [stageId, setStageId] = useState('');
  const [code, setCode] = useState('');
  const check = useMutation({ mutationFn: () => api.aiVerifyStageCode(stageId, code) });

  return <section className="card" style={{ marginTop: '1.25rem' }}>
    <div className="section-heading"><div><h2>Check a stage against pasted code</h2><p>Optional. Paste one stage's script here for a single request - it's never stored or read from disk.</p></div></div>
    <label>Stage
      <select value={stageId} onChange={e => setStageId(e.target.value)}>
        <option value="">Select a stage…</option>
        {(stagesQuery.data?.stages ?? []).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
    </label>
    <label>Pasted code
      <textarea value={code} onChange={e => setCode(e.target.value)} style={{ width: '100%', minHeight: '120px', fontFamily: 'monospace' }} />
    </label>
    <button onClick={() => check.mutate()} disabled={!stageId || !code || check.isPending}>{check.isPending ? 'Checking…' : 'Check against code'}</button>
    <ErrorBox error={check.error} />
    {check.data ? <div style={{ marginTop: '0.75rem' }}>
      <p>{check.data.consistent ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {check.data.explanation}</p>
      {check.data.perMetric.map(m => <div key={m.metric}><code>{m.metric}</code>: {m.consistent ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {m.explanation}</div>)}
    </div> : null}
  </section>;
}

function VerifyTab() {
  const verify = useMutation({ mutationFn: api.aiVerify });
  const errorCount = verify.data?.structuralIssues.filter(i => i.severity === 'error').length ?? 0;
  const warningCount = verify.data?.structuralIssues.filter(i => i.severity === 'warning').length ?? 0;

  return <>
    <ErrorBox error={verify.error} />
    <div className="card">
      <div className="section-heading"><div><h2>Run verification</h2><p>Checks the RDF already loaded in this Studio - nothing is read from disk unless you paste code below.</p></div></div>
      <button onClick={() => verify.mutate()} disabled={verify.isPending}><Wand2 size={14} /> {verify.isPending ? 'Verifying…' : 'Run verification'}</button>
    </div>

    {verify.data ? <>
      <div className="validation-summary">
        <div className="validation-metric card"><GitBranch size={19} /><span>Stages checked</span><strong>{verify.data.stageCount}</strong></div>
        <div className="validation-metric card"><XCircle size={19} /><span>Structural errors</span><strong>{errorCount}</strong></div>
        <div className="validation-metric card"><AlertTriangle size={19} /><span>Warnings + findings</span><strong>{warningCount + verify.data.plausibilityFindings.length}</strong></div>
      </div>

      <section className="validation-section card">
        <div className="validation-section-head"><div><h2>Structural checks</h2><p>Dangling references, orphan products, missing metadata, dependency cycles - pure graph traversal, no LLM.</p></div></div>
        {verify.data.structuralIssues.length === 0 ? <div className="section-empty">No structural issues found.</div> : <div className="table-wrap"><table>
          <thead><tr><th>Severity</th><th>Subject</th><th>Message</th></tr></thead>
          <tbody>{verify.data.structuralIssues.map((issue, i) => <tr key={i}>
            <td><Severity level={issue.severity} /></td>
            <td>{issue.subjectLabel}</td>
            <td>{issue.message}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>

      <section className="validation-section card">
        <div className="validation-section-head"><div><h2>Plausibility review</h2><p>Claude reading the RDF's own text (descriptions, formulas, units, groundedIn) for internal inconsistencies - not checked against real code unless you paste it below.</p></div></div>
        {verify.data.plausibilityFindings.length === 0 ? <div className="section-empty">No findings.</div> : <div className="table-wrap"><table>
          <thead><tr><th>Severity</th><th>Subject</th><th>Message</th></tr></thead>
          <tbody>{verify.data.plausibilityFindings.map((finding, i) => <tr key={i}>
            <td><Severity level={finding.severity} /></td>
            <td>{finding.subject}</td>
            <td>{finding.message}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    </> : <div className="empty">Run verification to check the RDF's own internal consistency.</div>}

    <StageCodeCheck />
  </>;
}

function GenerateTab() {
  const { theme } = useTheme();
  const stagesQuery = useQuery({ queryKey: ['ai-stages'], queryFn: api.aiListStages });
  const [exampleStageIds, setExampleStageIds] = useState<string[]>([]);
  const [scripts, setScripts] = useState<UploadedScript[]>([]);
  const [pasteFilename, setPasteFilename] = useState('');
  const [pasteSource, setPasteSource] = useState('');
  const [instructions, setInstructions] = useState('');
  const [matrixSelectedId, setMatrixSelectedId] = useState('');
  const [detailResource, setDetailResource] = useState<MatrixResource | null>(null);
  const [showJsonLd, setShowJsonLd] = useState(false);
  const generate = useMutation({ mutationFn: () => api.aiGenerateKg(scripts, instructions, exampleStageIds) });
  const importResult = useMutation({
    mutationFn: () => {
      const blob = new File([JSON.stringify(generate.data!.jsonld, null, 2)], 'ai-generated.jsonld', { type: 'application/ld+json' });
      return api.importPipeline(blob, false);
    },
  });

  const rawMatrixResources = generate.data ? proposalToMatrixResources(generate.data.jsonld as JsonLdNode[]) : [];
  const externalIds = rawMatrixResources.filter(r => !r.resourceComment && !r.id.startsWith(GENERATED_PREFIX)).map(r => r.id).sort();
  const externalInfo = useQuery({
    queryKey: ['ai-external-node-info', externalIds],
    queryFn: () => fetchExternalNodeInfo(externalIds),
    enabled: externalIds.length > 0,
  });
  const matrixResources = mergeExternalNodeInfo(rawMatrixResources, externalInfo.data ?? []);
  useEffect(() => {
    setMatrixSelectedId(current => rawMatrixResources.some(r => r.id === current) ? current : (rawMatrixResources[0]?.id ?? ''));
    setDetailResource(null);
    setShowJsonLd(false);
  }, [generate.data]);

  const toggleExampleStage = (id: string) => setExampleStageIds(current => current.includes(id) ? current.filter(x => x !== id) : [...current, id]);
  const onFilesChosen = async (fileList: FileList | null) => {
    if (!fileList) return;
    const files = await Promise.all(Array.from(fileList).map(async file => ({ filename: file.name, source: await file.text() })));
    setScripts(current => [...current, ...files]);
  };
  const addPastedScript = () => {
    if (!pasteFilename.trim() || !pasteSource.trim()) return;
    setScripts(current => [...current, { filename: pasteFilename.trim(), source: pasteSource }]);
    setPasteFilename('');
    setPasteSource('');
  };
  const removeScript = (index: number) => setScripts(current => current.filter((_, i) => i !== index));

  return <>
    <ErrorBox error={generate.error || importResult.error} />

    <p>Provide at least one of the two below: pick existing stage(s) alone to reproduce them from their own RDF, add script(s) alone to model something new, or both together to guide new code with existing style.</p>

    <div className="card">
      <div className="section-heading"><div><h2>1. Pick existing stage(s) - reproduce or reference</h2><p>Listed in pipeline flow order. Alone, regenerates a proposal for the selected stage(s) from their own current RDF description (a reproducibility check). Combined with scripts below, guides the model's naming and granularity.</p></div></div>
      <StagePicker stages={stagesQuery.data?.stages ?? []} selected={exampleStageIds} onToggle={toggleExampleStage} max={2} />
    </div>

    <div className="card">
      <div className="section-heading"><div><h2>2. Add script(s) - model something new</h2><p>Upload or write code here. Nothing is read from disk - this is used for this one request only.</p></div></div>
      <label className="ai-upload-zone">
        <Upload size={16} />
        <span>Click to upload script file(s)<small>.py or .txt</small></span>
        <input type="file" multiple accept=".py,.txt" onChange={e => onFilesChosen(e.target.files)} />
      </label>
      <div className="ai-divider">or write it directly</div>
      <label>Filename<input value={pasteFilename} onChange={e => setPasteFilename(e.target.value)} placeholder="my_stage.py" /></label>
      <label>Source<textarea value={pasteSource} onChange={e => setPasteSource(e.target.value)} style={{ minHeight: '110px', fontFamily: 'monospace' }} /></label>
      <button className="secondary" onClick={addPastedScript} disabled={!pasteFilename.trim() || !pasteSource.trim()}>Add script</button>
      {scripts.length > 0 && <div className="ai-chip-row">
        {scripts.map((s, i) => <Chip key={`${s.filename}-${i}`} onRemove={() => removeScript(i)}>{s.filename}</Chip>)}
      </div>}
    </div>

    <div className="card">
      <div className="section-heading"><div><h2>3. Generate</h2><p>Optional rules/examples - defaults to a sensible mapping prompt if left blank.</p></div></div>
      <textarea value={instructions} onChange={e => setInstructions(e.target.value)} style={{ minHeight: '80px' }} />
      <button onClick={() => generate.mutate()} disabled={(scripts.length === 0 && exampleStageIds.length === 0) || generate.isPending} style={{ marginTop: '0.75rem' }}><Wand2 size={14} /> {generate.isPending ? 'Generating…' : 'Generate'}</button>
    </div>

    {generate.data ? <div className="card">
      <div className="section-heading"><div><h2>Generated proposal</h2><p>Click a node box in the graph for its description, then review the RDF or import it.</p></div></div>
      <div className="ai-actions">
        <button className="secondary" onClick={() => setShowJsonLd(v => !v)}>{showJsonLd ? 'Hide RDF' : 'View RDF'}</button>
        <button onClick={() => importResult.mutate()} disabled={importResult.isPending}>{importResult.isPending ? 'Importing…' : 'Import this'}</button>
      </div>
      {showJsonLd && <div className="editor" style={{ height: '35vh' }}><Editor height="100%" defaultLanguage="json" theme={theme === 'dark' ? 'vs-dark' : 'light'} value={JSON.stringify(generate.data.jsonld, null, 2)} options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13 }} /></div>}
      <div style={{ height: showJsonLd ? '45vh' : '65vh', position: 'relative', display: 'flex' }}>
        <MatrixHybridGraph resources={matrixResources} pipelineNodes={NO_NODES} pipelineEdges={NO_EDGES} selectedId={matrixSelectedId} setSelectedId={setMatrixSelectedId} onResourceClick={resource => setDetailResource(resource)} theme={theme} />
        {detailResource && <NodeDescriptionPopover resource={detailResource} onClose={() => setDetailResource(null)} />}
      </div>
      {importResult.data && <div className="success">Imported {importResult.data.resources} resource(s), {importResult.data.triples} triples.</div>}
    </div> : null}
  </>;
}

function ModifyTab() {
  const { theme } = useTheme();
  const stagesQuery = useQuery({ queryKey: ['ai-stages'], queryFn: api.aiListStages });
  const [instruction, setInstruction] = useState('');
  const [targetStageId, setTargetStageId] = useState('');
  const [pastedCode, setPastedCode] = useState('');
  const propose = useMutation({ mutationFn: () => api.aiProposeModification(instruction, targetStageId, pastedCode) });
  const apply = useMutation({ mutationFn: () => api.aiApplyProposal(propose.data!.id) });
  const examples = useMutation({ mutationFn: api.aiSuggestModificationExamples });

  const useExample = (example: ModificationExample) => {
    setInstruction(example.instruction);
    setTargetStageId(example.targetStageId);
  };

  return <>
    <ErrorBox error={propose.error || apply.error || examples.error} />

    <div className="card">
      <div className="section-heading"><div><h2>Need ideas?</h2><p>Generated by Claude from the pipeline actually loaded in this Studio - not generic placeholders.</p></div></div>
      <button className="secondary" onClick={() => examples.mutate()} disabled={examples.isPending}><Wand2 size={14} /> {examples.isPending ? 'Thinking…' : examples.data ? 'Suggest more examples' : 'Suggest examples'}</button>
      {examples.data && (examples.data.examples.length === 0 ? <div className="empty" style={{ marginTop: '0.75rem' }}>No stages found to suggest examples for.</div> : <div className="ai-example-list">
        {examples.data.examples.map((example, i) => (
          <button key={i} type="button" className="ai-example-card" onClick={() => useExample(example)}>
            <small>{example.targetStageLabel}</small>
            <strong>{example.instruction}</strong>
            <span>{example.rationale}</span>
          </button>
        ))}
      </div>)}
    </div>

    <div className="card">
      <div className="section-heading"><div><h2>Propose a change</h2><p>The LLM edits the RDF graph itself - nothing here executes code. Paste a stage's current code for a matching code suggestion, returned as text for you to apply yourself.</p></div></div>
      <label>What should change?
        <textarea value={instruction} onChange={e => setInstruction(e.target.value)} style={{ width: '100%', minHeight: '80px' }} placeholder="e.g. Exclude alternate routes with fewer than 5 trips per day from every similarity band's alternates list." />
      </label>
      <label>Target stage (optional - the model will pick one if left blank), listed in flow order
        <select value={targetStageId} onChange={e => setTargetStageId(e.target.value)}>
          <option value="">Let the model choose</option>
          {(stagesQuery.data?.stages ?? []).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <label>Paste current code (optional)
        <textarea value={pastedCode} onChange={e => setPastedCode(e.target.value)} style={{ width: '100%', minHeight: '100px', fontFamily: 'monospace' }} />
      </label>
      <button onClick={() => propose.mutate()} disabled={!instruction || propose.isPending}><Wand2 size={14} /> {propose.isPending ? 'Proposing…' : 'Propose change'}</button>
    </div>

    {propose.data ? <div className="card" style={{ marginTop: '1rem' }}>
      <div className="section-heading"><div><h2>{propose.data.targetStageLabel}</h2><p>{propose.data.rationale}</p></div></div>
      <p><strong>Expected impact:</strong> {propose.data.expectedImpact}</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
        <tbody>
          <tr><td>Comment</td><td>{propose.data.previousComment}</td><td>{propose.data.updatedComment}</td></tr>
          {propose.data.metricUpdate && <tr><td>Formula ({propose.data.metricUpdate.metricLabel})</td><td>—</td><td>{propose.data.metricUpdate.newFormula}</td></tr>}
        </tbody>
      </table></div>
      {propose.data.newProducts.length > 0 && <p style={{ marginTop: '0.5rem' }}><strong>New nodes:</strong> {propose.data.newProducts.map(p => `${p.name} (${p.role})`).join(', ')}</p>}
      {propose.data.codeSuggestion && <div style={{ marginTop: '1rem' }}>
        <p><strong>Suggested code change</strong> - copy and apply this yourself; it is not executed here.</p>
        <div className="editor"><Editor height="35vh" defaultLanguage="python" theme={theme === 'dark' ? 'vs-dark' : 'light'} value={propose.data.codeSuggestion} options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12 }} /></div>
      </div>}
      <button onClick={() => apply.mutate()} disabled={apply.isPending} style={{ marginTop: '1rem' }}>{apply.isPending ? 'Applying…' : 'Apply to graph'}</button>

      {apply.data ? <div style={{ marginTop: '1rem' }}>
        <div className="success">Applied to the live RDF graph.</div>
        <details style={{ marginTop: '0.5rem' }}><summary>SPARQL update sent</summary><pre className="result">{apply.data.sparqlApplied}</pre></details>
        <p style={{ marginTop: '0.5rem' }}><strong>Structural check after applying:</strong></p>
        {apply.data.structuralIssues.length === 0 ? <div className="section-empty">No structural issues.</div> : <ul>{apply.data.structuralIssues.map((issue, i) => <li key={i} style={{ marginBottom: '4px' }}><Severity level={issue.severity} /> {issue.subjectLabel}: {issue.message}</li>)}</ul>}
      </div> : null}
    </div> : null}
  </>;
}

const TABS: { id: Tab; label: string; icon: typeof Wand2 }[] = [
  { id: 'verify', label: 'Verify Lineage', icon: CheckCircle2 },
  { id: 'generate', label: 'Generate Knowledge Graph', icon: Upload },
  { id: 'modify', label: 'Modify Pipeline', icon: GitBranch },
];

export function AiAssistantPage() {
  const [tab, setTab] = useState<Tab>('verify');
  return <Page className="ai-page" title="AI Assistant" description="Works from the RDF already loaded in the Studio. Code only enters the picture if you paste it in, for a single request - nothing is read from or written to disk.">
    <StatusBanner />
    <div className="card" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
      {TABS.map(({ id, label, icon: Icon }) => (
        <button key={id} className={tab === id ? '' : 'secondary'} onClick={() => setTab(id)}><Icon size={14} /> {label}</button>
      ))}
    </div>
    {tab === 'verify' && <VerifyTab />}
    {tab === 'generate' && <GenerateTab />}
    {tab === 'modify' && <ModifyTab />}
  </Page>;
}
