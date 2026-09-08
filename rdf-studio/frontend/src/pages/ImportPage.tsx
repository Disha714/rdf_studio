import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Database, Network } from 'lucide-react';
import { api } from '../api';
import { ErrorBox, Page } from '../components/Page';

const ontologyAccept='.ttl,.jsonld,.json,.rdf,.xml,.nt,.n3';
const pipelineAccept='.json,.ttl,.jsonld,.rdf,.xml,.nt,.n3';

export function ImportPage(){
  const qc=useQueryClient();
  const [ontologyFile,setOntologyFile]=useState<File>();
  const [pipelineFile,setPipelineFile]=useState<File>();
  const [replaceOntology,setReplaceOntology]=useState(false);
  const [replacePipeline,setReplacePipeline]=useState(false);
  const refresh=()=>qc.invalidateQueries();
  const ontology=useMutation({mutationFn:()=>api.importOntology(ontologyFile!,replaceOntology),onSuccess:refresh});
  const pipeline=useMutation({mutationFn:()=>api.importPipeline(pipelineFile!,replacePipeline),onSuccess:refresh});

  return <Page title="Import" description="Import ontology definitions and pipeline resources from RDF. Mixed RDF datasets are split into ontology and pipeline data automatically.">
    <div className="import-grid">
      <section className="card import-card">
        <div className="import-card-head"><div className="export-icon ontology-export"><Network/></div><div><h2>Import ontology / RDF dataset</h2><p>Use this for RDF/OWL class definitions. If the file also contains resources, valid pipeline resources are imported to the Pipeline canvas too.</p></div></div>
        <label>Ontology or dataset RDF file<input type="file" accept={ontologyAccept} onChange={e=>setOntologyFile(e.target.files?.[0])}/></label>
        <div className="import-help">Supported: Turtle, JSON-LD, RDF/XML, N-Triples, Notation3.</div>
        <label className="check"><input type="checkbox" checked={replaceOntology} onChange={e=>setReplaceOntology(e.target.checked)}/> Clear existing data before ontology import</label>
        <button disabled={!ontologyFile||ontology.isPending} onClick={()=>ontology.mutate()}>{ontology.isPending?'Importing ontology…':'Import ontology'}</button>
        <ErrorBox error={ontology.error}/>
        {ontology.data&&<div className="success">Imported {ontology.data.classes} class(es), {ontology.data.properties} propert{ontology.data.properties===1?'y':'ies'}, {ontology.data.ontologyTriples} ontology triples, and {ontology.data.resources} pipeline resource(s) from {ontology.data.filename}.{ontology.data.pipelineTriples?` Pipeline added ${ontology.data.pipelineTriples} triples.`:''}</div>}
      </section>

      <section className="card import-card">
        <div className="import-card-head"><div className="export-icon pipeline-export"><Database/></div><div><h2>Import pipeline</h2><p>Use this for pipeline resources and links. Referenced classes must already exist in the ontology, otherwise the import is blocked with a warning.</p></div></div>
        <label>Pipeline file<input type="file" accept={pipelineAccept} onChange={e=>setPipelineFile(e.target.files?.[0])}/></label>
        <div className="import-help">Supported: RDF Pipeline JSON export, JSON-LD, Turtle, RDF/XML, N-Triples, Notation3. A .json file can be either Pipeline JSON or JSON-LD.</div>
        <label className="check"><input type="checkbox" checked={replacePipeline} onChange={e=>setReplacePipeline(e.target.checked)}/> Clear existing pipeline resources before import</label>
        <button disabled={!pipelineFile||pipeline.isPending} onClick={()=>pipeline.mutate()}>{pipeline.isPending?'Importing pipeline…':'Import pipeline'}</button>
        <ErrorBox error={pipeline.error}/>
        {pipeline.data&&<div className="success">Imported {pipeline.data.resources} renderable resource(s) and {pipeline.data.triples} triples from {pipeline.data.filename}.</div>}
      </section>
    </div>
  </Page>;
}
