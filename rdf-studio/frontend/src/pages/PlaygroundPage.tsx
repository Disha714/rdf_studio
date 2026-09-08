import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addEdge, applyEdgeChanges, applyNodeChanges, Background, BaseEdge, ConnectionMode, Handle, MarkerType, Position, ReactFlow, type Connection, type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { DiffEditor } from '@monaco-editor/react';
import { Check, ChevronDown, ChevronRight, Download, File as FileIcon, FileCode2, FolderOpen, GitBranch, GitCompareArrows, Link2, MessageSquareText, Moon, Paperclip, Plus, RotateCcw, Save, Send, Shapes, Sun, Trash2, UploadCloud, Wand2, X } from 'lucide-react';
import { api, compact, displayName, type Binding, type ChatAction, type ChatTurn, type ClarificationQuestion, type ClassProposal, type ClassProposalResponse, type CodeEditProposal, type ExecOutput, type LlmProvider, type MetricUpdate, type Proposal, type ProposedInstance, type ProposedLink, type ProposedProperty, type ProposedPropertyValue, type UploadedScript } from '../api';
import { GENERATED_PREFIX, fetchExternalNodeInfo, mergeExternalNodeInfo, proposalToMatrixResources, type JsonLdNode } from '../aiGraph';
import { ErrorBox, Page } from '../components/Page';
import { CodeArtifactPanel } from '../components/CodeArtifactPanel';
import { OWL, cleanLocal, datatypeOptions, shortRange, validLocal } from '../ontology';
import { useTheme } from '../theme';
import { MatrixHybridGraph, type MatrixFact, type MatrixResource } from './PipelinePage';

const PLAYGROUND_QUERY = `PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?node ?type ?typeLabel ?label ?comment ?p ?target ?targetLabel ?targetType ?targetTypeLabel WHERE {
  ?type a owl:Class .
  ?node a ?type .
  FILTER(?node != ?type)
  OPTIONAL { ?type rdfs:label ?typeLabel }
  OPTIONAL { ?node rdfs:label ?label }
  OPTIONAL { ?node rdfs:comment ?comment }
  OPTIONAL {
    ?node ?p ?target .
    FILTER(isIRI(?target))
    FILTER(?p NOT IN (rdf:type, rdfs:label, rdfs:comment))
    OPTIONAL { ?target rdfs:label ?targetLabel }
    OPTIONAL {
      ?target a ?targetType .
      ?targetType a owl:Class .
      FILTER(?target != ?targetType)
      OPTIONAL { ?targetType rdfs:label ?targetTypeLabel }
    }
  }
}
ORDER BY ?typeLabel ?type ?label ?node ?p`;
const NS='https://w3id.org/rdf-pipeline-studio#';
const XSD='http://www.w3.org/2001/XMLSchema#';
const TEXTAREA_TYPE=`${NS}TextArea`;
const DCTERMS='http://purl.org/dc/terms/';
const RDFS_COMMENT='http://www.w3.org/2000/01/rdf-schema#comment';
const CLASSES_QUERY=`PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> SELECT ?class ?label WHERE { ?class a owl:Class . OPTIONAL { ?class rdfs:label ?label } } ORDER BY ?label ?class`;
const PROPERTIES_QUERY=`PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> SELECT ?property ?label WHERE { ?property a owl:ObjectProperty . FILTER NOT EXISTS { ?property rdfs:domain ?classPropertyDomain } OPTIONAL { ?property rdfs:label ?label } } ORDER BY ?label ?property`;
const CLASS_DRAFT_SCHEMA_QUERY=(classIri:string)=>`PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX rps: <${NS}> SELECT ?property ?label ?datatype ?widget ?required ?multiple ?classComment ?classDescription WHERE {
  <${classIri}> rdfs:subClassOf* ?definingClass .
  ?property a owl:DatatypeProperty ; rdfs:domain ?definingClass .
  OPTIONAL { ?property rdfs:label ?label }
  OPTIONAL { ?property rdfs:range ?datatype }
  OPTIONAL { ?property rps:uiWidget ?widget }
  OPTIONAL { ?property rps:required ?required }
  OPTIONAL { ?property rps:multiple ?multiple }
  OPTIONAL { <${classIri}> rdfs:comment ?classComment }
  OPTIONAL { <${classIri}> <${DCTERMS}description> ?classDescription }
} ORDER BY ?label ?property`;
const RESOURCE_SCHEMA_QUERY=(resource:string)=>`PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX rps: <${NS}> SELECT ?property ?valueKind ?scope ?label ?datatype ?widget ?required ?multiple ?range ?value WHERE {
  {
    <${resource}> a ?class . ?class rdfs:subClassOf* ?definingClass .
    { ?property a owl:DatatypeProperty ; rdfs:domain ?definingClass . BIND("literal" AS ?valueKind) BIND("class" AS ?scope) }
    UNION
    { ?property a owl:ObjectProperty ; rdfs:domain ?definingClass . BIND("resource" AS ?valueKind) BIND("class" AS ?scope) FILTER NOT EXISTS { ?property rps:globalRelationship true } }
  }
  UNION
  {
    { ?property a owl:DatatypeProperty ; rps:resourceDomain <${resource}> . BIND("literal" AS ?valueKind) BIND("resource" AS ?scope) }
    UNION
    { ?property a owl:ObjectProperty ; rps:resourceDomain <${resource}> . BIND("resource" AS ?valueKind) BIND("resource" AS ?scope) }
  }
  OPTIONAL { ?property rdfs:label ?label }
  OPTIONAL { ?property rdfs:range ?range }
  OPTIONAL { ?property rdfs:range ?datatype }
  OPTIONAL { ?property rps:uiWidget ?widget }
  OPTIONAL { ?property rps:required ?required }
  OPTIONAL { ?property rps:multiple ?multiple }
  OPTIONAL { <${resource}> ?property ?value }
} ORDER BY ?label ?property`;
const RESOURCE_META_QUERY=(resource:string)=>`PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX dcterms: <${DCTERMS}>
SELECT ?class ?classLabel ?resourceComment ?resourceDescription ?classComment ?classDescription WHERE {
  <${resource}> a ?class .
  ?class a owl:Class .
  FILTER(<${resource}> != ?class)
  OPTIONAL { ?class rdfs:label ?classLabel }
  OPTIONAL { <${resource}> rdfs:comment ?resourceComment }
  OPTIONAL { <${resource}> dcterms:description ?resourceDescription }
  OPTIONAL { ?class rdfs:comment ?classComment }
  OPTIONAL { ?class dcterms:description ?classDescription }
} LIMIT 1`;

type PlaygroundMode = 'home' | 'select' | 'create' | 'generated' | 'imported' | 'suggest';
type PlaygroundLink = { predicate: string; label: string; target: string; targetLabel: string; targetType: string; targetTypeIri: string };
type PlaygroundResource = { id: string; label: string; type: string; typeLabel: string; comment: string; links: PlaygroundLink[] };
type PlaygroundFolder = 'root' | 'input_artifacts' | 'output';
type PlaygroundArtifact = { id: string; file: File; folder: PlaygroundFolder };
type AttributeDef={iri:string;label:string;datatype:string;range:string;valueKind:'literal'|'resource';resourceSpecific:boolean;required:boolean;multiple:boolean;widget:string;values:string[]};
type ResourcePropertyDraft={name:string;label:string;typeIri:string;value:string};
type AppliedCodeChange={kind:'editCode';status:'applied'|'reverted'|'error';proposalId:string;iri:string;label:string;language:string;previousCode:string;newCode:string;fromVersion:number;toVersion:number;why:string;error?:string};
type AppliedOntologyChange={kind:'modifyOntology';status:'applied'|'reverted'|'error';proposalId:string;targetStageLabel:string;previousComment:string;updatedComment:string;metricUpdate:MetricUpdate;why:string;error?:string};
// Unlike the two above, a class proposal is NOT applied when the chat turn completes: it
// stays 'pending' until the user reviews and approves it. 'reuse' means an existing class
// already covers the request AND no new instance was asked for either, so there is
// nothing to approve at all - a reuse that also adds a new node is 'pending' instead,
// since that node still needs review before it reaches Fuseki.
type ProposedClassChange={kind:'createClass';status:'pending'|'approved'|'reuse'|'error';result:ClassProposalResponse|null;why:string;error?:string};
type AppliedChange=AppliedCodeChange|AppliedOntologyChange|ProposedClassChange;
type ChatMessage={id:string;role:'assistant'|'user';text:string;questions?:ClarificationQuestion[];applied?:AppliedChange[]};
type PropertyRow={property:{value:string};label?:{value:string}};

const providerModels:Record<LlmProvider,string[]>={
  openai:['gpt-4.1','gpt-4.1-mini','gpt-4o','gpt-4o-mini','o3','o4-mini'],
  anthropic:['claude-3-5-sonnet-latest','claude-3-5-haiku-latest','claude-3-opus-latest'],
  ollama:['llama3.1','llama3.2','mistral','qwen2.5-coder','codellama'],
  llm:['gpt-20b:latest'],
};

const sampleResource: PlaygroundResource = {
  id: 'playground:draft',
  label: 'build_gtfs_route_schedule',
  type: 'Analytical Process',
  typeLabel: 'Analytical Process',
  comment: 'Draft pipeline preview. Operations will be wired later.',
  links: [
    { predicate: 'hasInput', label: 'hasInput', target: 'playground:gtfs', targetLabel: 'GTFS Feed', targetType: 'Source of Record', targetTypeIri: 'Source of Record' },
    { predicate: 'hasOutput', label: 'hasOutput', target: 'playground:schedule', targetLabel: 'gtfs_route_schedule.json', targetType: 'Intermediate Product', targetTypeIri: 'Intermediate Product' },
    { predicate: 'isIntermediateProcessto', label: 'isIntermediateProcessto', target: 'playground:alternate', targetLabel: 'build_route_alternates', targetType: 'Analytical Process', targetTypeIri: 'Analytical Process' },
  ],
};

function rowsToResources(rows: Binding[]): PlaygroundResource[] {
  const map = new Map<string, PlaygroundResource>();
  for (const row of rows) {
    const id = row.node?.value;
    if (!id) continue;
    const resource = map.get(id) ?? {
      id,
      label: displayName(id, row.label?.value),
      type: row.type?.value ?? '',
      typeLabel: displayName(row.type?.value ?? '', row.typeLabel?.value),
      comment: row.comment?.value ?? '',
      links: [],
    };
    if (row.p?.value && row.target?.value) {
      const link = {
        predicate: row.p.value,
        label: displayName(row.p.value),
        target: row.target.value,
        targetLabel: displayName(row.target.value, row.targetLabel?.value),
        targetType: displayName(row.targetType?.value ?? 'Resource', row.targetTypeLabel?.value),
        targetTypeIri: row.targetType?.value ?? row.targetTypeLabel?.value ?? '',
      };
      if (!resource.links.some(item => item.predicate === link.predicate && item.target === link.target)) resource.links.push(link);
    }
    map.set(id, resource);
  }
  return [...map.values()].sort((a, b) => {
    const processA = a.typeLabel.toLowerCase().includes('process') ? 0 : 1;
    const processB = b.typeLabel.toLowerCase().includes('process') ? 0 : 1;
    return processA - processB || a.label.localeCompare(b.label);
  });
}

// crypto.randomUUID only exists in a secure context (https / localhost). Over a LAN IP
// it is undefined and throws, which silently broke uploads - fall back to a random id.
let __uidCounter = 0;
const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${(++__uidCounter).toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

const fileSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};
const firstText=(...values:(string|undefined)[])=>values.find(value=>value?.trim())?.trim()??'';
const literal=(value:string)=>`"${value.replaceAll('\\','\\\\').replaceAll('"','\\"')}"`;
const typedLiteral=(value:string,datatype:string)=>`${literal(value)}^^<${datatype}>`;
const actualDatatype=(datatype:string)=>datatype===TEXTAREA_TYPE?`${XSD}string`:datatype;
const typeLabel=(iri:string)=>iri===TEXTAREA_TYPE?'TextArea':iri.startsWith(XSD)?`xsd:${iri.slice(XSD.length)}`:compact(iri);
const propertyLocal=(value:string)=>value.trim().replace(/[^A-Za-z0-9._~-]/g,'');
const classRowsLabel=(classIri:string,classLabels:Map<string,string>,resources:MatrixResource[])=>classLabels.get(classIri)??resources.find(resource=>resource.classIri===classIri)?.classLabel??compact(classIri);
const relationshipColor=(iri:string,light:boolean)=>{const palettes=light?['#1d4ed8','#0f766e','#b45309','#be185d','#6d28d9','#047857']:['#7da2ff','#4dd4c6','#f6b94a','#f178ad','#ad8aff','#43c99a'];let hash=0;for(const char of iri)hash=(hash*31+char.charCodeAt(0))|0;return palettes[Math.abs(hash)%palettes.length]};
const nodeColor=(index:number,light:boolean)=>{const palettes=light?['#2563eb','#0f766e','#7c3aed','#b45309','#be185d','#047857','#0369a1','#a16207']:['#4f7cff','#1aa99a','#9b74ff','#d89124','#df4e87','#25a66f','#23a6d5','#c9a227'];return palettes[index%palettes.length]};
const relationPredicate=(edge:Edge)=>String(edge.data?.predicate??edge.id.split('|')[1]??`${NS}hasInput`);
const relationLabelFromRows=(iri:string,rows:PropertyRow[])=>rows.find(row=>row.property.value===iri)?.label?.value??compact(iri);

