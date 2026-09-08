import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { Braces, Check, Code2, GitCompareArrows, Play, Plus, RotateCcw, Save, Settings2, Sparkles, Terminal, Trash2, Wand2, X } from 'lucide-react';
import { api, compact, type CodeEditProposal, type ExecOutput, type ExecuteResponse } from '../api';

// Code artifact / tunable parameters / typed signature editing for a concept node.
// Extracted from the standalone Inspector so it can live inside the playground's
// full-screen node modal - "logic on the node", persisted in Fuseki via SPARQL,
// LLM edits proposed as an ephemeral diff and committed only on confirm.

const NS = 'https://w3id.org/rdf-pipeline-studio#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
const strlit = (v: string) => `"${esc(v)}"`;
const slug = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `p-${Date.now()}`;

const CODE_QUERY = (iri: string) => `PREFIX rps: <${NS}> SELECT ?code ?lang ?entry WHERE { OPTIONAL { <${iri}> rps:codeArtifact ?code } OPTIONAL { <${iri}> rps:codeLanguage ?lang } OPTIONAL { <${iri}> rps:codeEntrypoint ?entry } } LIMIT 1`;
const IO_QUERY = (iri: string) => `PREFIX rps: <${NS}> PREFIX rdfs: <${RDFS}> SELECT ?dir ?label ?target WHERE { { <${iri}> rps:hasInput ?target . BIND("in" AS ?dir) } UNION { <${iri}> rps:hasOutput ?target . BIND("out" AS ?dir) } OPTIONAL { ?target rdfs:label ?label } }`;
const PARAMS_QUERY = (iri: string) => `PREFIX rps: <${NS}> SELECT ?param ?name ?default ?type WHERE { <${iri}> rps:hasParameter ?param . OPTIONAL { ?param rps:paramName ?name } OPTIONAL { ?param rps:paramDefault ?default } OPTIONAL { ?param rps:paramType ?type } } ORDER BY ?name`;
const CLASSES_QUERY = `PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <${RDFS}> SELECT ?class ?label WHERE { ?class a owl:Class . OPTIONAL { ?class rdfs:label ?label } } ORDER BY ?label`;
const SIG_QUERY = (iri: string) => `PREFIX rps: <${NS}> SELECT ?dir ?arg ?name ?cls WHERE { { <${iri}> rps:signatureInput ?arg . BIND("in" AS ?dir) } UNION { <${iri}> rps:signatureOutput ?arg . BIND("out" AS ?dir) } OPTIONAL { ?arg rps:argName ?name } OPTIONAL { ?arg rps:argClass ?cls } }`;

type Tab = 'code' | 'parameters' | 'signature';
type Param = { param: string; name: string; default: string; type: string };
const PARAM_TYPES = ['string', 'integer', 'decimal', 'boolean'];

