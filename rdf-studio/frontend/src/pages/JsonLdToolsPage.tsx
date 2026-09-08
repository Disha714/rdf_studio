import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Frame, Table2 } from 'lucide-react';
import { api, compact, type JsonLdSource } from '../api';
import { ErrorBox, Page } from '../components/Page';

const DEFAULT_FRAME = `{
  "@context": {},
  "@type": []
}`;

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);
  return debouncedValue;
}

function SourceToggle({ source, setSource, document, setDocument }: { source: JsonLdSource; setSource: (s: JsonLdSource) => void; document: string; setDocument: (v: string) => void }) {
  return <div className="jsonld-source">
    <div className="jsonld-source-tabs">
      <button className={source === 'live' ? '' : 'secondary'} onClick={() => setSource('live')}>Live data</button>
      <button className={source === 'paste' ? '' : 'secondary'} onClick={() => setSource('paste')}>Paste JSON-LD</button>
    </div>
    {source === 'live'
      ? <p className="hint">Reads the ontology and pipeline resources currently stored in this workspace.</p>
      : <textarea className="jsonld-paste" value={document} onChange={e => setDocument(e.target.value)} placeholder='{"@context": {...}, "@type": "Person", "name": "Disha"}' spellCheck={false} />}
  </div>;
}

function TableTab({ source, document }: { source: JsonLdSource; document: string }) {
  const debouncedDocument = useDebounce(document, 500);
  const { data, error, isFetching } = useQuery({
    queryKey: ['jsonldTable', source, debouncedDocument],
    queryFn: () => api.jsonldTable(source, source === 'paste' ? debouncedDocument : undefined),
    enabled: source === 'live' || (source === 'paste' && !!debouncedDocument.trim())
  });

  return <div className="jsonld-tab">
    {isFetching && <div className="hint" style={{ marginBottom: '1rem' }}>Updating table...</div>}
    <ErrorBox error={error} />
    {data && (data.rows.length
      ? <div className="table-wrap jsonld-table-wrap"><table><thead><tr><th>Subject</th><th>Predicate</th><th>Object</th><th>Language</th><th>Datatype</th><th>Graph</th></tr></thead><tbody>
          {data.rows.map((row, i) => <tr key={i}>
            <td><code>{compact(row.subject)}</code></td>
            <td><code>{compact(row.predicate)}</code></td>
            <td>{row.object.startsWith('_:') || /^https?:\/\//.test(row.object) ? <code>{compact(row.object)}</code> : row.object}</td>
            <td>{row.language ?? ''}</td>
            <td>{row.datatype ? <code>{compact(row.datatype)}</code> : ''}</td>
            <td>{row.graph ?? ''}</td>
          </tr>)}
        </tbody></table></div>
      : <div className="empty">No triples found.</div>)}
  </div>;
}

function FramesTab({ source, document }: { source: JsonLdSource; document: string }) {
  const [frame, setFrame] = useState(DEFAULT_FRAME);
  const debouncedDocument = useDebounce(document, 500);
  const debouncedFrame = useDebounce(frame, 500);

  const { data, error, isFetching } = useQuery({
    queryKey: ['jsonldFrame', source, debouncedDocument, debouncedFrame],
    queryFn: () => api.jsonldFrame(source, debouncedFrame, source === 'paste' ? debouncedDocument : undefined),
    enabled: (source === 'live' || (source === 'paste' && !!debouncedDocument.trim())) && !!debouncedFrame.trim()
  });

  return <div className="jsonld-tab">
    <label className="jsonld-frame-label">Frame document<textarea className="jsonld-paste" value={frame} onChange={e => setFrame(e.target.value)} spellCheck={false} /></label>
    {isFetching && <div className="hint" style={{ marginBottom: '1rem' }}>Applying frame...</div>}
    <ErrorBox error={error} />
    {data && <pre className="result jsonld-frame-result">{JSON.stringify(data, null, 2)}</pre>}
  </div>;
}

export function JsonLdToolsPage() {
  const [tab, setTab] = useState<'table' | 'frames'>('table');
  const [source, setSource] = useState<JsonLdSource>('live');
  const [document, setDocument] = useState('');

  return <Page title="JSON-LD Tools" description="Table and Framed views, the same way the JSON-LD Playground shows them — run against your live data or a pasted document.">
    <div className="jsonld-tabs">
      <button className={tab === 'table' ? '' : 'secondary'} onClick={() => setTab('table')}><Table2 size={15} />Table</button>
      <button className={tab === 'frames' ? '' : 'secondary'} onClick={() => setTab('frames')}><Frame size={15} />Frames</button>
    </div>
    <SourceToggle source={source} setSource={setSource} document={document} setDocument={setDocument} />
    {tab === 'table' ? <TableTab source={source} document={document} /> : <FramesTab source={source} document={document} />}
  </Page>;
}
