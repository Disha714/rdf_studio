import { useState } from 'react';
import { Braces, Download, Network } from 'lucide-react';
import { api } from '../api';
import { Page } from '../components/Page';

const rdfFormats = [['turtle', 'Turtle (.ttl)'], ['json-ld', 'JSON-LD (.jsonld)'], ['xml', 'RDF/XML (.rdf)'], ['nt', 'N-Triples (.nt)'], ['nquads', 'N-Quads (.nq)'], ['n3', 'Notation3 (.n3)']] as const;
const pipelineFormats = [['json', 'RDF Pipeline JSON (.json)'], ...rdfFormats] as const;

export function ExportPage() {
  const [pipelineFormat, setPipelineFormat] = useState('json'); const [ontologyFormat, setOntologyFormat] = useState('turtle');
  return <Page title="Export" description="Export ontology definitions separately from pipeline resources. The ontology export does not include pipeline resource instances."><div className="export-grid two-up">
    <section className="export-card card"><div className="export-icon ontology-export"><Network /></div><div><h2>Ontology only</h2><p>Classes and property definitions only: OWL classes, datatype properties, object properties, labels, comments, domains, and ranges. Pipeline resources are excluded.</p></div><label>Serialization<select value={ontologyFormat} onChange={e => setOntologyFormat(e.target.value)}>{rdfFormats.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><a className="button" href={api.ontologyExportUrl(ontologyFormat)}><Download size={17} />Download ontology</a></section>
    <section className="export-card card"><div className="export-icon pipeline-export"><Braces /></div><div><h2>Pipeline only</h2><p>Pipeline resources, values, links, canvas positions, arrow handles, used relationship definitions, and resource-specific properties. Ontology classes are excluded.</p></div><label>Serialization<select value={pipelineFormat} onChange={e => setPipelineFormat(e.target.value)}>{pipelineFormats.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><a className="button" href={api.pipelineExportUrl(pipelineFormat)}><Download size={17} />Download pipeline</a></section>
  </div></Page>
}