export function CodeArtifactPanel({ node, theme, inputArtifacts, onOutputs }: { node: { id: string; label: string; type: string }; theme: 'dark' | 'light'; inputArtifacts?: File[]; onOutputs?: (outputs: ExecOutput[]) => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('code');
  const [code, setCode] = useState('');
  const [language, setLanguage] = useState('python');
  const [entrypoint, setEntrypoint] = useState('');
  const [param, setParam] = useState({ name: '', default: '', type: 'string' });
  const [addOpen, setAddOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [editProposal, setEditProposal] = useState<CodeEditProposal | null>(null);
  const [sigInputs, setSigInputs] = useState<{ name: string; cls: string }[]>([]);
  const [sigOutput, setSigOutput] = useState('');
  const [runResult, setRunResult] = useState<ExecuteResponse | null>(null);

  const codeQuery = useQuery({ queryKey: ['cg-code', node.id], queryFn: () => api.query(CODE_QUERY(node.id)) });
  const ioQuery = useQuery({ queryKey: ['cg-io', node.id], queryFn: () => api.query(IO_QUERY(node.id)) });
  const paramsQuery = useQuery({ queryKey: ['cg-params', node.id], queryFn: () => api.query(PARAMS_QUERY(node.id)) });
  const classesQuery = useQuery({ queryKey: ['cg-classes'], queryFn: () => api.query(CLASSES_QUERY) });
  const sigQuery = useQuery({ queryKey: ['cg-sig', node.id], queryFn: () => api.query(SIG_QUERY(node.id)) });

  const codeRow = codeQuery.data?.type === 'result' ? codeQuery.data.results?.bindings?.[0] : undefined;
  const savedCode = codeRow?.code?.value ?? '';
  const savedLang = codeRow?.lang?.value ?? 'python';
  const savedEntry = codeRow?.entry?.value ?? '';
  useEffect(() => { setCode(savedCode); setLanguage(savedLang); setEntrypoint(savedEntry); }, [codeQuery.data, node.id]);
  useEffect(() => { setEditProposal(null); setInstruction(''); setTab('code'); setRunResult(null); }, [node.id]);
  useEffect(() => {
    const rows = sigQuery.data?.type === 'result' ? sigQuery.data.results?.bindings ?? [] : [];
    setSigInputs(rows.filter(r => r.dir?.value === 'in').map(r => ({ name: r.name?.value ?? '', cls: r.cls?.value ?? '' })));
    setSigOutput(rows.find(r => r.dir?.value === 'out')?.cls?.value ?? '');
  }, [sigQuery.data, node.id]);

  const ioRows = ioQuery.data?.type === 'result' ? ioQuery.data.results?.bindings ?? [] : [];
  const inputs = ioRows.filter(r => r.dir?.value === 'in').map(r => r.label?.value ?? compact(r.target?.value ?? ''));
  const outputs = ioRows.filter(r => r.dir?.value === 'out').map(r => r.label?.value ?? compact(r.target?.value ?? ''));
  const params: Param[] = (paramsQuery.data?.type === 'result' ? paramsQuery.data.results?.bindings ?? [] : []).map(r => ({ param: r.param!.value, name: r.name?.value ?? compact(r.param!.value), default: r.default?.value ?? '', type: r.type?.value ?? 'string' }));

  const hasSig = (sigQuery.data?.type === 'result' ? sigQuery.data.results?.bindings ?? [] : []).length > 0;
  const classes = (classesQuery.data?.type === 'result' ? classesQuery.data.results?.bindings ?? [] : []).map(r => ({ iri: r.class!.value, label: r.label?.value ?? compact(r.class!.value) }));
  const classLabel = (iri: string) => classes.find(c => c.iri === iri)?.label ?? compact(iri);
  const sigSummary = `${savedEntry || 'fn'}(${sigInputs.map((i, k) => `${i.name || `arg${k}`}: ${i.cls ? classLabel(i.cls) : '?'}`).join(', ')})${sigOutput ? ` → ${classLabel(sigOutput)}` : ''}`;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cg-code', node.id] });
    qc.invalidateQueries({ queryKey: ['cg-params', node.id] });
    qc.invalidateQueries({ queryKey: ['pipeline'] });
    qc.invalidateQueries({ queryKey: ['pipeline-matrix'] });
    qc.invalidateQueries({ queryKey: ['playground-resources'] });
    qc.invalidateQueries({ queryKey: ['playground-resource', node.id] });
  };
  const saveCode = useMutation({ mutationFn: api.update, onSuccess: invalidate });
  const paramMutation = useMutation({ mutationFn: api.update, onSuccess: () => { invalidate(); setParam({ name: '', default: '', type: 'string' }); setAddOpen(false); } });
  const proposeEdit = useMutation({ mutationFn: () => api.codegraphEditPropose(node.id, instruction), onSuccess: setEditProposal });
  const applyEdit = useMutation({ mutationFn: (id: string) => api.codegraphEditApply(id), onSuccess: () => { invalidate(); setEditProposal(null); setInstruction(''); } });

  const commitCode = () => {
    const parts = [`DELETE WHERE { <${node.id}> rps:codeArtifact ?c }`, `DELETE WHERE { <${node.id}> rps:codeLanguage ?l }`, `DELETE WHERE { <${node.id}> rps:codeEntrypoint ?e }`];
    const trimmed = code.trim();
    if (trimmed) {
      let insert = `<${node.id}> rps:codeArtifact ${strlit(code)}^^xsd:string ; rps:codeLanguage ${strlit(language || 'python')}`;
      if (entrypoint.trim()) insert += ` ; rps:codeEntrypoint ${strlit(entrypoint.trim())}`;
      parts.push(`INSERT DATA { ${insert} }`);
    }
    saveCode.mutate(`PREFIX rps: <${NS}> PREFIX xsd: <${XSD}> ${parts.join('; ')}`);
  };
  const revertCode = () => { setCode(savedCode); setLanguage(savedLang); setEntrypoint(savedEntry); };
  const addParam = () => {
    const name = param.name.trim();
    if (!name) return;
    const piri = `${node.id}#param-${slug(name)}`;
    paramMutation.mutate(`PREFIX rps: <${NS}> INSERT DATA { <${node.id}> rps:hasParameter <${piri}> . <${piri}> a rps:Parameter ; rps:paramName ${strlit(name)} ; rps:paramDefault ${strlit(param.default)} ; rps:paramType ${strlit(param.type)} }`);
  };
  const deleteParam = (piri: string) => paramMutation.mutate(`PREFIX rps: <${NS}> DELETE WHERE { <${piri}> ?p ?o }; DELETE WHERE { <${node.id}> rps:hasParameter <${piri}> }`);
  const updateDefault = (piri: string, value: string) => paramMutation.mutate(`PREFIX rps: <${NS}> DELETE WHERE { <${piri}> rps:paramDefault ?o }; INSERT DATA { <${piri}> rps:paramDefault ${strlit(value)} }`);

  const saveSig = useMutation({ mutationFn: api.update, onSuccess: () => { qc.invalidateQueries({ queryKey: ['cg-sig', node.id] }); qc.invalidateQueries({ queryKey: ['pipeline'] }); } });
  const inferSig = useMutation({ mutationFn: () => api.codegraphInferSignature(node.id), onSuccess: data => { setSigInputs(data.inputs.map(a => ({ name: a.name ?? '', cls: a.classIri ?? '' }))); setSigOutput(data.output.classIri ?? ''); } });
  const commitSig = () => {
    const ops = [`DELETE WHERE { <${node.id}> rps:signatureInput ?a . ?a ?p ?o }`, `DELETE WHERE { <${node.id}> rps:signatureOutput ?a . ?a ?p ?o }`, `DELETE WHERE { <${node.id}> rps:signatureInput ?a }`, `DELETE WHERE { <${node.id}> rps:signatureOutput ?a }`];
    const ins: string[] = [];
    sigInputs.forEach((inp, i) => { if (!inp.cls) return; const a = `${node.id}#in-${i}`; ins.push(`<${node.id}> rps:signatureInput <${a}> . <${a}> a rps:SignatureArg ; rps:argName ${strlit(inp.name || `arg${i}`)} ; rps:argClass <${inp.cls}>`); });
    if (sigOutput) { const a = `${node.id}#out`; ins.push(`<${node.id}> rps:signatureOutput <${a}> . <${a}> a rps:SignatureArg ; rps:argClass <${sigOutput}>`); }
    if (ins.length) ops.push(`INSERT DATA { ${ins.join(' . ')} }`);
    saveSig.mutate(`PREFIX rps: <${NS}> ${ops.join('; ')}`);
  };

  const runInputs = inputArtifacts ?? [];
  const runCode = useMutation({
    mutationFn: () => api.codegraphExecute(code, language, entrypoint, runInputs),
    onSuccess: res => { setRunResult(res); if (res.outputs.length && onOutputs) onOutputs(res.outputs); },
  });

  const codeDirty = code !== savedCode || language !== savedLang || entrypoint !== savedEntry;

  return <section className="resource-section cg-panel">
    <div className="resource-section-title"><div><h3>Code artifact</h3><p>Standalone logic on this concept node — a code blob, tunable parameters, and a typed signature, stored in RDF.</p></div></div>
    <div className="inspector-tabs cg-panel-tabs">
      <button className={`inspector-tab${tab === 'code' ? ' active' : ''}`} onClick={() => setTab('code')}><Code2 size={13} />Code{savedCode ? ' ●' : ''}</button>
      <button className={`inspector-tab${tab === 'parameters' ? ' active' : ''}`} onClick={() => setTab('parameters')}><Settings2 size={13} />Parameters{params.length ? ` (${params.length})` : ''}</button>
      <button className={`inspector-tab${tab === 'signature' ? ' active' : ''}`} onClick={() => setTab('signature')}><Braces size={13} />Signature{hasSig ? ' ●' : ''}</button>
    </div>
    <div className="cg-panel-body">
      {tab === 'code' && <>
        <div className="cg-badge-row cg-interface-strip">{inputs.map((n, i) => <span key={`in${i}`} className="cg-chip cg-chip-in">in · {n}</span>)}{outputs.map((n, i) => <span key={`out${i}`} className="cg-chip cg-chip-out">out · {n}</span>)}{params.map(p => <span key={p.param} className="cg-chip">{p.name}={p.default || '—'}</span>)}</div>
        {savedCode && <form className="cg-prompt-edit" onSubmit={e => { e.preventDefault(); if (instruction.trim()) proposeEdit.mutate(); }}>
          <Wand2 size={15} className="cg-prompt-icon" />
          <input value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="Edit by prompt — e.g. set the smoothing epsilon to 0.3" disabled={proposeEdit.isPending || !!editProposal} />
          <button type="submit" disabled={!instruction.trim() || proposeEdit.isPending || !!editProposal}><Sparkles size={13} />{proposeEdit.isPending ? 'Proposing…' : 'Propose'}</button>
        </form>}
        {editProposal ? <>
          <div className="cg-diff-head"><GitCompareArrows size={14} /><span>Proposed edit · v{editProposal.fromVersion} → v{editProposal.toVersion}</span>{editProposal.unchanged && <span className="cg-chip cg-chip-warn">no change detected</span>}</div>
          {editProposal.explanation && <p className="cg-diff-explanation">{editProposal.explanation}</p>}
          {editProposal.newParams.length > 0 && <div className="cg-badge-row">Promotes to parameters: {editProposal.newParams.map(p => <span key={p.name} className="cg-chip cg-chip-code">{p.name}={p.default}</span>)}</div>}
          <div className="cg-panel-editor"><DiffEditor height="100%" language={(editProposal.language || 'python').toLowerCase()} theme={theme === 'dark' ? 'vs-dark' : 'light'} original={editProposal.previousCode} modified={editProposal.newCode} options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, renderSideBySide: false, readOnly: true, automaticLayout: true }} /></div>
          <div className="inspector-actions"><button disabled={editProposal.unchanged || applyEdit.isPending} onClick={() => applyEdit.mutate(editProposal.id)}><Check size={14} />{applyEdit.isPending ? 'Committing…' : 'Commit to graph'}</button><button className="secondary" onClick={() => setEditProposal(null)}><X size={14} />Discard</button></div>
          <p className="hint">Nothing is written until you commit — committing overwrites <code>rps:codeArtifact</code> and bumps <code>rps:artifactVersion</code>.</p>
        </> : <>
          <div className="cg-code-meta"><label>Language<input value={language} onChange={e => setLanguage(e.target.value)} placeholder="python" /></label><label>Entrypoint<input value={entrypoint} onChange={e => setEntrypoint(e.target.value)} placeholder="jaccard_similarity" /></label></div>
          <div className="cg-panel-editor"><Editor height="100%" language={(language || 'python').toLowerCase()} theme={theme === 'dark' ? 'vs-dark' : 'light'} value={code} onChange={v => setCode(v ?? '')} options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, wordWrap: 'on', automaticLayout: true }} /></div>
          <div className="inspector-actions"><button disabled={!codeDirty || saveCode.isPending} onClick={commitCode}><Save size={14} />{saveCode.isPending ? 'Saving…' : 'Save code'}</button><button className="secondary" disabled={!codeDirty} onClick={revertCode}><RotateCcw size={14} />Revert</button>{onOutputs && <button className="secondary" disabled={!code.trim() || runCode.isPending} title="Run this code locally with the File Explorer's input_artifacts files present; results are written to the output folder" onClick={() => runCode.mutate()}><Play size={14} />{runCode.isPending ? 'Running…' : `Run${runInputs.length ? ` · ${runInputs.length} input${runInputs.length > 1 ? 's' : ''}` : ''}`}</button>}</div>
          {runCode.error && <p className="cg-run-error">{runCode.error instanceof Error ? runCode.error.message : String(runCode.error)}</p>}
          {runResult && <div className={`cg-run-result${runResult.ok ? '' : ' failed'}`}>
            <div className="cg-run-head"><Terminal size={13} /><span>{runResult.timedOut ? 'Timed out' : runResult.ok ? 'Ran successfully' : `Exited with code ${runResult.returncode}`}</span><small>{runResult.durationMs} ms</small></div>
            {runResult.stdout && <pre className="cg-run-stream">{runResult.stdout}</pre>}
            {runResult.stderr && <pre className="cg-run-stream cg-run-stderr">{runResult.stderr}</pre>}
            {runResult.outputs.length > 0 && <div className="cg-run-outputs"><Check size={13} />Wrote {runResult.outputs.length} file{runResult.outputs.length > 1 ? 's' : ''} to the <strong>output</strong> folder: {runResult.outputs.map(o => o.filename).join(', ')}</div>}
          </div>}
          <p className="hint">Runs <code>python</code> in a temp dir with your <code>input_artifacts/</code> files present — read inputs from there and write results to <code>output/</code>. Dev-only: this executes code on your machine, not a sandbox.</p>
        </>}
      </>}
      {tab === 'parameters' && <>
        {params.length === 0 && !addOpen && <div className="section-empty">No parameters yet. Promote a hardcoded constant (e.g. <code>epsilon</code>) to a tunable knob.</div>}
        <div className="cg-params">{params.map(p => <div className="param-row" key={p.param}><span className="cg-param-name">{p.name}</span><input defaultValue={p.default} title="Default value" onBlur={e => { if (e.target.value !== p.default) updateDefault(p.param, e.target.value); }} /><span className="cg-chip">{compact(p.type)}</span><button className="icon-button danger-button" title="Delete parameter" disabled={paramMutation.isPending} onClick={() => deleteParam(p.param)}><Trash2 size={13} /></button></div>)}</div>
        {addOpen ? <div className="cg-add-param"><label>Name<input autoFocus value={param.name} onChange={e => setParam(c => ({ ...c, name: e.target.value }))} placeholder="epsilon" /></label><label>Default<input value={param.default} onChange={e => setParam(c => ({ ...c, default: e.target.value }))} placeholder="0.3" /></label><label>Type<select value={param.type} onChange={e => setParam(c => ({ ...c, type: e.target.value }))}>{PARAM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label><div className="inspector-actions"><button disabled={!param.name.trim() || paramMutation.isPending} onClick={addParam}>Add parameter</button><button className="secondary" onClick={() => setAddOpen(false)}>Cancel</button></div></div> : <div className="inspector-actions"><button className="secondary" onClick={() => setAddOpen(true)}><Plus size={14} />Add parameter</button></div>}
      </>}
      {tab === 'signature' && <>
        <div className="cg-row"><span className="cg-label">Typed signature</span><code className="cg-sig-summary">{sigSummary}</code></div>
        {!savedCode && <div className="section-empty">Add code in the Code tab first, then type its inputs and output.</div>}
        <div className="inspector-actions"><button className="secondary" disabled={!savedCode || inferSig.isPending} onClick={() => inferSig.mutate()}><Braces size={14} />{inferSig.isPending ? 'Inferring…' : 'Infer types from code'}</button></div>
        <div className="cg-row"><span className="cg-label">Inputs</span>
          <div className="cg-params">{sigInputs.map((inp, i) => <div className="param-row" key={i}>
            <input value={inp.name} placeholder={`arg${i}`} onChange={e => setSigInputs(cur => cur.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <select value={inp.cls} onChange={e => setSigInputs(cur => cur.map((x, j) => j === i ? { ...x, cls: e.target.value } : x))}><option value="">Type…</option>{classes.map(c => <option key={c.iri} value={c.iri}>{c.label}</option>)}</select>
            <span />
            <button className="icon-button danger-button" title="Remove input" onClick={() => setSigInputs(cur => cur.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
          </div>)}</div>
          <div className="inspector-actions"><button className="secondary" onClick={() => setSigInputs(cur => [...cur, { name: '', cls: '' }])}><Plus size={14} />Add input</button></div>
        </div>
        <div className="cg-row"><span className="cg-label">Output type</span><select value={sigOutput} onChange={e => setSigOutput(e.target.value)}><option value="">Type…</option>{classes.map(c => <option key={c.iri} value={c.iri}>{c.label}</option>)}</select></div>
        <div className="inspector-actions"><button disabled={saveSig.isPending} onClick={commitSig}><Save size={14} />{saveSig.isPending ? 'Saving…' : 'Save signature'}</button></div>
        <p className="hint">Each input and the output is typed with a class already defined in the ontology (<code>rps:argClass</code>) — only ontology classes appear in the dropdowns.</p>
      </>}
    </div>
  </section>;
}