function DraftPipelineNode({data}:NodeProps){return <><Handle id="bottom" type="source" position={Position.Bottom} title="Connect relationship"/><Handle id="top" type="target" position={Position.Top} title="Connect relationship"/><Handle id="left" type="source" position={Position.Left} title="Connect relationship"/><Handle id="right" type="target" position={Position.Right} title="Connect relationship"/><div className="pipeline-node-content"><strong>{String(data.label)}</strong><small>{String(data.type)}</small></div></>}
const draftNodeTypes={pipeline:DraftPipelineNode};
function DraftRelationshipEdge({sourceX,sourceY,targetX,targetY,label,labelStyle,style,markerEnd,data,selected}:EdgeProps){
  const offset=Number(data?.parallelOffset??25);const dx=targetX-sourceX;const dy=targetY-sourceY;const length=Math.max(Math.hypot(dx,dy),1);const controlX=(sourceX+targetX)/2-dy/length*offset;const controlY=(sourceY+targetY)/2+dx/length*offset;const path=`M ${sourceX},${sourceY} Q ${controlX},${controlY} ${targetX},${targetY}`;const labelX=.25*sourceX+.5*controlX+.25*targetX;const labelY=.25*sourceY+.5*controlY+.25*targetY;
  return <BaseEdge path={path} label={label} labelX={labelX} labelY={labelY} labelStyle={labelStyle} labelShowBg labelBgPadding={[7,4]} labelBgBorderRadius={5} style={{...style,strokeWidth:selected?3:style?.strokeWidth}} markerEnd={markerEnd} interactionWidth={28}/>;
}
const draftEdgeTypes={relationship:DraftRelationshipEdge};
function arrangeParallelEdges(edges:Edge[]){const groups=new Map<string,Edge[]>();for(const edge of edges){const key=`${edge.source}|${edge.target}`;groups.set(key,[...(groups.get(key)??[]),edge])}return edges.map(edge=>{const siblings=groups.get(`${edge.source}|${edge.target}`)!.sort((a,b)=>a.id.localeCompare(b.id));const index=siblings.findIndex(item=>item.id===edge.id);return{...edge,data:{...edge.data,parallelOffset:25+(index-(siblings.length-1)/2)*65}}})}

function formatPythonLikeCode(text:string){
  let value=text.trim();
  value=value.replace(/\s+(?=(?:from|import)\s+[A-Za-z_][\w.]*(?:\s+import)?)/g,'\n');
  value=value.replace(/\s+(?=def\s+[A-Za-z_]\w*\()/g,'\n\n');
  value=value.replace(/\s+(?=class\s+[A-Za-z_]\w*)/g,'\n\n');
  value=value.replace(/\s+(?=(?:for|if|elif|else|with|try|except|return|print)\b)/g,'\n');
  return value;
}

function ChatText({ text }: { text: string }) {
  const looksLikeCode=/\b(import|from|def|class|return|with|for|if|elif|else|try|except)\b|[{()}[\];=]|\n\s{2,}/.test(text);
  if(looksLikeCode)return <pre className="playground-chat-code">{formatPythonLikeCode(text)}</pre>;
  return <p>{text}</p>;
}

function graphModel(resources: PlaygroundResource[]) {
  const matrix = new Map<string, MatrixResource>();
  const ensure = (id: string, label: string, classLabel: string, classIri: string, comment = '') => {
    const found = matrix.get(id);
    if (found) return found;
    const created: MatrixResource = { id, label, classLabel, classIri, resourceComment: comment, classComment: '', facts: [] };
    matrix.set(id, created);
    return created;
  };
  for (const resource of resources) ensure(resource.id, resource.label, resource.typeLabel, resource.type || resource.typeLabel, resource.comment);
  for (const resource of resources) {
    const source = ensure(resource.id, resource.label, resource.typeLabel, resource.type || resource.typeLabel, resource.comment);
    for (const link of resource.links) {
      const target = ensure(link.target, link.targetLabel, link.targetType, link.targetTypeIri || link.targetType);
      const outFact: MatrixFact = { predicate: link.predicate, predicateLabel: link.label, value: target.id, valueLabel: target.label, valueType: 'uri', valueClassIri: target.classIri, valueClassLabel: target.classLabel, direction: 'out' };
      const inFact: MatrixFact = { predicate: link.predicate, predicateLabel: link.label, value: source.id, valueLabel: source.label, valueType: 'uri', valueClassIri: source.classIri, valueClassLabel: source.classLabel, direction: 'in' };
      if (!source.facts.some(fact => fact.direction === outFact.direction && fact.predicate === outFact.predicate && fact.value === outFact.value)) source.facts.push(outFact);
      if (!target.facts.some(fact => fact.direction === inFact.direction && fact.predicate === inFact.predicate && fact.value === inFact.value)) target.facts.push(inFact);
    }
  }
  const items = [...matrix.values()];
  const nodes: Node[] = items.map((resource, index) => ({ id: resource.id, position: { x: (index % 5) * 260, y: Math.floor(index / 5) * 150 }, data: { label: resource.label, type: resource.classLabel, typeIri: resource.classIri } }));
  const edges: Edge[] = resources.flatMap(resource => resource.links.map(link => ({ id: `${resource.id}|${link.predicate}|${link.target}`, source: resource.id, target: link.target, data: { predicate: link.predicate } } as Edge)));
  return { resources: items, nodes, edges };
}

function PlaygroundResourceViewer({ resource, resources, theme, onClose, inputArtifacts, onOutputs }: { resource: MatrixResource; resources: MatrixResource[]; theme: 'dark' | 'light'; onClose: () => void; inputArtifacts: File[]; onOutputs: (outputs: ExecOutput[]) => void }) {
  const qc=useQueryClient();
  const classes=useQuery({queryKey:['ontology-classes'],queryFn:()=>api.query(CLASSES_QUERY)});
  const resourceDetails=useQuery({queryKey:['playground-resource',resource.id],queryFn:()=>api.query(RESOURCE_SCHEMA_QUERY(resource.id)),enabled:!!resource.id});
  const resourceMeta=useQuery({queryKey:['playground-resource-meta',resource.id],queryFn:()=>api.query(RESOURCE_META_QUERY(resource.id)),enabled:!!resource.id});
  const classRows=classes.data?.type==='result'?classes.data.results?.bindings??[]:[];
  const detailRows=resourceDetails.data?.type==='result'?resourceDetails.data.results?.bindings??[]:[];
  const metaRow=resourceMeta.data?.type==='result'?resourceMeta.data.results?.bindings?.[0]:undefined;
  const resourceComment=firstText(metaRow?.resourceComment?.value,metaRow?.resourceDescription?.value,resource.resourceComment);
  const classComment=firstText(metaRow?.classComment?.value,metaRow?.classDescription?.value,resource.classComment);
  const [attributeDraft,setAttributeDraft]=useState<Record<string,string>>({});
  const [resourceDescriptionDraft,setResourceDescriptionDraft]=useState(resourceComment);
  const [propertyFormOpen,setPropertyFormOpen]=useState(false);
  const [resourceProperty,setResourceProperty]=useState<ResourcePropertyDraft>({name:'',label:'',typeIri:`${XSD}string`,value:''});
  const save=useMutation({mutationFn:api.update,onSuccess:()=>{qc.invalidateQueries({queryKey:['playground-resources']});qc.invalidateQueries({queryKey:['playground-resource']});qc.invalidateQueries({queryKey:['playground-resource-meta']});qc.invalidateQueries({queryKey:['pipeline']});qc.invalidateQueries({queryKey:['pipeline-matrix']});}});
  const attributes=[...detailRows.reduce((map,row)=>{const iri=row.property?.value;if(!iri)return map;const valueKind=row.valueKind?.value==='resource'?'resource':'literal';const widget=row.widget?.value??'';const item=map.get(iri)??{iri,label:row.label?.value??compact(iri),datatype:widget==='textarea'?TEXTAREA_TYPE:row.datatype?.value??`${XSD}string`,range:row.range?.value??'',valueKind,resourceSpecific:row.scope?.value==='resource',required:row.required?.value==='true',multiple:row.multiple?.value==='true',widget,values:[]};if(row.value&&!item.values.includes(row.value.value))item.values.push(row.value.value);map.set(iri,item);return map},new Map<string,AttributeDef>()).values()];
  const propertyTypeOptions=[...datatypeOptions,...classRows.map(row=>row.class.value)];
  useEffect(()=>{setResourceDescriptionDraft(resourceComment)},[resource.id,resourceComment]);
  useEffect(()=>{const next:Record<string,string>={};for(const attribute of attributes)next[attribute.iri]=attribute.multiple?attribute.values.join('\n'):attribute.values[0]??'';setAttributeDraft(next)},[resource.id,resourceDetails.data]);
  const changeResourceClass=(classIri:string)=>{if(!classIri||classIri===(metaRow?.class?.value??resource.classIri))return;save.mutate(`PREFIX owl: <http://www.w3.org/2002/07/owl#> DELETE { <${resource.id}> a ?oldClass } WHERE { <${resource.id}> a ?oldClass . ?oldClass a owl:Class }; INSERT DATA { <${resource.id}> a <${classIri}> }`)};
  const saveResourceDescription=()=>{const value=resourceDescriptionDraft.trim();const operations=[`DELETE WHERE { <${resource.id}> <http://www.w3.org/2000/01/rdf-schema#comment> ?oldComment }`,`DELETE WHERE { <${resource.id}> <${DCTERMS}description> ?oldDescription }`];if(value)operations.push(`INSERT DATA { <${resource.id}> <http://www.w3.org/2000/01/rdf-schema#comment> ${literal(value)} }`);save.mutate(operations.join('; '))};
  const saveAttributes=()=>{const missing=attributes.find(attribute=>attribute.required&&!attributeDraft[attribute.iri]?.trim());if(missing){window.alert(`${missing.label} is required.`);return}const deletes=attributes.map(attribute=>`DELETE WHERE { <${resource.id}> <${attribute.iri}> ?value }`);const triples=attributes.flatMap(attribute=>{const raw=attributeDraft[attribute.iri]??'';const values=attribute.multiple?raw.split('\n').map(value=>value.trim()).filter(Boolean):raw.trim()?[raw.trim()]:[];return values.map(value=>`<${resource.id}> <${attribute.iri}> ${attribute.valueKind==='resource'?`<${value}>`:typedLiteral(value,actualDatatype(attribute.datatype))}`)});const insert=triples.length?`INSERT DATA { ${triples.join(' . ')} . }`:'';save.mutate([...deletes,insert].filter(Boolean).join('; '))};
  const deleteResourceProperty=(attribute:AttributeDef)=>{if(!attribute.resourceSpecific)return;if(!window.confirm(`Delete resource-specific property “${attribute.label}”? Its values on this resource will also be removed.`))return;save.mutate(`PREFIX rps: <${NS}> DELETE WHERE { <${attribute.iri}> ?p ?o }; DELETE WHERE { <${resource.id}> <${attribute.iri}> ?value }; DELETE WHERE { ?connection <http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate> <${attribute.iri}> ; ?cp ?co }`)};
  const createResourceProperty=()=>{const local=propertyLocal(resourceProperty.name);if(!validLocal(local)){window.alert('Property name must start with a letter or underscore.');return}const propertyIri=`${resource.id}#${local}`;const isTextarea=resourceProperty.typeIri===TEXTAREA_TYPE;const isResourceType=!resourceProperty.typeIri.startsWith(XSD)&&!isTextarea;const value=resourceProperty.value.trim();const valueTriple=value?`<${resource.id}> <${propertyIri}> ${isResourceType?`<${value}>`:typedLiteral(value,actualDatatype(resourceProperty.typeIri))} .`:'';const kind=isResourceType?'owl:ObjectProperty':'owl:DatatypeProperty';const widgetTriple=isTextarea?`; rps:uiWidget "textarea"`:'';save.mutate(`PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX rps: <${NS}> INSERT DATA { <${propertyIri}> a ${kind} ; rps:resourceDomain <${resource.id}> ; rdfs:label ${literal(resourceProperty.label.trim()||local)} ; rdfs:range <${actualDatatype(resourceProperty.typeIri)}> ${widgetTriple} . ${valueTriple} }`,{onSuccess:()=>{setResourceProperty({name:'',label:'',typeIri:`${XSD}string`,value:''});setPropertyFormOpen(false)}})};
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal resource-editor-modal playground-resource-modal" role="dialog" aria-modal="true" aria-labelledby="playground-resource-title">
      <div className="modal-header"><div><h2 id="playground-resource-title">{resource.label}</h2><p>{resource.classLabel} · Edit RDF properties</p></div><button className="icon-button" title="Close" onClick={onClose}><X size={19}/></button></div>
      <div className="resource-editor-body">
        <div className="resource-class-selector"><label>Ontology class<select value={metaRow?.class?.value??resource.classIri} disabled={save.isPending} onChange={event=>changeResourceClass(event.target.value)}>{classRows.map(row=><option key={row.class.value} value={row.class.value}>{row.label?.value??compact(row.class.value)} — {compact(row.class.value)}</option>)}</select></label><p>Changing the class refreshes the available properties. Existing RDF values are retained.</p></div>
        <div className="resource-comment-grid"><section className="resource-description-editor"><div><span>Resource description</span><p>Saved on this resource as RDF comment metadata.</p></div><textarea value={resourceDescriptionDraft} onChange={event=>setResourceDescriptionDraft(event.target.value)} placeholder="Describe this pipeline resource…"/><button className="secondary" disabled={save.isPending||resourceDescriptionDraft.trim()===resourceComment} onClick={saveResourceDescription}><Save size={15}/>Save description</button></section><section><span>Class description</span><p>{classComment || 'No class description is present.'}</p></section></div>
        <section className="resource-section"><div className="resource-section-title"><div><h3>Properties</h3><p>Values are stored directly on this RDF resource. Class-valued properties use another resource as the value.</p></div><div className="resource-section-actions"><button className="secondary" onClick={()=>setPropertyFormOpen(value=>!value)}><Plus size={15}/>{propertyFormOpen?'Cancel':'Add resource property'}</button><button disabled={save.isPending} onClick={saveAttributes}><Save size={15}/>Save properties</button></div></div>
          {propertyFormOpen&&<div className="resource-specific-property"><label>Property name<input value={resourceProperty.name} onChange={event=>setResourceProperty(current=>({...current,name:propertyLocal(event.target.value)}))} placeholder="approvalStatus"/></label><label>Label<input value={resourceProperty.label} onChange={event=>setResourceProperty(current=>({...current,label:event.target.value}))} placeholder="Approval status"/></label><label>Type<select value={resourceProperty.typeIri} onChange={event=>setResourceProperty(current=>({...current,typeIri:event.target.value,value:''}))}>{propertyTypeOptions.map(option=><option key={option} value={option}>{typeLabel(option)}</option>)}</select></label>{resourceProperty.typeIri===TEXTAREA_TYPE?<label className="resource-specific-wide">Initial value<textarea value={resourceProperty.value} onChange={event=>setResourceProperty(current=>({...current,value:event.target.value}))} placeholder="Paste long text or code…"/></label>:resourceProperty.typeIri.startsWith(XSD)?<label>Initial value<input value={resourceProperty.value} onChange={event=>setResourceProperty(current=>({...current,value:event.target.value}))}/></label>:<label>Initial value<select value={resourceProperty.value} onChange={event=>setResourceProperty(current=>({...current,value:event.target.value}))}><option value="">Not set</option>{resources.filter(item=>item.id!==resource.id&&item.classIri===resourceProperty.typeIri).map(item=><option key={item.id} value={item.id}>{item.label} — {item.classLabel}</option>)}</select></label>}<button disabled={save.isPending} onClick={createResourceProperty}>Create property</button></div>}
          <div className="resource-fields">{resourceDetails.isLoading?<div className="section-empty">Loading class definition…</div>:attributes.length===0?<div className="section-empty">This class has no properties.</div>:attributes.map(attribute=>{const resourceCandidates=resources.filter(item=>item.id!==resource.id&&(!attribute.range||item.classIri===attribute.range));return <label key={attribute.iri}>{attribute.label}{attribute.resourceSpecific?<button type="button" className="icon-button danger-button property-delete-button" title="Delete resource-specific property" disabled={save.isPending} onClick={event=>{event.preventDefault();deleteResourceProperty(attribute)}}><Trash2 size={13}/></button>:attribute.required&&<strong>Required</strong>}{attribute.valueKind==='resource'?<select value={attributeDraft[attribute.iri]??''} onChange={event=>setAttributeDraft(current=>({...current,[attribute.iri]:event.target.value}))}><option value="">Not set</option>{resourceCandidates.map(item=><option key={item.id} value={item.id}>{item.label} — {item.classLabel}</option>)}</select>:attribute.multiple||attribute.widget==='textarea'?<textarea value={attributeDraft[attribute.iri]??''} onChange={event=>setAttributeDraft(current=>({...current,[attribute.iri]:event.target.value}))} placeholder={attribute.multiple?'One value per line':'Paste long text or code…'}/>:attribute.datatype.endsWith('#boolean')?<select value={attributeDraft[attribute.iri]??''} onChange={event=>setAttributeDraft(current=>({...current,[attribute.iri]:event.target.value}))}><option value="">Not set</option><option value="true">True</option><option value="false">False</option></select>:<input type={attribute.datatype.endsWith('#date')?'date':attribute.datatype.endsWith('#dateTime')?'datetime-local':attribute.datatype.endsWith('#integer')||attribute.datatype.endsWith('#decimal')?'number':'text'} value={attributeDraft[attribute.iri]??''} onChange={event=>setAttributeDraft(current=>({...current,[attribute.iri]:event.target.value}))}/>}<small>{attribute.resourceSpecific?'Resource-specific · ':''}{attribute.valueKind==='resource'?(attribute.range?`Resource: ${compact(attribute.range)}`:'Resource') : typeLabel(attribute.datatype)}{attribute.multiple?' · multiple values':''}</small></label>})}</div>
        </section>
        <CodeArtifactPanel node={{ id: resource.id, label: resource.label, type: resource.classLabel }} theme={theme} inputArtifacts={inputArtifacts} onOutputs={onOutputs} />
      </div>
      <div className="modal-footer"><button className="secondary" onClick={onClose}>Close</button></div>
    </div>
  </div>;
}

function PlaygroundPreviewResourceViewer({ resource, resources, onSave, onClose }: { resource: MatrixResource; resources: MatrixResource[]; onSave: (id:string, classIri:string, comment:string, facts:MatrixFact[]) => void; onClose: () => void }) {
  const classes=useQuery({queryKey:['ontology-classes'],queryFn:()=>api.query(CLASSES_QUERY)});
  const classRows=classes.data?.type==='result'?classes.data.results?.bindings??[]:[];
  const literalFacts=resource.facts.filter(fact=>fact.direction==='out'&&fact.valueType!=='uri');
  const [classDraft,setClassDraft]=useState(resource.classIri);
  const schema=useQuery({queryKey:['playground-draft-class-schema',classDraft],queryFn:()=>api.query(CLASS_DRAFT_SCHEMA_QUERY(classDraft)),enabled:!!classDraft});
  const schemaRows=schema.data?.type==='result'?schema.data.results?.bindings??[]:[];
  const schemaPredicates=new Set(schemaRows.map(row=>row.property?.value).filter(Boolean));
  const schemaAttributes=[...schemaRows.reduce((map,row)=>{const iri=row.property?.value;if(!iri)return map;const item=map.get(iri)??{iri,label:row.label?.value??compact(iri),datatype:row.widget?.value==='textarea'?TEXTAREA_TYPE:row.datatype?.value??`${XSD}string`,range:'',valueKind:'literal' as const,resourceSpecific:false,required:row.required?.value==='true',multiple:row.multiple?.value==='true',widget:row.widget?.value??'',values:[]};map.set(iri,item);return map},new Map<string,AttributeDef>()).values()];
  const customFacts=literalFacts.filter(fact=>fact.predicate.includes(`${resource.id}#`)||!schemaPredicates.has(fact.predicate));
  const attributes=[...schemaAttributes,...customFacts.filter((fact,index,self)=>self.findIndex(item=>item.predicate===fact.predicate)===index).map(fact=>({iri:fact.predicate,label:fact.predicateLabel,datatype:fact.valueType.startsWith('http')?fact.valueType:`${XSD}string`,range:'',valueKind:'literal' as const,resourceSpecific:true,required:false,multiple:false,widget:'',values:[fact.value]}))];
  const [descriptionDraft,setDescriptionDraft]=useState(resource.resourceComment);
  const [factDraft,setFactDraft]=useState<Record<string,string>>({});
  const [propertyFormOpen,setPropertyFormOpen]=useState(false);
  const [resourceProperty,setResourceProperty]=useState<ResourcePropertyDraft>({name:'',label:'',typeIri:`${XSD}string`,value:''});
  useEffect(()=>{setClassDraft(resource.classIri);setDescriptionDraft(resource.resourceComment)},[resource.id,resource.classIri,resource.resourceComment]);
  useEffect(()=>{const next:Record<string,string>={};for(const attribute of attributes){const values=literalFacts.filter(fact=>fact.predicate===attribute.iri).map(fact=>fact.value);next[attribute.iri]=attribute.multiple?values.join('\n'):values[0]??''}setFactDraft(next)},[resource.id,schema.data]);
  const saveAll=()=>{const missing=attributes.find(attribute=>attribute.required&&!factDraft[attribute.iri]?.trim());if(missing){window.alert(`${missing.label} is required.`);return}const facts=attributes.flatMap(attribute=>{const raw=factDraft[attribute.iri]??'';const values=attribute.multiple?raw.split('\n').map(value=>value.trim()).filter(Boolean):raw.trim()?[raw.trim()]:[];return (values.length?values:['']).map(value=>({predicate:attribute.iri,predicateLabel:attribute.label,value,valueLabel:value,valueType:actualDatatype(attribute.datatype),valueClassIri:'',valueClassLabel:'',direction:'out' as const}))});onSave(resource.id,classDraft,descriptionDraft,facts)};
  const createResourceProperty=()=>{const local=propertyLocal(resourceProperty.name);if(!validLocal(local)){window.alert('Property name must start with a letter or underscore.');return}const propertyIri=`${resource.id}#${local}`;const label=resourceProperty.label.trim()||local;setFactDraft(current=>({...current,[propertyIri]:resourceProperty.value}));onSave(resource.id,classDraft,descriptionDraft,[...attributes.flatMap(attribute=>{const raw=factDraft[attribute.iri]??'';const values=attribute.multiple?raw.split('\n').map(value=>value.trim()).filter(Boolean):raw.trim()?[raw.trim()]:[];return values.map(value=>({predicate:attribute.iri,predicateLabel:attribute.label,value,valueLabel:value,valueType:actualDatatype(attribute.datatype),valueClassIri:'',valueClassLabel:'',direction:'out' as const}))}),{predicate:propertyIri,predicateLabel:label,value:resourceProperty.value,valueLabel:resourceProperty.value,valueType:actualDatatype(resourceProperty.typeIri),valueClassIri:'',valueClassLabel:'',direction:'out' as const}]);setResourceProperty({name:'',label:'',typeIri:`${XSD}string`,value:''});setPropertyFormOpen(false)};
  return <div className="modal-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
    <div className="modal resource-editor-modal playground-resource-modal" role="dialog" aria-modal="true" aria-labelledby="playground-preview-title">
      <div className="modal-header"><div><h2 id="playground-preview-title">{resource.label}</h2><p>{resource.classLabel} · Edit RDF properties</p></div><button className="icon-button" title="Close" onClick={onClose}><X size={19}/></button></div>
      <div className="resource-editor-body">
        <div className="resource-class-selector"><label>Ontology class<select value={classDraft} onChange={event=>setClassDraft(event.target.value)}>{classRows.length?classRows.map(row=><option key={row.class.value} value={row.class.value}>{row.label?.value??compact(row.class.value)} — {compact(row.class.value)}</option>):<option value={resource.classIri}>{resource.classLabel} — {compact(resource.classIri)}</option>}</select></label><p>Changing the class updates this generated draft only. Existing generated values are retained.</p></div>
        <div className="resource-comment-grid"><section className="resource-description-editor"><div><span>Resource description</span><p>Saved on this generated draft as RDF comment metadata.</p></div><textarea value={descriptionDraft} onChange={event=>setDescriptionDraft(event.target.value)} placeholder="Describe this pipeline resource..."/><button className="secondary" disabled={descriptionDraft.trim()===resource.resourceComment&&classDraft===resource.classIri} onClick={saveAll}><Save size={15}/>Save description</button></section><section><span>Class description</span><p>{firstText(schemaRows[0]?.classComment?.value,schemaRows[0]?.classDescription?.value,resource.classComment) || 'No class description is present.'}</p></section></div>
        <section className="resource-section">
          <div className="resource-section-title"><div><h3>Properties</h3><p>Values are stored on this generated draft. Relationships are edited by connecting arrows on the canvas.</p></div><div className="resource-section-actions"><button className="secondary" onClick={()=>setPropertyFormOpen(value=>!value)}><Plus size={15}/>{propertyFormOpen?'Cancel':'Add resource property'}</button><button onClick={saveAll}><Save size={15}/>Save properties</button></div></div>
          {propertyFormOpen&&<div className="resource-specific-property"><label>Property name<input value={resourceProperty.name} onChange={event=>setResourceProperty(current=>({...current,name:propertyLocal(event.target.value)}))} placeholder="codeBlob"/></label><label>Label<input value={resourceProperty.label} onChange={event=>setResourceProperty(current=>({...current,label:event.target.value}))} placeholder="Code Blob"/></label><label>Type<select value={resourceProperty.typeIri} onChange={event=>setResourceProperty(current=>({...current,typeIri:event.target.value}))}>{datatypeOptions.map(option=><option key={option} value={option}>{typeLabel(option)}</option>)}</select></label>{resourceProperty.typeIri===TEXTAREA_TYPE?<label className="resource-specific-wide">Initial value<textarea value={resourceProperty.value} onChange={event=>setResourceProperty(current=>({...current,value:event.target.value}))} placeholder="Paste long text or code..."/></label>:<label>Initial value<input value={resourceProperty.value} onChange={event=>setResourceProperty(current=>({...current,value:event.target.value}))}/></label>}<button onClick={createResourceProperty}>Create property</button></div>}
          <div className="resource-fields">
            {schema.isLoading?<div className="section-empty">Loading class definition...</div>:attributes.length===0?<div className="section-empty">This class has no properties.</div>:attributes.map(attribute=><label key={attribute.iri}>{attribute.label}{attribute.resourceSpecific&&<button type="button" className="icon-button danger-button property-delete-button" title="Delete resource-specific property" onClick={event=>{event.preventDefault();setFactDraft(current=>{const next={...current};delete next[attribute.iri];return next})}}><Trash2 size={13}/></button>}{attribute.required&&<strong>Required</strong>}{attribute.multiple||attribute.widget==='textarea'||attribute.datatype===TEXTAREA_TYPE?<textarea value={factDraft[attribute.iri]??''} onChange={event=>setFactDraft(current=>({...current,[attribute.iri]:event.target.value}))} placeholder={attribute.multiple?'One value per line':'Paste long text or code...'}/>:attribute.datatype.endsWith('#boolean')?<select value={factDraft[attribute.iri]??''} onChange={event=>setFactDraft(current=>({...current,[attribute.iri]:event.target.value}))}><option value="">Not set</option><option value="true">True</option><option value="false">False</option></select>:<input type={attribute.datatype.endsWith('#date')?'date':attribute.datatype.endsWith('#dateTime')?'datetime-local':attribute.datatype.endsWith('#integer')||attribute.datatype.endsWith('#decimal')?'number':'text'} value={factDraft[attribute.iri]??''} onChange={event=>setFactDraft(current=>({...current,[attribute.iri]:event.target.value}))}/>}<small>{attribute.resourceSpecific?'Resource-specific · ':''}{typeLabel(attribute.datatype)}{attribute.multiple?' · multiple values':''}</small></label>)}
          </div>
        </section>
      </div>
      <div className="modal-footer"><button className="secondary" onClick={onClose}>Close</button></div>
    </div>
  </div>;
}

// "Add code from a script" for an already-fetched pipeline: paste the pipeline's
// script, match each function to an EXISTING stage by name, and write the code onto
// those nodes (no new nodes minted). The fix for "decompose on top of Fetch".
function AttachCodeStudio({ onClose, onApplied }: { onClose: () => void; onApplied: (n: number) => void }) {
  const [source, setSource] = useState('');
  const [result, setResult] = useState<import('../api').AttachProposeResponse | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const propose = useMutation({ mutationFn: () => api.codegraphAttachPropose(source), onSuccess: r => { setResult(r); setPicked(Object.fromEntries(r.matches.map((m, i) => [i, m.matched]))); } });
  const chosen = result ? result.matches.filter((m, i) => picked[i] && m.matched) : [];
  const apply = useMutation({ mutationFn: () => api.codegraphAttachApply(chosen.map(m => ({ iri: m.stageIri, code: m.code, entrypoint: m.entrypoint, language: m.language }))), onSuccess: res => onApplied(res.applied) });
  return <div className="playground-decompose">
    <textarea className="playground-decompose-input" value={source} onChange={event => setSource(event.target.value)} placeholder="Paste this pipeline's script. Its functions are matched to the existing stages by name, and the code is written onto those nodes — no duplicates." />
    <div className="playground-decompose-actions">
      <button disabled={!source.trim() || propose.isPending} onClick={() => propose.mutate()}><FileCode2 size={15}/>{propose.isPending ? 'Matching…' : 'Match to existing stages'}</button>
      {result && <button className="secondary" disabled={apply.isPending || !chosen.length} onClick={() => apply.mutate()}>{apply.isPending ? 'Attaching…' : `Attach code to ${chosen.length} stage${chosen.length === 1 ? '' : 's'}`}</button>}
      <button className="secondary" onClick={onClose}>Cancel</button>
    </div>
    <ErrorBox error={propose.error || apply.error} />
    {result && <div className="playground-decompose-blocks">
      {result.matches.map((match, index) => <div className="playground-decompose-block" key={index}>
        <div className="playground-decompose-block-head">
          {match.matched && <input type="checkbox" checked={!!picked[index]} onChange={event => setPicked(p => ({ ...p, [index]: event.target.checked }))} title="Attach this block" />}
          <strong>{match.blockLabel}</strong>{match.entrypoint && <code>{match.entrypoint}()</code>}
          <span className={`attach-badge ${match.matched ? 'ok' : 'none'}`}>{match.matched ? `→ ${match.stageLabel}` : 'no matching stage — skipped'}</span>
        </div>
        <pre className="playground-chat-code">{match.code}</pre>
      </div>)}
    </div>}
  </div>;
}

// The record shown under an assistant turn once it has actually carried out an edit:
// what changed, with a diff/before-after and a Revert. Reuses the same Monaco diff the
// per-node Code tab uses so the review surface is identical.
/** Review-and-edit surface for an AI-proposed class. Nothing has been written to the
 *  graph when this opens: `onApprove` is the only path that touches Fuseki. The property
 *  controls mirror the hand-written class editor so a proposal is a draft, not a verdict. */
function ClassProposalModal({ result, classOptions, busy, error, onApprove, onClose }: {
  result: ClassProposalResponse; classOptions: { iri: string; label: string }[]; busy: boolean; error: string;
  onApprove: (rendered: ClassProposalResponse) => void; onClose: () => void;
}) {
  // The whole response is the unit of state, not just the proposal: approving must upload
  // the schema/instance JSON-LD that corresponds to the *edited* proposal, so both move
  // together on every re-render.
  const [current, setCurrent] = useState<ClassProposalResponse>(result);
  const [showTurtle, setShowTurtle] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState('');
  // Bumped on every edit; the re-render effect keys off this counter rather than the
  // proposal's identity. Keying off the proposal meant a failed render, which itself sets
  // state, re-triggered the effect forever - and left the Approve button disabled for good.
  const [revision, setRevision] = useState(0);
  const draft = current.proposal;

  // Re-serialize through the backend so the RDF the user approves is the RDF the backend
  // produces from their edits - never a client-side guess, and their edits pass the same
  // validation the model's output did.
  useEffect(() => {
    if (revision === 0) return;
    let cancelled = false;
    setRendering(true);
    const timer = setTimeout(() => {
      api.aiRenderClass(draft)
        .then(next => { if (!cancelled) { setCurrent(next); setRenderError(''); } })
        .catch(error => { if (!cancelled) setRenderError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (!cancelled) setRendering(false); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  const patchProposal = (patch: (proposal: ClassProposal) => ClassProposal) => {
    setCurrent(item => ({ ...item, proposal: patch(item.proposal) }));
    setRevision(value => value + 1);
  };
  const patchClass = (index: number, patch: Partial<ClassProposal['classes'][number]>) =>
    patchProposal(proposal => ({ ...proposal, classes: proposal.classes.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  const patchProperty = (classIndex: number, propertyIndex: number, patch: Partial<ProposedProperty>) =>
    patchProposal(proposal => ({ ...proposal, classes: proposal.classes.map((item, i) => i !== classIndex ? item : { ...item, properties: item.properties.map((property, j) => j === propertyIndex ? { ...property, ...patch } : property) }) }));
  const removeProperty = (classIndex: number, propertyIndex: number) =>
    patchProposal(proposal => ({ ...proposal, classes: proposal.classes.map((item, i) => i !== classIndex ? item : { ...item, properties: item.properties.filter((_, j) => j !== propertyIndex) }) }));
  const addProperty = (classIndex: number) =>
    patchProposal(proposal => ({ ...proposal, classes: proposal.classes.map((item, i) => i !== classIndex ? item : { ...item, properties: [...item.properties, { iri: '', localName: '', label: '', comment: '', rangeIri: datatypeOptions[0], kind: 'datatype' as const, required: false, multiple: false }] }) }));

  const patchInstance = (index: number, patch: Partial<ProposedInstance>) =>
    patchProposal(proposal => ({ ...proposal, instances: proposal.instances.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  const patchLink = (instanceIndex: number, linkIndex: number, patch: Partial<ProposedLink>) =>
    patchProposal(proposal => ({ ...proposal, instances: proposal.instances.map((item, i) => i !== instanceIndex ? item : { ...item, links: item.links.map((link, j) => j === linkIndex ? { ...link, ...patch } : link) }) }));
  const removeLink = (instanceIndex: number, linkIndex: number) =>
    patchProposal(proposal => ({ ...proposal, instances: proposal.instances.map((item, i) => i !== instanceIndex ? item : { ...item, links: item.links.filter((_, j) => j !== linkIndex) }) }));
  const addLink = (instanceIndex: number) =>
    patchProposal(proposal => ({ ...proposal, instances: proposal.instances.map((item, i) => i !== instanceIndex ? item : { ...item, links: [...item.links, { predicateIri: options.predicates[0]?.iri ?? '', predicateLabel: '', targetIri: options.targets[0]?.iri ?? '', targetLabel: '', targetClassIri: '', direction: 'in' as const }] }) }));

  const patchPropertyValue = (instanceIndex: number, valueIndex: number, patch: Partial<ProposedPropertyValue>) =>
    patchProposal(proposal => ({ ...proposal, instances: proposal.instances.map((item, i) => i !== instanceIndex ? item : { ...item, propertyValues: item.propertyValues.map((value, j) => j === valueIndex ? { ...value, ...patch } : value) }) }));
  const removePropertyValue = (instanceIndex: number, valueIndex: number) =>
    patchProposal(proposal => ({ ...proposal, instances: proposal.instances.map((item, i) => i !== instanceIndex ? item : { ...item, propertyValues: item.propertyValues.filter((_, j) => j !== valueIndex) }) }));
  const addPropertyValue = (instanceIndex: number) =>
    patchProposal(proposal => ({ ...proposal, instances: proposal.instances.map((item, i) => i !== instanceIndex ? item : { ...item, propertyValues: [...item.propertyValues, { predicateIri: propertyOptionsFor(item)[0]?.iri ?? '', predicateLabel: '', value: '' }] }) }));
  // A reused class's settable properties come from the server catalog; a class defined in
  // THIS draft has none there yet, so its own just-added datatype properties (once they
  // have a real IRI, assigned by the debounced re-render) are offered too.
  const propertyOptionsFor = (instance: ProposedInstance) => {
    const ownClass = draft.classes.find(item => item.iri === instance.classIri);
    const draftOwn = (ownClass?.properties ?? [])
      .filter(property => property.kind === 'datatype' && property.iri)
      .map(property => ({ iri: property.iri, label: property.label || property.localName }));
    const seen = new Set(draftOwn.map(item => item.iri));
    return [...draftOwn, ...options.properties.filter(item => !seen.has(item.iri))];
  };

  const options = current.options;
  const turtle = current.turtle;
  const namelessClass = draft.classes.some(item => !validLocal(item.localName));
  const namelessProperty = draft.classes.some(item => item.properties.some(property => !validLocal(property.localName)));
  const namelessInstance = draft.instances.some(item => !item.name.trim());
  // A reuse proposal legitimately defines zero classes - the whole point is that an
  // existing one already fits - but it must still carry at least the new instance the
  // user asked for, or there is genuinely nothing here to approve.
  const blocker = (!draft.classes.length && !(draft.reuse && draft.instances.length)) ? 'The proposal defines no class.'
    : namelessClass ? 'Every class needs a local name starting with a letter or underscore.'
    : namelessProperty ? 'Every property needs a name starting with a letter or underscore.'
    : namelessInstance ? 'Every node needs a name.'
    : '';
  const typeOptions = [...datatypeOptions, ...classOptions.map(item => item.iri)];

  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal resource-editor-modal" role="dialog" aria-modal="true" aria-labelledby="class-proposal-title">
      <div className="modal-header">
        <div>
          <h2 id="class-proposal-title">{draft.reuse ? `Reusing ${draft.reuse.classLabel}` : 'New ontology class'}</h2>
          <p>Nothing is written until you approve. Edit anything below first.</p>
        </div>
        <button className="icon-button" title="Close" onClick={onClose}><X size={19} /></button>
      </div>
      <div className="resource-editor-body">
        {draft.reuse && <div className="playground-class-warning">{draft.reuse.rationale || `${draft.reuse.classLabel} already covers this concept, so only a new node of that class is being added - no new class.`}</div>}
        {error && <div className="error">{error}</div>}
        {renderError && <div className="error">{renderError}</div>}
        {draft.warnings.map(warning => <div className="playground-class-warning" key={warning}>{warning}</div>)}

        {/* Keyed by position: keying by localName remounted the section on every keystroke,
            so the Local name input lost focus after each character. */}
        {draft.classes.map((item, classIndex) => <section className="playground-class-block" key={classIndex}>
          <div className="class-fields">
            <label>Local name<input value={item.localName} onChange={event => patchClass(classIndex, { localName: cleanLocal(event.target.value) })} /></label>
            <label>Label<input value={item.label} onChange={event => patchClass(classIndex, { label: event.target.value })} /></label>
            <label className="field-wide">Description<textarea value={item.comment} onChange={event => patchClass(classIndex, { comment: event.target.value })} /></label>
            <label>Parent class<select value={item.parentClassIri} onChange={event => patchClass(classIndex, { parentClassIri: event.target.value })}>
              <option value="">No parent class</option>
              {classOptions.map(option => <option key={option.iri} value={option.iri}>{option.label}</option>)}
            </select></label>
            <label>IRI<input value={item.iri} readOnly disabled /></label>
          </div>

          <div className="ontology-section-header">
            <div><h3>Properties</h3><p>Derived from your request and any attached code.</p></div>
            <button className="secondary" onClick={() => addProperty(classIndex)}><Plus size={15} />Add property</button>
          </div>
          {item.properties.length === 0
            ? <div className="section-empty">No properties. Add one, or approve the class without any.</div>
            : item.properties.map((property, propertyIndex) => <div className="ontology-row property-row" key={propertyIndex}>
                <label>Name<input value={property.localName} onChange={event => patchProperty(classIndex, propertyIndex, { localName: cleanLocal(event.target.value), iri: '' })} placeholder="serviceId" /></label>
                <label>Label<input value={property.label} onChange={event => patchProperty(classIndex, propertyIndex, { label: event.target.value })} /></label>
                <label>Type<select value={property.rangeIri} onChange={event => patchProperty(classIndex, propertyIndex, { rangeIri: event.target.value })}>
                  {typeOptions.map(option => <option key={option} value={option}>{shortRange(option)}</option>)}
                </select></label>
                {/* .property-row is a 7-column grid; Description is the 4th. Omitting it
                    pushed every later control into the wrong column. */}
                <label>Description<input value={property.comment} onChange={event => patchProperty(classIndex, propertyIndex, { comment: event.target.value })} /></label>
                <label className="ontology-check"><input type="checkbox" checked={property.required} onChange={event => patchProperty(classIndex, propertyIndex, { required: event.target.checked })} />Required</label>
                <label className="ontology-check"><input type="checkbox" checked={property.multiple} onChange={event => patchProperty(classIndex, propertyIndex, { multiple: event.target.checked })} />Multiple values</label>
                <button className="icon-button danger-button" title="Remove property" onClick={() => removeProperty(classIndex, propertyIndex)}><Trash2 size={16} /></button>
              </div>)}
        </section>)}

        {draft.instances.map((instance, instanceIndex) => <section className="playground-class-block" key={instanceIndex}>
          <div className="ontology-section-header">
            <div><h3>Added to the pipeline</h3><p>The node created alongside the class, and how it attaches.</p></div>
            <button className="secondary" disabled={!options.predicates.length || !options.targets.length} onClick={() => addLink(instanceIndex)}><Plus size={15} />Add link</button>
          </div>
          <div className="class-fields">
            <label>Node name<input value={instance.name} onChange={event => patchInstance(instanceIndex, { name: event.target.value })} /></label>
            {/* Instances in one proposal can each belong to a DIFFERENT class now (e.g. a
                new stage together with its own output/metric) - shown read-only since it's
                resolved server-side, not something to hand-edit here. */}
            <label>Class<input value={instance.classLabel} readOnly disabled /></label>
            <label>IRI<input value={instance.iri} readOnly disabled /></label>
            <label className="field-wide">Description<textarea value={instance.comment} onChange={event => patchInstance(instanceIndex, { comment: event.target.value })} /></label>
          </div>
          {instance.links.length === 0
            ? <div className="section-empty">Not linked to anything yet — it will appear on the canvas unconnected.</div>
            : instance.links.map((link, linkIndex) => <div className="ontology-row playground-link-row" key={linkIndex}>
                <label>Direction<select value={link.direction} onChange={event => patchLink(instanceIndex, linkIndex, { direction: event.target.value as 'in' | 'out' })}>
                  <option value="in">Existing node → this node</option>
                  <option value="out">This node → existing node</option>
                </select></label>
                <label>Relationship<select value={link.predicateIri} onChange={event => patchLink(instanceIndex, linkIndex, { predicateIri: event.target.value })}>
                  {options.predicates.map(option => <option key={option.iri} value={option.iri}>{option.label}</option>)}
                </select></label>
                <label>Existing node<select value={link.targetIri} onChange={event => patchLink(instanceIndex, linkIndex, { targetIri: event.target.value, targetLabel: '' })}>
                  {options.targets.map(option => <option key={option.iri} value={option.iri}>{option.label}</option>)}
                </select></label>
                <button className="icon-button danger-button" title="Remove link" onClick={() => removeLink(instanceIndex, linkIndex)}><Trash2 size={16} /></button>
              </div>)}
          {instance.links.map((link, linkIndex) => link.targetLabel ? <div className="playground-class-link" key={`summary-${linkIndex}`}>
            <Link2 size={13} />
            {link.direction === 'out'
              ? <span><em>{instance.name}</em> — {link.predicateLabel} → <em>{link.targetLabel}</em></span>
              : <span><em>{link.targetLabel}</em> — {link.predicateLabel} → <em>{instance.name}</em></span>}
          </div> : null)}

          <div className="ontology-section-header">
            <div><h3>Property values</h3><p>Settings this node's class declares - set the actual value here, not just in the description above.</p></div>
            <button className="secondary" disabled={!propertyOptionsFor(instance).length} onClick={() => addPropertyValue(instanceIndex)}><Plus size={15} />Add property value</button>
          </div>
          {instance.propertyValues.length === 0
            ? <div className="section-empty">No property values set yet.</div>
            : instance.propertyValues.map((propertyValue, valueIndex) => <div className="ontology-row playground-link-row" key={valueIndex}>
                <label>Property<select value={propertyValue.predicateIri} onChange={event => patchPropertyValue(instanceIndex, valueIndex, { predicateIri: event.target.value })}>
                  {propertyOptionsFor(instance).map(option => <option key={option.iri} value={option.iri}>{option.label}</option>)}
                </select></label>
                <label>Value<input value={propertyValue.value} onChange={event => patchPropertyValue(instanceIndex, valueIndex, { value: event.target.value })} /></label>
                <button className="icon-button danger-button" title="Remove property value" onClick={() => removePropertyValue(instanceIndex, valueIndex)}><Trash2 size={16} /></button>
              </div>)}
        </section>)}

        <button className="preview-toggle" onClick={() => setShowTurtle(value => !value)}>
          {showTurtle ? <ChevronDown size={16} /> : <ChevronRight size={16} />}Generated Turtle preview
        </button>
        {showTurtle && <pre className="turtle-preview">{rendering ? 'Rendering…' : turtle || 'Could not render this proposal.'}</pre>}
      </div>
      <div className="modal-footer">
        {blocker ? <span className="playground-class-blocker">{blocker}</span> : <span />}
        <button className="secondary" onClick={onClose}>Discard</button>
        <button disabled={busy || rendering || !!blocker} onClick={() => onApprove(current)}>
          {busy ? 'Approving…' : rendering ? 'Checking…' : 'Approve'}
        </button>
      </div>
    </div>
  </div>;
}

function ChatActionDiffModal({ change, theme, onClose }: { change: AppliedChange; theme: 'dark' | 'light'; onClose: () => void }) {
  if (change.kind === 'createClass') return null;
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal resource-editor-modal" role="dialog" aria-modal="true" aria-labelledby="chat-diff-title">
      <div className="modal-header"><div><h2 id="chat-diff-title">{change.kind === 'editCode' ? `${change.label} · code diff` : `${change.targetStageLabel} · change`}</h2><p>{change.status === 'reverted' ? 'This change was reverted.' : 'Applied to the graph.'}</p></div><button className="icon-button" title="Close" onClick={onClose}><X size={19} /></button></div>
      <div className="resource-editor-body">
        {change.kind === 'editCode'
          ? <div className="cg-panel-editor" style={{ height: '60vh' }}><DiffEditor height="100%" language={(change.language || 'python').toLowerCase()} theme={theme === 'dark' ? 'vs-dark' : 'light'} original={change.previousCode} modified={change.newCode} options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, renderSideBySide: false, readOnly: true, automaticLayout: true }} /></div>
          : <div className="table-wrap"><table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
              <tr><td>Comment</td><td>{change.previousComment || '—'}</td><td>{change.updatedComment || '—'}</td></tr>
              {change.metricUpdate && <tr><td>Formula ({change.metricUpdate.metricLabel})</td><td>—</td><td>{change.metricUpdate.newFormula}</td></tr>}
            </tbody></table></div>}
      </div>
      <div className="modal-footer"><button className="secondary" onClick={onClose}>Close</button></div>
    </div>
  </div>;
}

function ClassChangeCard({ change, onReview }: { change: ProposedClassChange; onReview: () => void }) {
  const proposal = change.result?.proposal;
  // Reuse is the preferred outcome, so it reads as a result rather than a failure to mint.
  if (change.status === 'reuse' && proposal?.reuse) {
    return <div className="playground-applied-card reuse">
      <Shapes size={14} />
      <div className="playground-applied-body">
        <strong>Reusing {proposal.reuse.classLabel}</strong>
        <span>{proposal.reuse.rationale || 'An existing class already covers this, so no new class was created.'}</span>
      </div>
    </div>;
  }
  // A reuse-with-instance proposal defines no new class - the node names, not the class
  // names, are what identify it here.
  const names = proposal?.reuse
    ? proposal.instances.map(item => item.name).join(', ') || proposal.reuse.classLabel
    : proposal?.classes.map(item => item.label || item.localName).join(', ') || 'class';
  const verb = proposal?.reuse ? `reusing ${proposal.reuse.classLabel}` : '';
  return <div className={`playground-applied-card ${change.status}`}>
    <Shapes size={14} />
    <div className="playground-applied-body">
      <strong>{change.status === 'approved' ? `Created ${names}` : change.status === 'error' ? 'Could not propose a class' : `Proposed ${names}${verb ? ` (${verb})` : ''}`}</strong>
      {change.status === 'error'
        ? <span className="playground-applied-err">{change.error}</span>
        : <span>{change.status === 'approved' ? 'Added to the pipeline. Manage it on the Ontology page.' : change.why || 'Review before it is added.'}</span>}
    </div>
    <div className="playground-applied-actions">
      {change.status === 'pending' && <button onClick={onReview}><Shapes size={13} />Review &amp; approve</button>}
      {change.status === 'approved' && <span className="playground-applied-reverted"><Check size={12} />Approved</span>}
    </div>
  </div>;
}

function AppliedChangeCard({ change, onViewDiff, onRevert, onReview }: { change: AppliedChange; onViewDiff: () => void; onRevert: () => void; onReview: () => void }) {
  if (change.kind === 'createClass') return <ClassChangeCard change={change} onReview={onReview} />;
  const title = change.kind === 'editCode'
    ? `Updated ${change.label} code${change.status !== 'error' ? ` · v${change.fromVersion}→${change.toVersion}` : ''}`
    : `Updated ${change.targetStageLabel}`;
  return <div className={`playground-applied-card ${change.status}`}>
    <FileCode2 size={14} />
    <div className="playground-applied-body">
      <strong>{title}</strong>
      {change.status === 'error' ? <span className="playground-applied-err">{change.error}</span> : change.why ? <span>{change.why}</span> : null}
    </div>
    <div className="playground-applied-actions">
      {change.status !== 'error' && <button className="secondary" onClick={onViewDiff}><GitCompareArrows size={13} />View diff</button>}
      {change.status === 'applied' && <button className="secondary" onClick={onRevert}><RotateCcw size={13} />Revert</button>}
      {change.status === 'reverted' && <span className="playground-applied-reverted"><Check size={12} />Reverted</span>}
    </div>
  </div>;
}

function PlaygroundChatPanel({ messages, busy, prompt, setPrompt, onSend, chatInputRef, onAttach, activeFolder, onChooseOption, onViewDiff, onRevert, onReview }: {
  messages: ChatMessage[]; busy: boolean; prompt: string; setPrompt: (value: string) => void; onSend: () => void;
  chatInputRef: React.RefObject<HTMLTextAreaElement | null>; onAttach: (files: FileList | null) => void; activeFolder: PlaygroundFolder;
  onChooseOption: (question: ClarificationQuestion, option: string) => void;
  onViewDiff: (change: AppliedChange) => void; onRevert: (messageId: string, index: number) => void;
  onReview: (messageId: string, index: number) => void;
}) {
  const threadRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight }); }, [messages, busy]);
  return <div className="playground-chat-panel">
    <div className="playground-chat-panel-head"><MessageSquareText size={16} /><strong>Chat with this pipeline</strong></div>
    <div className="playground-chat-panel-thread" ref={threadRef}>
      {messages.map(message => <div className={`playground-chat-message ${message.role}`} key={message.id}>
        <MessageSquareText size={18} />
        <div>
          <strong>{message.role === 'assistant' ? 'Agent' : 'You'}</strong>
          <ChatText text={message.text} />
          {message.questions?.some(question => question.options?.length) ? <div className="playground-question-options">{message.questions.map((question, index) => question.options?.length ? <div className="playground-question-option-group" key={`${message.id}-${index}`}><span>{question.question}</span><div>{question.options.map(option => <button type="button" className="secondary" key={option} onClick={() => onChooseOption(question, option)}>{option}</button>)}</div></div> : null)}</div> : null}
          {message.applied?.length ? <div className="playground-applied">{message.applied.map((change, index) => <AppliedChangeCard key={index} change={change} onViewDiff={() => onViewDiff(change)} onRevert={() => onRevert(message.id, index)} onReview={() => onReview(message.id, index)} />)}</div> : null}
        </div>
      </div>)}
      {busy && <div className="playground-chat-message assistant"><Wand2 size={18} /><div><strong>Agent</strong><p>Reading the pipeline and answering…</p></div></div>}
    </div>
    <div className="playground-chatbar">
      <label className="chat-attach" title={`Attach file to ${activeFolder === 'root' ? 'root' : 'input_artifacts'}`}><Paperclip size={17} /><input type="file" multiple onChange={event => { onAttach(event.target.files); event.currentTarget.value = ''; }} /></label>
      <textarea ref={chatInputRef} value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSend(); } }} placeholder="Ask about this pipeline, a formula, or request a change…" />
      <button disabled={busy} onClick={onSend}><Send size={16} />{busy ? 'Thinking…' : 'Send'}</button>
    </div>
  </div>;
}

export function PlaygroundPage() {
  const { theme, toggleTheme } = useTheme();
  const qc=useQueryClient();
  const graph = useQuery({ queryKey: ['playground-resources'], queryFn: () => api.query(PLAYGROUND_QUERY) });
  const ontologyClasses=useQuery({queryKey:['ontology-classes'],queryFn:()=>api.query(CLASSES_QUERY)});
  const properties=useQuery({queryKey:['ontology-object-properties'],queryFn:()=>api.query(PROPERTIES_QUERY)});
  const rows = graph.data?.type === 'result' ? graph.data.results?.bindings ?? [] : [];
  const ontologyClassRows=ontologyClasses.data?.type==='result'?ontologyClasses.data.results?.bindings??[]:[];
  const propertyRows=useMemo(()=>((properties.data?.type==='result'?properties.data.results?.bindings??[]:[]) as unknown as PropertyRow[]),[properties.data]);
  const ontologyClassLabels=useMemo(()=>new Map(ontologyClassRows.map(row=>[row.class.value,row.label?.value??compact(row.class.value)])),[ontologyClassRows]);
  const resources = useMemo(() => rowsToResources(rows), [rows]);
  const [mode, setMode] = useState<PlaygroundMode>('home');
  const [attachOpen, setAttachOpen] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [artifacts, setArtifacts] = useState<PlaygroundArtifact[]>([]);
  const [activeFolder, setActiveFolder] = useState<PlaygroundFolder>('root');
  const [viewerResource, setViewerResource] = useState<MatrixResource | null>(null);
  const [viewerPreview,setViewerPreview]=useState(false);
  const [chatMessages,setChatMessages]=useState<ChatMessage[]>([{id:'assistant-start',role:'assistant',text:'Describe the pipeline, paste code or notes, and attach files if useful. I will ask only for clarifications needed to map the draft to the ontology.'}]);
  const [pendingQuestions,setPendingQuestions]=useState<ClarificationQuestion[]>([]);
  const [generationContext,setGenerationContext]=useState('');
  const [draftJsonld,setDraftJsonld]=useState<Record<string,unknown>[]|null>(null);
  const [approvedResources,setApprovedResources]=useState<MatrixResource[]|null>(null);
  const [matrixSelectedId,setMatrixSelectedId]=useState('');
  const [draftNodes,setDraftNodes]=useState<Node[]>([]);
  const [draftEdges,setDraftEdges]=useState<Edge[]>([]);
  const [selectedDraftEdge,setSelectedDraftEdge]=useState<Edge|null>(null);
  const [linkPredicate,setLinkPredicate]=useState(`${NS}hasInput`);
  const [provider,setProvider]=useState<LlmProvider>('openai');
  const [selectedModel,setSelectedModel]=useState(providerModels.openai[0]);
  const [customModel,setCustomModel]=useState('');
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const selected = resources.find(resource => resource.id === selectedId) ?? resources[0] ?? sampleResource;
  const visibleResources = resources.length ? resources : [sampleResource];
  const model = useMemo(() => graphModel(visibleResources), [visibleResources]);
  const rawDraftResources = useMemo(()=>draftJsonld?proposalToMatrixResources(draftJsonld as JsonLdNode[]):[],[draftJsonld]);
  const draftExternalIds = rawDraftResources.filter(resource=>!resource.resourceComment&&!resource.id.startsWith(GENERATED_PREFIX)).map(resource=>resource.id).sort();
  const draftExternalInfo = useQuery({queryKey:['playground-ai-external-node-info',draftExternalIds],queryFn:()=>fetchExternalNodeInfo(draftExternalIds),enabled:draftExternalIds.length>0});
  const draftResources = useMemo(()=>mergeExternalNodeInfo(rawDraftResources,draftExternalInfo.data??[]).map(resource=>({...resource,classLabel:ontologyClassLabels.get(resource.classIri)??resource.classLabel,facts:resource.facts.map(fact=>({...fact,valueClassLabel:ontologyClassLabels.get(fact.valueClassIri)??fact.valueClassLabel}))})),[rawDraftResources,draftExternalInfo.data,ontologyClassLabels]);
  const importedResources=approvedResources??model.resources;
  const clarify=useMutation({mutationFn:(input:{scripts:UploadedScript[];instructions:string})=>api.aiClarifyKg(input.scripts,input.instructions,{provider,model:selectedModel,modelCode:customModel||undefined})});
  const generate=useMutation({mutationFn:(input:{scripts:UploadedScript[];instructions:string;currentJsonld?:Record<string,unknown>[]})=>api.aiGenerateKg(input.scripts,input.instructions,[],{provider,model:selectedModel,modelCode:customModel||undefined,currentJsonld:input.currentJsonld})});
  const importDraft=useMutation({mutationFn:(file:File)=>api.importPipeline(file,false),onSuccess:()=>{qc.invalidateQueries({queryKey:['playground-resources']});qc.invalidateQueries({queryKey:['pipeline']});qc.invalidateQueries({queryKey:['pipeline-matrix']});}});
  const uploadArtifacts = (files: FileList | null, folder = activeFolder) => {
    if (!files?.length) return;
    // Snapshot the File objects NOW: the input's value is reset right after this call,
    // which empties the FileList before React runs the (deferred) state updater.
    const picked = Array.from(files).map(file => ({ id: `${file.name}-${file.lastModified}-${uid()}`, file, folder }));
    setArtifacts(current => [...current, ...picked]);
  };
  const artifactScripts=async()=>Promise.all(artifacts.map(async artifact=>({filename:`${artifact.folder}/${artifact.file.name}`,source:await artifact.file.text()})));
  const appendMessage=(role:ChatMessage['role'],text:string,questions?:ClarificationQuestion[])=>setChatMessages(current=>[...current,{id:`${Date.now()}-${uid()}`,role,text,questions}]);
  const downloadArtifact = (artifact: PlaygroundArtifact) => {
    const url = URL.createObjectURL(artifact.file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.file.name;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const folderName = (folder: PlaygroundFolder) => folder === 'root' ? 'root' : folder === 'input_artifacts' ? 'input_artifacts' : 'output';
  const inputArtifactFiles = useMemo(() => artifacts.filter(item => item.folder === 'input_artifacts').map(item => item.file), [artifacts]);
  // Files a node's code wrote to output/ come back from the runner and land in the
  // File Explorer's output folder, replacing any same-named prior output.
  const addOutputs = (outputs: ExecOutput[]) => {
    if (!outputs.length) return;
    setArtifacts(current => {
      const names = new Set(outputs.map(output => output.filename));
      const kept = current.filter(item => !(item.folder === 'output' && names.has(item.file.name)));
      const created = outputs.map(output => {
        const file = output.text !== undefined
          ? new File([output.text], output.filename, { type: 'text/plain' })
          : new File([Uint8Array.from(atob(output.base64 ?? ''), char => char.charCodeAt(0))], output.filename);
        return { id: `${output.filename}-${Date.now()}-${uid()}`, file, folder: 'output' as PlaygroundFolder };
      });
      return [...kept, ...created];
    });
    setActiveFolder('output');
  };
  const startCreatePipeline = () => {
    setMode('create');
    setPendingQuestions([]);
    setGenerationContext('');
    setPrompt('');
    requestAnimationFrame(() => chatInputRef.current?.focus());
  };
  const changeProvider=(value:LlmProvider)=>{setProvider(value);setSelectedModel(providerModels[value][0]);setCustomModel('')};
  const runGeneration=async(instructions:string,currentJsonld?:Record<string,unknown>[])=>{
    const scripts=await artifactScripts();
    const result=await generate.mutateAsync({scripts,instructions,currentJsonld});
    setDraftJsonld(result.jsonld);
    setApprovedResources(null);
    setMode('generated');
    setMatrixSelectedId('');
    appendMessage('assistant','I generated a draft mapped to the ontology. Inspect the resources, ask for changes, or approve it into the Playground canvas.');
    return result;
  };
  const handleSend=async()=>{
    const text=prompt.trim();
    if(!text&&!artifacts.length){appendMessage('assistant','Add a description, paste code or notes, or attach at least one file before generating.');return}
    if(text)appendMessage('user',text);
    setPrompt('');
    try{
      if(draftJsonld){
        await runGeneration(text||'Revise the draft using the attached files and prior context.',draftJsonld);
        return;
      }
      const scripts=await artifactScripts();
      const combined=[generationContext,...pendingQuestions.map((question,index)=>`Clarification question ${index+1}: ${question.question}`),text?`User answer: ${text}`:''].filter(Boolean).join('\n\n');
      if(pendingQuestions.length){
        setPendingQuestions([]);
        setGenerationContext('');
        await runGeneration(combined);
        return;
      }
      const response=await clarify.mutateAsync({scripts,instructions:text});
      if(!response.ready&&response.questions.length){
        setPendingQuestions(response.questions);
        setGenerationContext(response.normalizedInstructions||text);
        setMode('create');
        appendMessage('assistant',`I need these details before generating:\n${response.questions.map((question,index)=>`${index+1}. ${question.question}`).join('\n')}`,response.questions);
        return;
      }
      await runGeneration(response.normalizedInstructions||text);
    }catch(error){
      setPrompt(text);
    }
  };
  const [chatBusy,setChatBusy]=useState(false);
  const [diffChange,setDiffChange]=useState<AppliedChange|null>(null);
  const [reviewTarget,setReviewTarget]=useState<{messageId:string;index:number}|null>(null);
  const [approveBusy,setApproveBusy]=useState(false);
  const [approveError,setApproveError]=useState('');
  const classOptions=useMemo(()=>ontologyClassRows.map(row=>({iri:row.class.value,label:row.label?.value??compact(row.class.value)})).sort((a,b)=>a.label.localeCompare(b.label)),[ontologyClassRows]);
  const grounded=mode==='select'||mode==='imported';
  const groundedOpts=useMemo(()=>({provider,model:selectedModel,modelCode:customModel||undefined}),[provider,selectedModel,customModel]);
  const errMsg=(error:unknown)=>error instanceof Error?error.message:String(error);
  const invalidateGraph=(iri?:string)=>{
    for(const key of ['playground-resources','pipeline','pipeline-matrix','cg-code','cg-params','cg-sig','playground-resource','playground-resource-meta','ai-stages'])qc.invalidateQueries({queryKey:[key]});
    if(iri){qc.invalidateQueries({queryKey:['cg-code',iri]});qc.invalidateQueries({queryKey:['playground-resource',iri]});}
  };
  const updateChange=(messageId:string,index:number,updater:(change:AppliedChange)=>AppliedChange)=>setChatMessages(current=>current.map(message=>message.id===messageId&&message.applied?{...message,applied:message.applied.map((change,i)=>i===index?updater(change):change)}:message));
  const executeAction=async(action:ChatAction):Promise<AppliedChange>=>{
    if(action.kind==='createClass'){
      // Deliberately does NOT write: unlike editCode/modifyOntology, a new ontology term
      // is proposed for review and only reaches Fuseki through approveClassProposal().
      try{
        const scripts=await artifactScripts();
        const result=await api.aiProposeClass(action.instruction,scripts,groundedOpts);
        // Reuse with no new instance really is a dead end (the concept is already fully
        // covered) - but reuse WITH an instance means the user asked for a new NODE of an
        // existing kind ("a second Aggregation stage"), which is a real, reviewable change
        // and must still go through the approve flow, not be reported as a no-op.
        if(result.proposal.reuse&&!result.proposal.instances.length)return {kind:'createClass',status:'reuse',result,why:action.why};
        if(!result.proposal.classes.length&&!result.proposal.instances.length)return {kind:'createClass',status:'error',result,why:action.why,error:result.proposal.warnings[0]??'No class could be derived from that request.'};
        return {kind:'createClass',status:'pending',result,why:action.why};
      }catch(error){return {kind:'createClass',status:'error',result:null,why:action.why,error:errMsg(error)};}
    }
    if(action.kind==='editCode'){
      const label=action.label||(action.iri?compact(action.iri):'node');
      if(!action.iri)return {kind:'editCode',status:'error',proposalId:'',iri:'',label,language:'python',previousCode:'',newCode:'',fromVersion:0,toVersion:0,why:action.why,error:'No target node was identified for this code edit — open the node and edit it directly.'};
      try{
        const proposal:CodeEditProposal=await api.codegraphEditPropose(action.iri,action.instruction);
        const base={kind:'editCode' as const,proposalId:proposal.id,iri:action.iri,label:proposal.label,language:proposal.language,previousCode:proposal.previousCode,newCode:proposal.newCode,fromVersion:proposal.fromVersion,toVersion:proposal.toVersion,why:action.why};
        if(proposal.unchanged)return {...base,status:'error',error:'The model reported no change was needed.'};
        await api.codegraphEditApply(proposal.id);
        invalidateGraph(action.iri);
        return {...base,status:'applied'};
      }catch(error){return {kind:'editCode',status:'error',proposalId:'',iri:action.iri,label,language:'python',previousCode:'',newCode:'',fromVersion:0,toVersion:0,why:action.why,error:errMsg(error)};}
    }
    const label=action.label||(action.targetStageId?compact(action.targetStageId):'stage');
    try{
      const proposal:Proposal=await api.aiProposeModification(action.instruction,action.targetStageId,'');
      await api.aiApplyProposal(proposal.id);
      invalidateGraph();
      return {kind:'modifyOntology',status:'applied',proposalId:proposal.id,targetStageLabel:proposal.targetStageLabel,previousComment:proposal.previousComment,updatedComment:proposal.updatedComment,metricUpdate:proposal.metricUpdate,why:action.why};
    }catch(error){return {kind:'modifyOntology',status:'error',proposalId:'',targetStageLabel:label,previousComment:'',updatedComment:'',metricUpdate:null,why:action.why,error:errMsg(error)};}
  };
  // A turn's `text` is the model's OWN optimistic prose ("I will update X to Y..."),
  // written before anything was actually attempted - it says nothing about whether the
  // change landed. Replaying only that text as history let a later turn confidently
  // describe a rewire that had in fact been REJECTED, because nothing in the history it
  // saw contradicted its own earlier claim. Appending the real outcome (applied/rejected/
  // reverted, with the actual error) gives future turns the ground truth to reconcile
  // against, instead of just their own past narration.
  const describeOutcome=(change:AppliedChange):string=>{
    if(change.kind==='editCode'){
      if(change.status==='error')return `[editCode on "${change.label}" FAILED, nothing was written: ${change.error}]`;
      if(change.status==='reverted')return `[editCode on "${change.label}" was REVERTED - the code is back to what it was before]`;
      return `[editCode on "${change.label}" applied successfully]`;
    }
    if(change.kind==='modifyOntology'){
      if(change.status==='error')return `[modifyOntology on "${change.targetStageLabel}" was REJECTED, nothing was written: ${change.error}]`;
      if(change.status==='reverted')return `[modifyOntology on "${change.targetStageLabel}" was REVERTED - the graph is back to what it was before]`;
      return `[modifyOntology on "${change.targetStageLabel}" applied successfully]`;
    }
    if(change.status==='error')return `[createClass FAILED, nothing was written: ${change.error}]`;
    if(change.status==='reuse')return '[createClass: an existing class already covered this, nothing new was created]';
    if(change.status==='approved')return '[createClass: approved and added to the pipeline]';
    return '[createClass: proposed but NOT YET approved by the user - nothing has been written to the graph]';
  };
  const historyText=(message:ChatMessage):string=>{
    const outcomes=(message.applied??[]).map(describeOutcome).join(' ');
    return outcomes?`${message.text}\n\nACTUAL OUTCOME (ground truth - trust this over the prose above): ${outcomes}`:message.text;
  };
  const handleChatSend=async()=>{
    const text=prompt.trim();
    if(!text)return;
    appendMessage('user',text);
    setPrompt('');
    const history:ChatTurn[]=[...chatMessages.filter(message=>message.text).map(message=>({role:message.role,text:historyText(message)})),{role:'user' as const,text}];
    setChatBusy(true);
    try{
      const response=await api.aiChat(history,groundedOpts);
      const applied:AppliedChange[]=[];
      for(const action of response.actions)applied.push(await executeAction(action));
      setChatMessages(current=>[...current,{id:`${Date.now()}-${uid()}`,role:'assistant',text:response.answer,applied:applied.length?applied:undefined,questions:response.clarificationOptions?.length?response.clarificationOptions:undefined}]);
    }catch(error){
      appendMessage('assistant',errMsg(error));
      setPrompt(text);
    }finally{setChatBusy(false);}
  };
  const revertChange=async(messageId:string,index:number)=>{
    const change=chatMessages.find(message=>message.id===messageId)?.applied?.[index];
    // An approved class is not revertable from here - it is a schema term, deleted from
    // the Ontology page (which also cleans up its properties and instances).
    if(!change||change.kind==='createClass'||change.status!=='applied')return;
    try{
      if(change.kind==='editCode'){await api.codegraphEditRevert(change.proposalId);invalidateGraph(change.iri);}
      else{await api.aiRevertProposal(change.proposalId);invalidateGraph();}
      updateChange(messageId,index,current=>current.kind==='createClass'?current:{...current,status:'reverted'});
    }catch(error){updateChange(messageId,index,current=>({...current,status:'error',error:errMsg(error)}));}
  };
  // Every RDF change made from chat is a revertable entry; newest last. The canvas
  // "Undo last change" pops this stack, so a change can be reverted without finding its
  // chat card. Reuses the same per-card revert path.
  const revertable=useMemo(()=>chatMessages.flatMap(message=>(message.applied??[]).map((change,index)=>({messageId:message.id,index,change}))).filter(entry=>entry.change.status==='applied'),[chatMessages]);
  const revertLastChange=()=>{const last=revertable[revertable.length-1];if(last)void revertChange(last.messageId,last.index);};
  const canvasRevertControl=revertable.length>0?<button className="playground-canvas-revert" onClick={revertLastChange} title="Revert the most recent change made to the RDF from chat"><RotateCcw size={14}/>Undo last change{revertable.length>1?` · ${revertable.length}`:''}</button>:null;
  const jsonldFile=(nodes:Record<string,unknown>[],name:string)=>new File([JSON.stringify(nodes,null,2)],name,{type:'application/ld+json'});
  const reviewedChange=reviewTarget?chatMessages.find(message=>message.id===reviewTarget.messageId)?.applied?.[reviewTarget.index]:undefined;
  const reviewedResult=reviewedChange?.kind==='createClass'?reviewedChange.result:null;
  const closeReview=()=>{setReviewTarget(null);setApproveError('')};
  // The only path from a class proposal into Fuseki. Two calls, in this order: the schema
  // document must reach /import/ontology WITHOUT instances, because that endpoint infers an
  // ontology from any instance it finds - the typed link-target stubs would make it re-label
  // shared terms and narrow rps:hasInput's domain/range onto the new class. Once the class is
  // defined, /import/pipeline skips inference and just writes the instance triples.
  const approveClassProposal=async(rendered:ClassProposalResponse)=>{
    if(!reviewTarget)return;
    setApproveBusy(true);
    setApproveError('');
    try{
      // A reuse-with-instance proposal defines no new class, so schemaJsonld is empty -
      // skip the ontology import entirely rather than PUT an empty document.
      if(rendered.schemaJsonld.length)await api.importOntology(jsonldFile(rendered.schemaJsonld,'playground-generated-class.jsonld'),false);
      if(rendered.instanceJsonld.length)await api.importPipeline(jsonldFile(rendered.instanceJsonld,'playground-generated-class-instances.jsonld'),false);
      invalidateGraph();
      qc.invalidateQueries({queryKey:['ontology']});
      qc.invalidateQueries({queryKey:['ontology-classes']});
      qc.invalidateQueries({queryKey:['ontology-object-properties']});
      // approvedResources pins the canvas to the snapshot taken when a draft pipeline was
      // approved, so a newly created node would never appear. Drop it and let the live
      // playground-resources query drive the canvas again.
      setApprovedResources(null);
      updateChange(reviewTarget.messageId,reviewTarget.index,current=>current.kind==='createClass'?{...current,status:'approved',result:rendered}:current);
      closeReview();
    }catch(error){setApproveError(errMsg(error));}
    finally{setApproveBusy(false);}
  };
  const approveDraft=async()=>{
    if(!draftResources.length||!draftJsonld)return;
    // A draft that defines its own classes must go through /import/ontology first, or
    // /import/pipeline rejects its instances as "classes not defined in the ontology"
    // (and its inference fallback would mint stripped, label-less classes).
    const schemaNodes=draftJsonld.filter(node=>((node as JsonLdNode)['@type']??[]).includes(OWL+'Class'));
    if(schemaNodes.length){
      await api.importOntology(jsonldFile(schemaNodes,'playground-generated-ontology.jsonld'),false);
      qc.invalidateQueries({queryKey:['ontology']});
      qc.invalidateQueries({queryKey:['ontology-classes']});
    }
    const instanceNodes=schemaNodes.length?draftJsonld.filter(node=>!schemaNodes.includes(node)):draftJsonld;
    const file=new File([JSON.stringify(instanceNodes,null,2)],'playground-generated-pipeline.jsonld',{type:'application/ld+json'});
    await importDraft.mutateAsync(file);
    setApprovedResources(draftResources);
    setMode('imported');
    setMatrixSelectedId(draftResources[0]?.id??'');
    appendMessage('assistant','Approved. The generated draft was imported and is now loaded into the Playground canvas.');
  };
  const updateDraftResource=(id:string,classIri:string,comment:string,facts:MatrixFact[])=>{
    setDraftJsonld(current=>current?.map(node=>{
      if((node as {'@id'?:unknown})['@id']!==id)return node;
      const next:Record<string,unknown>={...node,'@type':[classIri]};
      if(comment.trim())next[RDFS_COMMENT]=[{'@value':comment.trim()}];
      else delete next[RDFS_COMMENT];
      for(const fact of facts)delete next[fact.predicate];
      for(const fact of facts){
        if(!fact.value.trim())continue;
        const value={'@value':fact.value};
        next[fact.predicate]=[...((Array.isArray(next[fact.predicate])?next[fact.predicate] as unknown[]:next[fact.predicate]?[next[fact.predicate]]:[])),value];
      }
      return next;
    })??current);
    setViewerResource(current=>current&&current.id===id?{...current,classIri,classLabel:classRowsLabel(classIri,ontologyClassLabels,draftResources),resourceComment:comment,facts:[...current.facts.filter(fact=>fact.direction!=='out'||fact.valueType==='uri'),...facts]}:current);
  };
  const asJsonLdArray=(value:unknown)=>Array.isArray(value)?value:value?[value]:[];
  const upsertDraftRelationship=(source:string,target:string,predicate:string)=>{
    setDraftJsonld(current=>current?.map(node=>{
      if((node as {'@id'?:unknown})['@id']!==source)return node;
      const next={...node} as Record<string,unknown>;
      const values=asJsonLdArray(next[predicate]);
      if(!values.some(value=>typeof value==='object'&&value!==null&&(value as {'@id'?:unknown})['@id']===target))next[predicate]=[...values,{'@id':target}];
      return next;
    })??current);
  };
  const removeDraftRelationship=(source:string,target:string,predicate:string)=>{
    setDraftJsonld(current=>current?.map(node=>{
      if((node as {'@id'?:unknown})['@id']!==source)return node;
      const next={...node} as Record<string,unknown>;
      const values=asJsonLdArray(next[predicate]).filter(value=>!(typeof value==='object'&&value!==null&&(value as {'@id'?:unknown})['@id']===target));
      if(values.length)next[predicate]=values;
      else delete next[predicate];
      return next;
    })??current);
  };
  const connectDraft=(connection:Connection)=>{
    if(!connection.source||!connection.target)return;
    const predicate=linkPredicate;
    const edgeColor=relationshipColor(predicate,theme==='light');
    setDraftEdges(edges=>arrangeParallelEdges(addEdge({...connection,sourceHandle:connection.sourceHandle||'bottom',targetHandle:connection.targetHandle||'top',id:`${connection.source}|${predicate}|${connection.target}`,label:relationLabelFromRows(predicate,propertyRows),type:'relationship',data:{predicate},reconnectable:true,markerEnd:{type:MarkerType.ArrowClosed,color:edgeColor},style:{stroke:edgeColor,strokeWidth:2},labelStyle:{fill:theme==='light'?'#26364d':'#d9e5f7',fontWeight:650}},edges)));
    upsertDraftRelationship(connection.source,connection.target,predicate);
  };
  const reconnectDraft=(oldEdge:Edge,connection:Connection)=>{
    if(!connection.source||!connection.target)return;
    const predicate=relationPredicate(oldEdge);
    removeDraftRelationship(oldEdge.source,oldEdge.target,predicate);
    upsertDraftRelationship(connection.source,connection.target,predicate);
    const nextId=`${connection.source}|${predicate}|${connection.target}`;
    setDraftEdges(edges=>arrangeParallelEdges(edges.map(edge=>edge.id===oldEdge.id?{...edge,...connection,sourceHandle:connection.sourceHandle||'bottom',targetHandle:connection.targetHandle||'top',id:nextId}:edge)));
  };
  const deleteDraftEdges=(items:Edge[])=>{
    items.forEach(edge=>removeDraftRelationship(edge.source,edge.target,relationPredicate(edge)));
    if(items.some(edge=>edge.id===selectedDraftEdge?.id))setSelectedDraftEdge(null);
  };
  const deleteSelectedDraftEdge=()=>{
    if(!selectedDraftEdge)return;
    const from=String(draftNodes.find(node=>node.id===selectedDraftEdge.source)?.data.label??compact(selectedDraftEdge.source));
    const to=String(draftNodes.find(node=>node.id===selectedDraftEdge.target)?.data.label??compact(selectedDraftEdge.target));
    if(!window.confirm(`Delete relationship arrow from "${from}" to "${to}"?`))return;
    const edge=selectedDraftEdge;
    setDraftEdges(current=>current.filter(item=>item.id!==edge.id));
    deleteDraftEdges([edge]);
  };
  const changeDraftEdgeRelationship=(edge:Edge,newPredicate:string)=>{
    const oldPredicate=relationPredicate(edge);
    if(newPredicate===oldPredicate)return;
    removeDraftRelationship(edge.source,edge.target,oldPredicate);
    upsertDraftRelationship(edge.source,edge.target,newPredicate);
    const edgeColor=relationshipColor(newPredicate,theme==='light');
    const nextEdge={...edge,id:`${edge.source}|${newPredicate}|${edge.target}`,label:relationLabelFromRows(newPredicate,propertyRows),data:{...edge.data,predicate:newPredicate},markerEnd:{type:MarkerType.ArrowClosed,color:edgeColor},style:{...edge.style,stroke:edgeColor,strokeWidth:2}} as Edge;
    setDraftEdges(current=>arrangeParallelEdges(current.map(item=>item.id===edge.id?nextEdge:item)));
    setSelectedDraftEdge(nextEdge);
    setLinkPredicate(newPredicate);
  };
  const chooseClarificationOption=(question:ClarificationQuestion,option:string)=>{
    setPrompt(current=>[current,`${question.question} ${option}`].filter(Boolean).join('\n'));
    requestAnimationFrame(()=>chatInputRef.current?.focus());
  };

  useEffect(()=>{setMatrixSelectedId(current=>draftResources.some(resource=>resource.id===current)?current:(draftResources[0]?.id??current))},[draftResources]);
  useEffect(()=>{
    const currentPositions=new Map(draftNodes.map(node=>[node.id,node.position]));
    const classColumns=new Map<string,number>();
    const classRows=new Map<string,number>();
    const nodes=draftResources.map(resource=>{
      const classIndex=classColumns.has(resource.classIri)?classColumns.get(resource.classIri)!:classColumns.set(resource.classIri,classColumns.size).get(resource.classIri)!;
      const row=classRows.get(resource.classIri)??0;
      classRows.set(resource.classIri,row+1);
      return {id:resource.id,type:'pipeline',position:currentPositions.get(resource.id)??{x:classIndex*260,y:row*150},data:{label:resource.label,type:resource.classLabel,typeIri:resource.classIri},style:{background:nodeColor(classIndex,theme==='light'),color:'white',border:'1px solid #ffffff55',boxShadow:'0 10px 22px #00000033',borderRadius:10,width:180,padding:12}} as Node;
    });
    const nodeIds=new Set(nodes.map(node=>node.id));
    const edges=arrangeParallelEdges(draftResources.flatMap(resource=>resource.facts.filter(fact=>fact.direction==='out'&&fact.valueType==='uri'&&nodeIds.has(fact.value)).map(fact=>{const color=relationshipColor(fact.predicate,theme==='light');return{id:`${resource.id}|${fact.predicate}|${fact.value}`,source:resource.id,target:fact.value,sourceHandle:'bottom',targetHandle:'top',label:relationLabelFromRows(fact.predicate,propertyRows),type:'relationship',data:{predicate:fact.predicate},reconnectable:true,markerEnd:{type:MarkerType.ArrowClosed,color},style:{stroke:color,strokeWidth:2},labelStyle:{fill:theme==='light'?'#26364d':'#d9e5f7',fontWeight:650}} as Edge})));
    setDraftNodes(nodes);
    setDraftEdges(edges);
  },[draftResources,propertyRows.length,theme]);

  return <Page className="playground-page" title="Ontology Playground" description="Explore existing User Layer pipelines or draft a new pipeline through a chat-first workspace." actions={<div className="playground-header-controls">
    <label>Provider<select value={provider} onChange={event=>changeProvider(event.target.value as LlmProvider)}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="ollama">Ollama</option><option value="llm">Self-hosted (LLM_*)</option></select></label>
    <label>Model<select value={selectedModel} onChange={event=>setSelectedModel(event.target.value)}>{providerModels[provider].map(option=><option key={option} value={option}>{option}</option>)}</select></label>
    <label className="playground-custom-model">Model code<input value={customModel} onChange={event=>setCustomModel(event.target.value)} placeholder={`Paste ${provider} model code…`}/></label>
    <button className="secondary playground-theme-toggle" onClick={toggleTheme} title={`Switch to ${theme==='dark'?'light':'dark'} theme`}>{theme==='dark'?<Sun size={15}/>:<Moon size={15}/>} {theme==='dark'?'Light':'Dark'}</button>
  </div>}>
    <ErrorBox error={graph.error||clarify.error||generate.error||importDraft.error} />
    <div className="playground-shell card">
      <div className="playground-file-server">
        <div className="file-server-title"><FolderOpen size={18}/><span>File Explorer</span></div>
        <input ref={uploadInputRef} type="file" multiple style={{ display: 'none' }} onChange={event => { uploadArtifacts(event.target.files); event.currentTarget.value = ''; }} />
        <button type="button" className="artifact-upload-button" onClick={() => uploadInputRef.current?.click()}><UploadCloud size={15}/>Upload to {folderName(activeFolder)}</button>
        <div className={`artifact-tree${dragActive ? ' drag-active' : ''}`}
          onDragOver={event => { event.preventDefault(); if (!dragActive) setDragActive(true); }}
          onDragLeave={event => { if (event.currentTarget === event.target) setDragActive(false); }}
          onDrop={event => { event.preventDefault(); setDragActive(false); uploadArtifacts(event.dataTransfer.files); }}>
          <button className={`artifact-folder${activeFolder === 'root' ? ' active' : ''}`} onClick={() => setActiveFolder('root')}><FolderOpen size={15}/><strong>Playground root</strong><span>{artifacts.filter(item => item.folder === 'root').length}</span></button>
          <button className={`artifact-folder${activeFolder === 'input_artifacts' ? ' active' : ''}`} onClick={() => setActiveFolder('input_artifacts')}><FolderOpen size={15}/><strong>input_artifacts</strong><span>{artifacts.filter(item => item.folder === 'input_artifacts').length}</span></button>
          <button className={`artifact-folder${activeFolder === 'output' ? ' active' : ''}`} onClick={() => setActiveFolder('output')}><FolderOpen size={15}/><strong>output</strong><span>{artifacts.filter(item => item.folder === 'output').length}</span></button>
          <div className="artifact-list">
            {artifacts.filter(item => item.folder === activeFolder).length === 0 ? <div className="artifact-empty">No files in this location.</div> : artifacts.filter(item => item.folder === activeFolder).map(artifact => <div className="artifact-file" key={artifact.id} title={artifact.file.name}>
              <FileIcon size={14}/>
              <span><strong>{artifact.file.name}</strong><small>{fileSize(artifact.file.size)}</small></span>
              <button title="Download file" onClick={() => downloadArtifact(artifact)}><Download size={13}/></button>
              <button title="Remove file" onClick={() => setArtifacts(current => current.filter(item => item.id !== artifact.id))}><Trash2 size={13}/></button>
            </div>)}
          </div>
        </div>
      </div>
      <section className="playground-workspace">
        {mode === 'home' && <div className="playground-choice-screen">
          <button className="playground-choice-card" onClick={() => setMode('select')}><GitBranch size={22}/><strong>Fetch a pipeline</strong><span>Select an existing resource graph from the User Layer and import it into the playground.</span></button>
          <button className="playground-choice-card" onClick={startCreatePipeline}><Plus size={22}/><strong>Create a new pipeline</strong><span>Describe the process or paste/attach code. A big multi-step script is split into one code-bearing node per step; a description or snippet makes a single node.</span></button>
        </div>}
        {mode === 'select' && <div className="playground-workarea">
          {canvasRevertControl}
          <div className="playground-split">
            <div className="playground-resource-list">
              <div className="playground-panel-title">User Layer resources</div>
              {visibleResources.map(resource => <button key={resource.id} className={resource.id === selected.id ? 'active' : ''} onClick={() => setSelectedId(resource.id)}><i/><span><strong>{resource.label}</strong><small>{resource.typeLabel}</small></span></button>)}
            </div>
            <div className="playground-canvas-panel">
              <div className="playground-canvas-head"><div><strong>{selected.label}</strong><span>{selected.typeLabel}</span></div><div className="playground-canvas-head-actions"><button className="secondary" onClick={() => setAttachOpen(open => !open)}><FileCode2 size={15}/>{attachOpen ? 'Close' : 'Add code from script'}</button><button onClick={() => { setApprovedResources(null); setMode('imported'); }}>Import to playground</button></div></div>
              {attachOpen
                ? <AttachCodeStudio onClose={() => setAttachOpen(false)} onApplied={n => { qc.invalidateQueries({ queryKey: ['playground-resources'] }); qc.invalidateQueries({ queryKey: ['pipeline'] }); qc.invalidateQueries({ queryKey: ['pipeline-matrix'] }); qc.invalidateQueries({ queryKey: ['cg-code'] }); setAttachOpen(false); window.alert(`Attached code to ${n} stage(s). Open a stage → Code tab to see it.`); }} />
                : <MatrixHybridGraph resources={model.resources} pipelineNodes={model.nodes} pipelineEdges={model.edges} selectedId={selectedId || model.resources[0]?.id || ''} setSelectedId={setSelectedId} onResourceClick={resource=>{setViewerResource(resource);setViewerPreview(false)}} theme={theme} showProcessList={false} showHeader={false}/>}
            </div>
          </div>
          <PlaygroundChatPanel messages={chatMessages} busy={chatBusy} prompt={prompt} setPrompt={setPrompt} onSend={()=>void handleChatSend()} chatInputRef={chatInputRef} onAttach={files=>uploadArtifacts(files)} activeFolder={activeFolder} onChooseOption={chooseClarificationOption} onViewDiff={setDiffChange} onRevert={(messageId,index)=>void revertChange(messageId,index)} onReview={(messageId,index)=>setReviewTarget({messageId,index})} />
        </div>}
        {mode === 'create' && <div className="playground-chat-stage">
          <div className="playground-chat-thread">
            {chatMessages.map(message=><div className={`playground-chat-message ${message.role}`} key={message.id}>
              <MessageSquareText size={18}/>
              <div><strong>{message.role==='assistant'?'Agent':'You'}</strong><ChatText text={message.text}/>{message.questions?.some(question=>question.options?.length)?<div className="playground-question-options">{message.questions.map((question,index)=>question.options?.length?<div className="playground-question-option-group" key={`${message.id}-${index}`}><span>{question.question}</span><div>{question.options.map(option=><button type="button" className="secondary" key={option} onClick={()=>chooseClarificationOption(question,option)}>{option}</button>)}</div></div>:null)}</div>:null}</div>
            </div>)}
            {(clarify.isPending||generate.isPending)&&<div className="playground-chat-message assistant"><Wand2 size={18}/><div><strong>Agent</strong><p>{clarify.isPending?'Checking whether clarification is needed...':'Generating the pipeline draft...'}</p></div></div>}
          </div>
        </div>}
        {mode === 'generated' && <div className="playground-imported">
          <div className="playground-suggestion-banner"><FileCode2 size={17}/><span>Generated draft. Inspect resources, ask for changes in chat, or approve it into the Playground canvas.</span><button disabled={!draftResources.length||importDraft.isPending} onClick={() => void approveDraft()}>{importDraft.isPending?'Approving...':'Approve'}</button></div>
          <div className="flow card playground-draft-flow"><ReactFlow nodes={draftNodes} edges={draftEdges} nodeTypes={draftNodeTypes} edgeTypes={draftEdgeTypes} onNodesChange={(changes:NodeChange[])=>setDraftNodes(nodes=>applyNodeChanges(changes,nodes))} onEdgesChange={(changes:EdgeChange[])=>setDraftEdges(edges=>applyEdgeChanges(changes,edges))} onNodeClick={(_,node)=>{setSelectedDraftEdge(null);const resource=draftResources.find(item=>item.id===node.id);if(resource){setViewerResource(resource);setViewerPreview(true)}}} onEdgeClick={(_,edge)=>{setSelectedDraftEdge(edge);setLinkPredicate(relationPredicate(edge))}} onConnect={connectDraft} onReconnect={reconnectDraft} onEdgesDelete={deleteDraftEdges} edgesReconnectable reconnectRadius={18} connectionMode={ConnectionMode.Loose} fitView deleteKeyCode="Delete"><Background/></ReactFlow></div>
        </div>}
        {mode === 'imported' && <div className="playground-workarea">
          {canvasRevertControl}
          <div className="playground-imported">
            {approvedResources?<div className="flow card playground-draft-flow"><ReactFlow nodes={draftNodes} edges={draftEdges} nodeTypes={draftNodeTypes} edgeTypes={draftEdgeTypes} onNodesChange={(changes:NodeChange[])=>setDraftNodes(nodes=>applyNodeChanges(changes,nodes))} onEdgesChange={(changes:EdgeChange[])=>setDraftEdges(edges=>applyEdgeChanges(changes,edges))} onNodeClick={(_,node)=>{setSelectedDraftEdge(null);const resource=draftResources.find(item=>item.id===node.id);if(resource){setViewerResource(resource);setViewerPreview(true)}}} onEdgeClick={(_,edge)=>{setSelectedDraftEdge(edge);setLinkPredicate(relationPredicate(edge))}} onConnect={connectDraft} onReconnect={reconnectDraft} onEdgesDelete={deleteDraftEdges} edgesReconnectable reconnectRadius={18} connectionMode={ConnectionMode.Loose} fitView deleteKeyCode="Delete"><Background/></ReactFlow></div>:<MatrixHybridGraph resources={importedResources} pipelineNodes={model.nodes} pipelineEdges={model.edges} selectedId={selectedId || model.resources[0]?.id || ''} setSelectedId={setSelectedId} onResourceClick={resource=>{setViewerResource(resource);setViewerPreview(false)}} theme={theme} showProcessList={false} showHeader={false}/>}
          </div>
          <PlaygroundChatPanel messages={chatMessages} busy={chatBusy} prompt={prompt} setPrompt={setPrompt} onSend={()=>void handleChatSend()} chatInputRef={chatInputRef} onAttach={files=>uploadArtifacts(files)} activeFolder={activeFolder} onChooseOption={chooseClarificationOption} onViewDiff={setDiffChange} onRevert={(messageId,index)=>void revertChange(messageId,index)} onReview={(messageId,index)=>setReviewTarget({messageId,index})} />
        </div>}
        {mode === 'suggest' && <div className="playground-imported">
          <div className="playground-suggestion-banner"><FileCode2 size={17}/><span>Suggested changes are staged here.</span><button disabled={importDraft.isPending} onClick={() => void approveDraft()}>{importDraft.isPending?'Approving...':'Approve'}</button></div>
          <div className="flow card playground-draft-flow"><ReactFlow nodes={draftNodes} edges={draftEdges} nodeTypes={draftNodeTypes} edgeTypes={draftEdgeTypes} onNodesChange={(changes:NodeChange[])=>setDraftNodes(nodes=>applyNodeChanges(changes,nodes))} onEdgesChange={(changes:EdgeChange[])=>setDraftEdges(edges=>applyEdgeChanges(changes,edges))} onNodeClick={(_,node)=>{setSelectedDraftEdge(null);const resource=draftResources.find(item=>item.id===node.id);if(resource){setViewerResource(resource);setViewerPreview(true)}}} onEdgeClick={(_,edge)=>{setSelectedDraftEdge(edge);setLinkPredicate(relationPredicate(edge))}} onConnect={connectDraft} onReconnect={reconnectDraft} onEdgesDelete={deleteDraftEdges} edgesReconnectable reconnectRadius={18} connectionMode={ConnectionMode.Loose} fitView deleteKeyCode="Delete"><Background/></ReactFlow></div>
        </div>}
        {!grounded && <div className="playground-chatbar">
          <label className="chat-attach" title={`Attach file to ${folderName(activeFolder)}`}><Paperclip size={17}/><input type="file" multiple onChange={event => { uploadArtifacts(event.target.files); event.currentTarget.value = ''; }}/></label>
          <textarea ref={chatInputRef} value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey||event.ctrlKey)) { event.preventDefault(); void handleSend(); } }} placeholder={draftJsonld ? 'Ask for changes to the generated draft…' : pendingQuestions.length ? 'Answer the clarification questions here…' : 'Describe the pipeline, paste code, SQL, config, or notes here…'} />
          <button disabled={clarify.isPending||generate.isPending} onClick={() => void handleSend()}><Send size={16}/>{generate.isPending?'Generating...':'Send'}</button>
        </div>}
      </section>
    </div>
    {diffChange&&<ChatActionDiffModal change={diffChange} theme={theme} onClose={()=>setDiffChange(null)}/>}
    {reviewedResult&&<ClassProposalModal result={reviewedResult} classOptions={classOptions} busy={approveBusy} error={approveError} onApprove={rendered=>void approveClassProposal(rendered)} onClose={closeReview}/>}
    {selectedDraftEdge&&<div className="modal-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setSelectedDraftEdge(null)}}><div className="modal edge-editor-modal" role="dialog" aria-modal="true" aria-labelledby="playground-edge-editor-title"><div className="modal-header"><div><h2 id="playground-edge-editor-title">Relationship manager</h2><p>Change the selected arrow's RDF relationship.</p></div><button className="icon-button" title="Close" onClick={()=>setSelectedDraftEdge(null)}><X size={19}/></button></div><div className="modal-body edge-editor-body"><div className="edge-summary"><div><span>From</span><strong>{String(draftNodes.find(node=>node.id===selectedDraftEdge.source)?.data.label??compact(selectedDraftEdge.source))}</strong></div><div><span>To</span><strong>{String(draftNodes.find(node=>node.id===selectedDraftEdge.target)?.data.label??compact(selectedDraftEdge.target))}</strong></div></div><label>Relationship<select value={relationPredicate(selectedDraftEdge)} onChange={event=>changeDraftEdgeRelationship(selectedDraftEdge,event.target.value)}>{propertyRows.map(row=><option key={row.property.value} value={row.property.value}>{row.label?.value??compact(row.property.value)} — {compact(row.property.value)}</option>)}</select></label><p className="hint">Generated relationships are stored on the draft JSON-LD until you approve or revise the draft.</p></div><div className="modal-footer"><button className="secondary danger-button edge-delete-button" onClick={deleteSelectedDraftEdge}><Trash2 size={15}/>Delete relationship</button><button className="secondary" onClick={()=>setSelectedDraftEdge(null)}>Close</button></div></div></div>}
    {viewerResource && (viewerPreview?<PlaygroundPreviewResourceViewer resource={viewerResource} resources={draftResources} onSave={updateDraftResource} onClose={() => setViewerResource(null)}/>:<PlaygroundResourceViewer resource={viewerResource} resources={model.resources} theme={theme} onClose={() => setViewerResource(null)} inputArtifacts={inputArtifactFiles} onOutputs={addOutputs}/>)}
  </Page>;
}
