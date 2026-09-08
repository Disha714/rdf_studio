import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hand, Layers3, Link2, Maximize2, MousePointer2, Plus, Save, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { addEdge, applyEdgeChanges, applyNodeChanges, Background, BaseEdge, ConnectionMode, Handle, MarkerType, MiniMap, Panel, Position, ReactFlow, SelectionMode, useReactFlow, type Connection, type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, compact, displayName, type Binding } from '../api';
import { ErrorBox, Page } from '../components/Page';
import { useTheme } from '../theme';

const NS='https://w3id.org/rdf-pipeline-studio#';
const RESOURCE_NS='https://example.org/pipeline/';
const PIPELINE_LAYOUT_STORAGE='rdf-pipeline-studio:pipeline-layout';
const XSD='http://www.w3.org/2001/XMLSchema#';
const TEXTAREA_TYPE=`${NS}TextArea`;
const DCTERMS='http://purl.org/dc/terms/';
const QUERY=`PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rps: <${NS}> SELECT ?node ?type ?label ?p ?target ?sourceHandle ?targetHandle ?canvasX ?canvasY WHERE { ?type a owl:Class . ?node a ?type . FILTER(?node != ?type) OPTIONAL {?node rdfs:label ?label} OPTIONAL {?node ?p ?target . FILTER(isIRI(?target)) OPTIONAL { ?connection rdf:subject ?node ; rdf:predicate ?p ; rdf:object ?target . OPTIONAL {?connection rps:sourceHandle ?sourceHandle} OPTIONAL {?connection rps:targetHandle ?targetHandle} }} OPTIONAL {?node rps:canvasX ?canvasX} OPTIONAL {?node rps:canvasY ?canvasY} } ORDER BY ?type ?label ?node`;
const MATRIX_QUERY=`PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> PREFIX rps: <${NS}>
PREFIX dcterms: <${DCTERMS}>
SELECT ?node ?nodeLabel ?nodeComment ?nodeDescription ?class ?classLabel ?classComment ?classDescription ?predicate ?value ?valueLabel ?valueComment ?valueDescription ?valueClass ?valueClassLabel ?valueClassComment ?valueClassDescription ?direction WHERE {
  ?class a owl:Class . ?node a ?class . FILTER(?node != ?class)
  OPTIONAL { ?node rdfs:label ?nodeLabel }
  OPTIONAL { ?node rdfs:comment ?nodeComment }
  OPTIONAL { ?node dcterms:description ?nodeDescription }
  OPTIONAL { ?class rdfs:label ?classLabel }
  OPTIONAL { ?class rdfs:comment ?classComment }
  OPTIONAL { ?class dcterms:description ?classDescription }
  OPTIONAL {
    {
      ?node ?predicate ?value . BIND("out" AS ?direction)
      FILTER(?predicate NOT IN (rdf:type, rdfs:label, rdfs:comment, rps:canvasX, rps:canvasY, rps:layerX, rps:layerY, rps:sourceHandle, rps:targetHandle, rps:resourceDomain))
    } UNION {
      ?value ?predicate ?node . BIND("in" AS ?direction)
      FILTER(?predicate NOT IN (rdf:type, rdfs:label, rdfs:comment, rps:canvasX, rps:canvasY, rps:layerX, rps:layerY, rps:sourceHandle, rps:targetHandle, rps:resourceDomain))
    }
    OPTIONAL { ?value rdfs:label ?valueLabel }
    OPTIONAL { ?value rdfs:comment ?valueComment }
    OPTIONAL { ?value dcterms:description ?valueDescription }
    OPTIONAL { ?value a ?valueClass . ?valueClass a owl:Class . FILTER(?value != ?valueClass) OPTIONAL { ?valueClass rdfs:label ?valueClassLabel } OPTIONAL { ?valueClass rdfs:comment ?valueClassComment } OPTIONAL { ?valueClass dcterms:description ?valueClassDescription } }
  }
} ORDER BY ?classLabel ?class ?nodeLabel ?node ?direction ?predicate ?value`;
const CLASSES_QUERY=`PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> SELECT ?class ?label WHERE { ?class a owl:Class . OPTIONAL { ?class rdfs:label ?label } } ORDER BY ?label ?class`;
const PROPERTIES_QUERY=`PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> SELECT ?property ?label WHERE { ?property a owl:ObjectProperty . FILTER NOT EXISTS { ?property rdfs:domain ?classPropertyDomain } OPTIONAL { ?property rdfs:label ?label } } ORDER BY ?label ?property`;
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
const datatypeOptions=[`${XSD}string`,TEXTAREA_TYPE,`${XSD}integer`,`${XSD}decimal`,`${XSD}boolean`,`${XSD}date`,`${XSD}dateTime`,`${XSD}anyURI`];
const nodeColor=(index:number,light:boolean)=>{const palettes=light
  ?['#2563eb','#0f766e','#7c3aed','#b45309','#be185d','#047857','#0369a1','#a16207','#9333ea','#15803d','#c2410c','#475569']
  :['#4f7cff','#1aa99a','#9b74ff','#d89124','#df4e87','#25a66f','#23a6d5','#c9a227','#b86cff','#6fbf45','#e06a35','#64748b'];
  return palettes[index%palettes.length]};
const safeLocal=(value:string)=>value.trim().replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-|-$/g,'')||`resource-${Date.now()}`;
const propertyLocal=(value:string)=>value.trim().replace(/[^A-Za-z0-9._~-]/g,'');
const validLocal=(value:string)=>/^[A-Za-z_][A-Za-z0-9._~-]*$/.test(value);
const literal=(value:string)=>`"${value.replaceAll('\\','\\\\').replaceAll('"','\\"')}"`;
const typedLiteral=(value:string,datatype:string)=>`${literal(value)}^^<${datatype}>`;
const actualDatatype=(datatype:string)=>datatype===TEXTAREA_TYPE?`${XSD}string`:datatype;
const classLabel=(iri:string,label?:string)=>displayName(iri,label);
const typeLabel=(iri:string)=>iri===TEXTAREA_TYPE?'TextArea':iri.startsWith(XSD)?`xsd:${iri.slice(XSD.length)}`:compact(iri);
type Tool='pan'|'select';
type ViewMode='graph'|'matrix';
type AttributeDef={iri:string;label:string;datatype:string;range:string;valueKind:'literal'|'resource';resourceSpecific:boolean;required:boolean;multiple:boolean;widget:string;values:string[]};
type ResourcePropertyDraft={name:string;label:string;typeIri:string;value:string};
type ClassLegendItem={iri:string;label:string;color:string;count:number};
type PropertyRow={property:{value:string};label?:{value:string}};
export type MatrixFact={predicate:string;predicateLabel:string;value:string;valueLabel:string;valueType:string;valueClassIri:string;valueClassLabel:string;direction:'out'|'in'};
export type MatrixResource={id:string;label:string;classLabel:string;classIri:string;resourceComment:string;classComment:string;facts:MatrixFact[]};

function PipelineNode({data}:NodeProps){return <><Handle id="bottom" type="source" position={Position.Bottom} title="Input or output"/><Handle id="top" type="source" position={Position.Top} title="Input or output"/><div className="pipeline-node-content"><strong>{String(data.label)}</strong><small>{String(data.type)}</small></div></>}
const nodeTypes={pipeline:PipelineNode};
function MatrixNode({data}:NodeProps){return <><Handle id="left-source" type="source" position={Position.Left}/><Handle id="left-target" type="target" position={Position.Left}/><Handle id="right-source" type="source" position={Position.Right}/><Handle id="right-target" type="target" position={Position.Right}/><div className="pipeline-node-content"><strong>{String(data.label)}</strong><small>{String(data.type)}</small></div></>}
const matrixNodeTypes={matrixNode:MatrixNode};
const connectionIri=(source:string,predicate:string,target:string)=>{let hash=2166136261;for(const char of `${source}|${predicate}|${target}`){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619)}return `${RESOURCE_NS}connection-${(hash>>>0).toString(16)}`};
const connectionMetadata=(source:string,predicate:string,target:string,sourceHandle='bottom',targetHandle='top')=>{const iri=connectionIri(source,predicate,target);return `<${iri}> a <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> ; <http://www.w3.org/1999/02/22-rdf-syntax-ns#subject> <${source}> ; <http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate> <${predicate}> ; <http://www.w3.org/1999/02/22-rdf-syntax-ns#object> <${target}> ; <${NS}sourceHandle> ${literal(sourceHandle)} ; <${NS}targetHandle> ${literal(targetHandle)}`};

function RelationshipEdge({sourceX,sourceY,targetX,targetY,label,labelStyle,style,markerEnd,data,selected}:EdgeProps){
  const offset=Number(data?.parallelOffset??25);const dx=targetX-sourceX;const dy=targetY-sourceY;const length=Math.max(Math.hypot(dx,dy),1);const controlX=(sourceX+targetX)/2-dy/length*offset;const controlY=(sourceY+targetY)/2+dx/length*offset;const path=`M ${sourceX},${sourceY} Q ${controlX},${controlY} ${targetX},${targetY}`;const labelX=.25*sourceX+.5*controlX+.25*targetX;const labelY=.25*sourceY+.5*controlY+.25*targetY;
  return <BaseEdge path={path} label={label} labelX={labelX} labelY={labelY} labelStyle={labelStyle} labelShowBg labelBgPadding={[7,4]} labelBgBorderRadius={5} style={{...style,strokeWidth:selected?3:style?.strokeWidth}} markerEnd={markerEnd} interactionWidth={28}/>;
}
const edgeTypes={relationship:RelationshipEdge};
const relationshipColor=(iri:string,light:boolean)=>{const palettes=light?['#1d4ed8','#0f766e','#b45309','#be185d','#6d28d9','#047857']:['#7da2ff','#4dd4c6','#f6b94a','#f178ad','#ad8aff','#43c99a'];let hash=0;for(const char of iri)hash=(hash*31+char.charCodeAt(0))|0;return palettes[Math.abs(hash)%palettes.length]};
function arrangeParallelEdges(edges:Edge[]){const groups=new Map<string,Edge[]>();for(const edge of edges){const key=`${edge.source}|${edge.target}`;groups.set(key,[...(groups.get(key)??[]),edge])}return edges.map(edge=>{const siblings=groups.get(`${edge.source}|${edge.target}`)!.sort((a,b)=>a.id.localeCompare(b.id));const index=siblings.findIndex(item=>item.id===edge.id);return{...edge,data:{...edge.data,parallelOffset:25+(index-(siblings.length-1)/2)*65}}})}
function classColumnIndex(typeIri:string,classColumns:Map<string,number>){if(!classColumns.has(typeIri))classColumns.set(typeIri,classColumns.size);return classColumns.get(typeIri)!}
function classColumnPosition(typeIri:string,classColumns:Map<string,number>,classRows:Map<string,number>){const column=classColumnIndex(typeIri,classColumns);const row=classRows.get(typeIri)??0;classRows.set(typeIri,row+1);return{x:column*260,y:row*150}}
function treeLayout(nodes:Node[],edges:Edge[]){
  const byId=new Map(nodes.map(node=>[node.id,node]));
  const children=new Map<string,string[]>();
  const indegree=new Map(nodes.map(node=>[node.id,0]));
  const label=(id:string)=>String(byId.get(id)?.data.label??compact(id));
  for(const edge of edges){
    if(edge.source===edge.target||!byId.has(edge.source)||!byId.has(edge.target))continue;
    children.set(edge.source,[...(children.get(edge.source)??[]),edge.target]);
    indegree.set(edge.target,(indegree.get(edge.target)??0)+1);
  }
  for(const [id,items] of children)children.set(id,[...new Set(items)].sort((a,b)=>label(a).localeCompare(label(b))));
  const roots=[...nodes.map(node=>node.id).filter(id=>(indegree.get(id)??0)===0)].sort((a,b)=>label(a).localeCompare(label(b)));
  const queue=roots.length?roots:[...nodes].sort((a,b)=>label(a.id).localeCompare(label(b.id))).map(node=>node.id);
  const visited=new Set<string>();
  const depth=new Map<string,number>();
  const remaining=new Map(indegree);
  queue.forEach(id=>depth.set(id,0));
  for(let index=0;index<queue.length;index+=1){
    const id=queue[index];
    if(visited.has(id))continue;
    visited.add(id);
    for(const child of children.get(id)??[]){
      depth.set(child,Math.max(depth.get(child)??0,(depth.get(id)??0)+1));
      remaining.set(child,(remaining.get(child)??0)-1);
      if((remaining.get(child)??0)<=0)queue.push(child);
    }
  }
  for(const node of nodes){
    if(!visited.has(node.id)){
      const parents=edges.filter(edge=>edge.target===node.id&&byId.has(edge.source)).map(edge=>depth.get(edge.source)??0);
      depth.set(node.id,parents.length?Math.max(...parents)+1:0);
    }
  }
  const levels=new Map<number,Node[]>();
  for(const node of nodes){
    const level=depth.get(node.id)??0;
    levels.set(level,[...(levels.get(level)??[]),node]);
  }
  const nextPositions=new Map<string,{x:number;y:number}>();
  const rowGap=170,columnGap=240;
  [...levels.entries()].sort((a,b)=>a[0]-b[0]).forEach(([level,items])=>{
    const ordered=items.sort((a,b)=>String(a.data.type).localeCompare(String(b.data.type))||String(a.data.label).localeCompare(String(b.data.label))||a.id.localeCompare(b.id));
    const offset=-((ordered.length-1)*columnGap)/2;
    ordered.forEach((node,index)=>nextPositions.set(node.id,{x:offset+index*columnGap,y:level*rowGap}));
  });
  return nodes.map(node=>({...node,position:nextPositions.get(node.id)??node.position}));
}
function storedLayout(){try{return JSON.parse(window.localStorage.getItem(PIPELINE_LAYOUT_STORAGE)??'{}') as Record<string,{x:number;y:number}>}catch{return{}}}
function storeLayout(nodes:Node[]){try{const current=storedLayout();for(const node of nodes)current[node.id]={x:node.position.x,y:node.position.y};window.localStorage.setItem(PIPELINE_LAYOUT_STORAGE,JSON.stringify(current))}catch{/* ignore unavailable local storage */}}
function patchPipelineCache(data:unknown,nodes:Node[]){const positions=new Map(nodes.map(node=>[node.id,node.position]));if(!data||typeof data!=='object'||(data as {type?:string}).type!=='result')return data;const result=data as {type:'result';results?:{bindings?:Record<string,unknown>[]}};return{...result,results:{...result.results,bindings:(result.results?.bindings??[]).map(row=>{const node=(row as {node?:{value?:string}}).node?.value;const position=node?positions.get(node):undefined;return position?{...row,canvasX:{type:'literal',value:String(position.x)},canvasY:{type:'literal',value:String(position.y)}}:row})}}}

const firstText=(...values:(string|undefined)[])=>values.find(value=>value?.trim())?.trim()??'';
function matrixResources(rows:Binding[]){const map=new Map<string,MatrixResource>();for(const row of rows){const id=row.node?.value;if(!id)continue;const item=map.get(id)??{id,label:displayName(id,row.nodeLabel?.value),classLabel:classLabel(row.class?.value??'',row.classLabel?.value),classIri:row.class?.value??'',resourceComment:firstText(row.nodeComment?.value,row.nodeDescription?.value),classComment:firstText(row.classComment?.value,row.classDescription?.value),facts:[]};item.resourceComment=item.resourceComment||firstText(row.nodeComment?.value,row.nodeDescription?.value);item.classComment=item.classComment||firstText(row.classComment?.value,row.classDescription?.value);const predicate=row.predicate?.value;if(predicate&&row.value){const fact={predicate,predicateLabel:displayName(predicate),value:row.value.value,valueLabel:displayName(row.value.value,row.valueLabel?.value),valueType:row.value.type,valueClassIri:row.valueClass?.value??'',valueClassLabel:classLabel(row.valueClass?.value??'',row.valueClassLabel?.value),direction:row.direction?.value==='in'?'in':'out'} as MatrixFact;if(!item.facts.some(existing=>existing.predicate===fact.predicate&&existing.value===fact.value&&existing.direction===fact.direction))item.facts.push(fact)}map.set(id,item)}return[...map.values()].sort((a,b)=>a.classLabel.localeCompare(b.classLabel)||a.label.localeCompare(b.label))}
function pipelineOrder(resources:MatrixResource[],pipelineNodes:Node[],pipelineEdges:Edge[]){
  if(resources.length<2)return resources;
  const originalIndex=new Map(resources.map((resource,index)=>[resource.id,index]));
  const nodeIds=new Set([...pipelineNodes.map(node=>node.id),...resources.map(resource=>resource.id)]);
  const positions=new Map(pipelineNodes.map(node=>[node.id,node.position]));
  const adjacency=new Map<string,Set<string>>();
  const indegree=new Map<string,number>();
  const addNode=(id:string)=>{if(!adjacency.has(id))adjacency.set(id,new Set());if(!indegree.has(id))indegree.set(id,0)};
  const addOrder=(from:string,to:string)=>{if(from===to||!nodeIds.has(from)||!nodeIds.has(to))return;addNode(from);addNode(to);const targets=adjacency.get(from)!;if(targets.has(to))return;targets.add(to);indegree.set(to,(indegree.get(to)??0)+1)};
  nodeIds.forEach(addNode);
  const upstreamPredicate=(iri:string)=>/(^|[#/:_-])(has)?input|consume|depends?/i.test(compact(iri));
  for(const edge of pipelineEdges){
    const predicate=String(edge.data?.predicate??edge.id.split('|')[1]??'');
    const from=upstreamPredicate(predicate)?edge.target:edge.source;
    const to=upstreamPredicate(predicate)?edge.source:edge.target;
    addOrder(from,to);
  }
  if(!pipelineEdges.length){
    for(const resource of resources)for(const fact of resource.facts.filter(item=>item.valueType==='uri')){
      const source=fact.direction==='in'?fact.value:resource.id;
      const target=fact.direction==='in'?resource.id:fact.value;
      addOrder(upstreamPredicate(fact.predicate)?target:source,upstreamPredicate(fact.predicate)?source:target);
    }
  }
  const compare=(a:string,b:string)=>{
    const pa=positions.get(a),pb=positions.get(b);
    if(pa&&pb){
      const dx=pa.x-pb.x;if(Math.abs(dx)>1)return dx;
      const dy=pa.y-pb.y;if(Math.abs(dy)>1)return dy;
    }
    return (originalIndex.get(a)??Number.MAX_SAFE_INTEGER)-(originalIndex.get(b)??Number.MAX_SAFE_INTEGER);
  };
  const queue=[...indegree.entries()].filter(([,count])=>count===0).map(([id])=>id).sort(compare);
  const order=new Map<string,number>();
  const visited=new Set<string>();
  while(queue.length){
    const id=queue.shift()!;
    if(visited.has(id))continue;
    visited.add(id);
    order.set(id,order.size);
    for(const child of [...(adjacency.get(id)??[])].sort(compare)){
      indegree.set(child,(indegree.get(child)??0)-1);
      if((indegree.get(child)??0)===0)queue.push(child);
    }
    queue.sort(compare);
  }
  for(const id of [...nodeIds].filter(id=>!visited.has(id)).sort(compare))order.set(id,order.size);
  return [...resources].sort((a,b)=>(order.get(a.id)??Number.MAX_SAFE_INTEGER)-(order.get(b.id)??Number.MAX_SAFE_INTEGER)||compare(a.id,b.id));
}


const turtleLiteral=(value:string)=>`"${value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n')}"`;
const xmlEscape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
type RawRdfFormat='ttl'|'jsonld'|'rdf';
const predicateKey=(iri:string)=>iri.startsWith(NS)?iri.slice(NS.length):iri.startsWith('http://www.w3.org/2000/01/rdf-schema#')?`rdfs:${iri.slice('http://www.w3.org/2000/01/rdf-schema#'.length)}`:iri.startsWith('http://www.w3.org/1999/02/22-rdf-syntax-ns#')?`rdf:${iri.slice('http://www.w3.org/1999/02/22-rdf-syntax-ns#'.length)}`:iri;
const xmlPredicateName=(iri:string)=>iri.startsWith(NS)?`rps:${iri.slice(NS.length)}`:iri.startsWith('http://www.w3.org/2000/01/rdf-schema#')?`rdfs:${iri.slice('http://www.w3.org/2000/01/rdf-schema#'.length)}`:iri.startsWith('http://www.w3.org/1999/02/22-rdf-syntax-ns#')?`rdf:${iri.slice('http://www.w3.org/1999/02/22-rdf-syntax-ns#'.length)}`:'rdf:value';
function selectedSubgraphTriples(selected:MatrixResource){
  const triples:{s:string;p:string;o:string;objectType:'iri'|'literal'}[]=[{s:selected.id,p:'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',o:selected.classIri,objectType:'iri'}];
  if(selected.label)triples.push({s:selected.id,p:'http://www.w3.org/2000/01/rdf-schema#label',o:selected.label,objectType:'literal'});
  if(selected.resourceComment)triples.push({s:selected.id,p:'http://www.w3.org/2000/01/rdf-schema#comment',o:selected.resourceComment,objectType:'literal'});
  for(const fact of selected.facts){
    if(fact.direction==='in')triples.push({s:fact.value,p:fact.predicate,o:selected.id,objectType:'iri'});
    else triples.push({s:selected.id,p:fact.predicate,o:fact.value,objectType:fact.valueType==='uri'?'iri':'literal'});
  }
  return triples;
}
function rawRdf(selected:MatrixResource,format:RawRdfFormat){
  const triples=selectedSubgraphTriples(selected);
  if(format==='jsonld'){
    const bySubject=new Map<string,Record<string,unknown>>();
    for(const triple of triples){
      const subject=bySubject.get(triple.s)??{'@id':triple.s};
      const key=triple.p==='http://www.w3.org/1999/02/22-rdf-syntax-ns#type'?'@type':predicateKey(triple.p);
      const value=triple.objectType==='iri'?{'@id':triple.o}:triple.o;
      const current=subject[key];
      subject[key]=current===undefined?value:Array.isArray(current)?[...current,value]:[current,value];
      bySubject.set(triple.s,subject);
    }
    return JSON.stringify({'@context':{rps:NS,rdf:'http://www.w3.org/1999/02/22-rdf-syntax-ns#',rdfs:'http://www.w3.org/2000/01/rdf-schema#'},'@graph':[...bySubject.values()]},null,2);
  }
  if(format==='rdf'){
    const items=triples.map(triple=>{const name=xmlPredicateName(triple.p);return `  <rdf:Description rdf:about="${xmlEscape(triple.s)}">\n    ${triple.objectType==='iri'?`<${name} rdf:resource="${xmlEscape(triple.o)}" />`:`<${name}>${xmlEscape(triple.o)}</${name}>`}\n  </rdf:Description>`}).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" xmlns:rps="${NS}">\n${items}\n</rdf:RDF>`;
  }
  const lines=['@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .','@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',`@prefix rps: <${NS}> .`,''];
  lines.push(...triples.map(triple=>`<${triple.s}> <${triple.p}> ${triple.objectType==='iri'?`<${triple.o}>`:turtleLiteral(triple.o)} .`));
  return lines.join('\n');
}

function MatrixSubgraphToolbar(){
  const flow=useReactFlow();
  return <Panel position="bottom-center" className="pipeline-tools matrix-flow-toolbar">
    <button title="Zoom out" onClick={()=>flow.zoomOut()}><ZoomOut size={17}/></button>
    <button title="Zoom in" onClick={()=>flow.zoomIn()}><ZoomIn size={17}/></button>
    <button title="Fit view" onClick={()=>flow.fitView({padding:.22})}><Maximize2 size={17}/><span>Fit</span></button>
  </Panel>
}

export function MatrixHybridGraph({resources,pipelineNodes,pipelineEdges,selectedId,setSelectedId,onResourceClick,theme,showProcessList=true,showHeader=true}:{resources:MatrixResource[];pipelineNodes:Node[];pipelineEdges:Edge[];selectedId:string;setSelectedId:(id:string)=>void;onResourceClick:(resource:MatrixResource)=>void;theme:'dark'|'light';showProcessList?:boolean;showHeader?:boolean}){
  const [rawOpen,setRawOpen]=useState(false);const [rawFormat,setRawFormat]=useState<RawRdfFormat>('ttl');
  const processResources=resources.filter(resource=>resource.classLabel.toLowerCase().includes('process'));
  const listed=pipelineOrder(processResources.length?processResources:resources,pipelineNodes,pipelineEdges);
  if(!listed.length)return <div className="matrix-hybrid card"><div className="empty">No process resources found for Matrix Hybrid Graph.</div></div>;
  const selected=listed.find(item=>item.id===selectedId)??listed[0];
  const classOrder=new Map<string,number>();
  const rememberClass=(iri:string)=>{if(iri&&!classOrder.has(iri))classOrder.set(iri,classOrder.size)};
  pipelineNodes.forEach(node=>rememberClass(String(node.data.typeIri??'')));
  resources.forEach(resource=>rememberClass(resource.classIri));
  const resourceByIri=new Map(resources.map(resource=>[resource.id,resource]));
  const colorForClass=(iri:string)=>nodeColor(classOrder.get(iri)??classOrder.size,theme==='light');
  const resourceFacts=selected.facts.filter(fact=>fact.valueType==='uri');
  const attributeFacts=selected.facts.filter(fact=>fact.valueType!=='uri');
  const incoming=resourceFacts.filter(fact=>fact.direction==='in');
  const outgoing=resourceFacts.filter(fact=>fact.direction==='out');
  const centerNode:Node={id:selected.id,type:'matrixNode',position:{x:760,y:340},data:{resourceId:selected.id,label:selected.label,type:selected.classLabel,typeIri:selected.classIri},style:{background:colorForClass(selected.classIri),color:'white',border:'1px solid #ffffff66',boxShadow:'0 16px 28px #00000040',borderRadius:14,width:260,padding:14},zIndex:20};
  const related=new Map<string,{fact:MatrixFact;direction:'in'|'out';index:number}>();
  [...incoming,...outgoing].forEach((fact,index)=>{const key=`${fact.direction}:${fact.value}`;if(!related.has(key))related.set(key,{fact,direction:fact.direction,index})});
  const leftCount=incoming.length,rightCount=outgoing.length;
  const nodesForFacts=[...related.values()].map(({fact,direction,index})=>{
    const sameSide=direction==='in'?incoming:outgoing;
    const sideIndex=sameSide.findIndex(item=>item.value===fact.value&&item.predicate===fact.predicate);
    const count=direction==='in'?leftCount:rightCount;
    const y=340-(Math.max(count,1)-1)*135/2+Math.max(sideIndex,0)*135;
    const x=direction==='in'?410:1220;
    const relatedResource=resourceByIri.get(fact.value);
    const color=colorForClass(relatedResource?.classIri||fact.valueClassIri);
    return {id:`${direction}:${fact.value}:${index}`,type:'matrixNode',position:{x,y},data:{resourceId:fact.value,label:fact.valueLabel,type:fact.valueClassLabel||relatedResource?.classLabel||'Resource',typeIri:relatedResource?.classIri||fact.valueClassIri},style:{background:color,color:'white',border:'1px solid #ffffff55',boxShadow:'0 12px 22px #00000030',borderRadius:12,width:230,padding:12}} satisfies Node;
  });
  const graphNodes=[centerNode,...nodesForFacts];
  // React Flow's defaultNodes/defaultEdges only seed its internal state ONCE per
  // `key` - they're uncontrolled, so a re-render with fresh graphNodes/graphEdges
  // (e.g. after renaming a related metric) is silently ignored unless the key
  // itself changes. selected.id alone doesn't change on a related-resource rename,
  // so fold in every label actually shown, giving a real remount only when the
  // displayed data changes (and not on every unrelated re-render, which would
  // otherwise reset any in-progress drag).
  const subgraphKey=`${selected.id}::${selected.label}::${[...related.values()].map(({fact})=>`${fact.value}:${fact.valueLabel}`).join(',')}`;
  const graphEdges=arrangeParallelEdges(resourceFacts.map((fact,index)=>{const relatedEntry=[...related.values()].find(item=>item.fact.value===fact.value&&item.fact.direction===fact.direction);const relatedId=relatedEntry?`${fact.direction}:${fact.value}:${relatedEntry.index}`:'';const source=fact.direction==='in'?relatedId:selected.id;const target=fact.direction==='in'?selected.id:relatedId;const edgeColor=relationshipColor(fact.predicate,theme==='light');return{id:`matrix:${fact.direction}:${fact.predicate}:${fact.value}:${index}`,source,target,sourceHandle:fact.direction==='in'?'right-source':'right-source',targetHandle:fact.direction==='in'?'left-target':'left-target',label:fact.predicateLabel,type:'relationship',data:{predicate:fact.predicate},markerEnd:{type:MarkerType.ArrowClosed,color:edgeColor},style:{stroke:edgeColor,strokeWidth:2.2},labelStyle:{fill:theme==='light'?'#26364d':'#d9e5f7',fontWeight:750},reconnectable:false} satisfies Edge}).filter(edge=>graphNodes.some(node=>node.id===edge.source)&&graphNodes.some(node=>node.id===edge.target)));
  return <div className={`matrix-hybrid card process-subgraph-view${!showProcessList?' matrix-no-process-list':''}${!showHeader?' matrix-no-header':''}`}>
    {showProcessList&&<aside className="matrix-process-list"><div className="matrix-process-list-title">Processes</div>{listed.map(resource=><button key={resource.id} className={`matrix-process-item ${resource.id===selected.id?'active':''}`} onClick={()=>setSelectedId(resource.id)}><i style={{background:colorForClass(resource.classIri)}}/><span><strong>{resource.label}</strong><small>{resource.classLabel}</small></span></button>)}</aside>}
    <section className="matrix-subgraph-panel">{showHeader&&<div className="matrix-subgraph-header"><div><h2>{selected.label}</h2><p>{incoming.length} incoming · {outgoing.length} outgoing · {attributeFacts.length} properties</p>{(selected.resourceComment||selected.classComment)&&<div className="rdf-comment-summary">{selected.resourceComment&&<span><strong>Resource:</strong> {selected.resourceComment}</span>}{selected.classComment&&<span><strong>Class:</strong> {selected.classComment}</span>}</div>}</div><button className="secondary" onClick={()=>setRawOpen(true)}>Show Raw RDF</button></div>}<ReactFlow key={subgraphKey} defaultNodes={graphNodes} defaultEdges={graphEdges} nodeTypes={matrixNodeTypes} edgeTypes={edgeTypes} nodesDraggable nodesConnectable={false} edgesReconnectable={false} onNodeClick={(_,node)=>{const resourceId=String(node.data.resourceId??node.id);const resource=resourceByIri.get(resourceId)??(resourceId===selected.id?selected:undefined);if(resource)onResourceClick(resource)}} fitView minZoom={0.2} maxZoom={1.8}>
      <MatrixSubgraphToolbar/><Background/>
    </ReactFlow>{rawOpen&&<div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setRawOpen(false)}}><div className="modal raw-rdf-modal" role="dialog" aria-modal="true" aria-labelledby="raw-rdf-title"><div className="modal-header"><div><h2 id="raw-rdf-title">Raw RDF</h2><p>Selected process subgraph for {selected.label}</p></div><button className="icon-button" title="Close" onClick={()=>setRawOpen(false)}><X size={19}/></button></div><div className="modal-body raw-rdf-body"><label>Format<select value={rawFormat} onChange={e=>setRawFormat(e.target.value as RawRdfFormat)}><option value="ttl">Turtle (.ttl)</option><option value="jsonld">JSON-LD</option><option value="rdf">RDF/XML (.rdf)</option></select></label><pre>{rawRdf(selected,rawFormat)}</pre></div><div className="modal-footer"><button className="secondary" onClick={()=>navigator.clipboard?.writeText(rawRdf(selected,rawFormat))}>Copy</button><button className="secondary" onClick={()=>setRawOpen(false)}>Close</button></div></div></div>}</section>
  </div>
}

function PipelineCanvasToolbar({tool,setTool,linkPredicate,setLinkPredicate,propertyRows,selectedCount,savePending,openBulkLink,deleteSelected}:{tool:Tool;setTool:(tool:Tool)=>void;linkPredicate:string;setLinkPredicate:(value:string)=>void;propertyRows:PropertyRow[];selectedCount:number;savePending:boolean;openBulkLink:()=>void;deleteSelected:()=>void}){
  const flow=useReactFlow();
  return <Panel position="bottom-center" className="pipeline-tools pipeline-bottom-toolbar">
    <button className={tool==='pan'?'active':''} title="Pan workspace" onClick={()=>setTool('pan')}><Hand size={17}/><span>Pan</span></button>
    <button className={tool==='select'?'active':''} title="Draw a rectangle to select resources" onClick={()=>setTool('select')}><MousePointer2 size={17}/><span>Select</span></button>
    <label className="pipeline-relation-select"><span>Arrow relation</span><select value={linkPredicate} onChange={e=>setLinkPredicate(e.target.value)}>{propertyRows.map(row=><option key={row.property.value} value={row.property.value}>{row.label?.value??compact(row.property.value)}</option>)}</select></label>
    <button title="Link selected resources" disabled={selectedCount<2||savePending} onClick={openBulkLink}><Link2 size={17}/><span>Link{selectedCount>1?` (${selectedCount})`:''}</span></button>
    <button className="delete-tool" title="Delete selected resources" disabled={!selectedCount||savePending} onClick={deleteSelected}><Trash2 size={17}/><span>Delete{selectedCount?` (${selectedCount})`:''}</span></button>
    <span className="toolbar-divider"/>
    <button title="Zoom out" onClick={()=>flow.zoomOut()}><ZoomOut size={17}/></button>
    <button title="Zoom in" onClick={()=>flow.zoomIn()}><ZoomIn size={17}/></button>
    <button title="Fit view" onClick={()=>flow.fitView({padding:.18})}><Maximize2 size={17}/></button>
  </Panel>
}

export function PipelinePage(){
  const {theme}=useTheme();
  const qc=useQueryClient();const graph=useQuery({queryKey:['pipeline'],queryFn:()=>api.query(QUERY)});const matrixQuery=useQuery({queryKey:['pipeline-matrix'],queryFn:()=>api.query(MATRIX_QUERY)});const classes=useQuery({queryKey:['ontology-classes'],queryFn:()=>api.query(CLASSES_QUERY)});const properties=useQuery({queryKey:['ontology-object-properties'],queryFn:()=>api.query(PROPERTIES_QUERY)});
  const [nodes,setNodes]=useState<Node[]>([]);const [edges,setEdges]=useState<Edge[]>([]);const [classLegend,setClassLegend]=useState<ClassLegendItem[]>([]);const [legendExpanded,setLegendExpanded]=useState(false);const [viewMode,setViewMode]=useState<ViewMode>('graph');const [matrixSelectedId,setMatrixSelectedId]=useState('');const [tool,setTool]=useState<Tool>('pan');const [modalOpen,setModalOpen]=useState(false);const [linkModalOpen,setLinkModalOpen]=useState(false);const [selectedResource,setSelectedResource]=useState<Node|null>(null);const [selectedEdge,setSelectedEdge]=useState<Edge|null>(null);const [attributeDraft,setAttributeDraft]=useState<Record<string,string>>({});const [resourceDescriptionDraft,setResourceDescriptionDraft]=useState('');const [resourceLabel,setResourceLabel]=useState('');const [resourceType,setResourceType]=useState('');const [linkPredicate,setLinkPredicate]=useState(`${NS}hasInput`);const [sourceIds,setSourceIds]=useState<Set<string>>(new Set());const [targetIds,setTargetIds]=useState<Set<string>>(new Set());const [newRelationOpen,setNewRelationOpen]=useState(false);const [newRelationName,setNewRelationName]=useState('');const [newRelationLabel,setNewRelationLabel]=useState('');const [propertyFormOpen,setPropertyFormOpen]=useState(false);const [resourceProperty,setResourceProperty]=useState<ResourcePropertyDraft>({name:'',label:'',typeIri:`${XSD}string`,value:''});
  const resourceDetails=useQuery({queryKey:['pipeline-resource',selectedResource?.id],queryFn:()=>api.query(RESOURCE_SCHEMA_QUERY(selectedResource!.id)),enabled:!!selectedResource});
  const resourceMeta=useQuery({queryKey:['pipeline-resource-meta',selectedResource?.id],queryFn:()=>api.query(RESOURCE_META_QUERY(selectedResource!.id)),enabled:!!selectedResource});
  const classRows=classes.data?.type==='result'?classes.data.results?.bindings??[]:[];
  const propertyRows=properties.data?.type==='result'?properties.data.results?.bindings??[]:[];
  const matrixRows=matrixQuery.data?.type==='result'?matrixQuery.data.results?.bindings??[]:[];
  const matrixItems=matrixResources(matrixRows);
  const detailRows=resourceDetails.data?.type==='result'?resourceDetails.data.results?.bindings??[]:[];
  const metaRow=resourceMeta.data?.type==='result'?resourceMeta.data.results?.bindings?.[0]:undefined;
  const resourceComment=firstText(metaRow?.resourceComment?.value,metaRow?.resourceDescription?.value);
  const classComment=firstText(metaRow?.classComment?.value,metaRow?.classDescription?.value);
  const attributes=[...detailRows.reduce((map,row)=>{const iri=row.property?.value;if(!iri)return map;const valueKind=row.valueKind?.value==='resource'?'resource':'literal';const widget=row.widget?.value??'';const item=map.get(iri)??{iri,label:displayName(iri,row.label?.value),datatype:widget==='textarea'?TEXTAREA_TYPE:row.datatype?.value??'http://www.w3.org/2001/XMLSchema#string',range:row.range?.value??'',valueKind,resourceSpecific:row.scope?.value==='resource',required:row.required?.value==='true',multiple:row.multiple?.value==='true',widget,values:[]};if(row.value&&!item.values.includes(row.value.value))item.values.push(row.value.value);map.set(iri,item);return map},new Map<string,AttributeDef>()).values()];
  const propertyTypeOptions=[...datatypeOptions,...classRows.map(row=>row.class.value)];
  const save=useMutation({mutationFn:api.update,onSuccess:()=>{qc.invalidateQueries({queryKey:['pipeline']});qc.invalidateQueries({queryKey:['pipeline-matrix']});qc.invalidateQueries({queryKey:['pipeline-resource']});qc.invalidateQueries({queryKey:['pipeline-resource-meta']});qc.invalidateQueries({queryKey:['graph']});qc.invalidateQueries({queryKey:['ontology']});qc.invalidateQueries({queryKey:['ontology-object-properties']});}});
  const createRelation=useMutation({mutationFn:api.update,onSuccess:()=>{qc.invalidateQueries({queryKey:['ontology-object-properties']});setNewRelationName('');setNewRelationLabel('');setNewRelationOpen(false)}});
  const savePositions=useMutation({mutationFn:api.update,scope:{id:'pipeline-positions'},onSuccess:()=>qc.invalidateQueries({queryKey:['pipeline'],refetchType:'active'})});

  useEffect(()=>{if(!resourceType&&classRows[0])setResourceType(classRows[0].class.value)},[classRows,resourceType]);
  useEffect(()=>{if(!matrixSelectedId&&matrixItems[0])setMatrixSelectedId(matrixItems[0].id)},[matrixItems,matrixSelectedId]);
  useEffect(()=>{if(!selectedResource||resourceMeta.data?.type!=='result')return;setResourceDescriptionDraft(resourceComment)},[resourceMeta.data,selectedResource?.id,resourceComment]);
  useEffect(()=>{if(!selectedResource||resourceDetails.data?.type!=='result')return;const next:Record<string,string>={};for(const attribute of attributes)next[attribute.iri]=attribute.multiple?attribute.values.join('\n'):attribute.values[0]??'';setAttributeDraft(next)},[resourceDetails.data,selectedResource?.id]);
  useEffect(()=>{if(graph.data?.type!=='result')return;const rows=graph.data.results?.bindings??[];const stored=storedLayout();const map=new Map<string,Node>();const edgeMap=new Map<string,Edge>();const classColumns=new Map<string,number>();const classRows=new Map<string,number>();rows.forEach(r=>{const id=r.node.value,typeIri=r.type.value,type=classLabel(typeIri);if(!map.has(id)){const savedX=Number(r.canvasX?.value),savedY=Number(r.canvasY?.value),hasSavedPosition=Number.isFinite(savedX)&&Number.isFinite(savedY);const storedPosition=stored[id];const hasStoredPosition=storedPosition&&Number.isFinite(storedPosition.x)&&Number.isFinite(storedPosition.y);const classIndex=classColumnIndex(typeIri,classColumns);const storedOrSavedPosition=hasStoredPosition?storedPosition:hasSavedPosition?{x:savedX,y:savedY}:undefined;const fallbackPosition=storedOrSavedPosition??classColumnPosition(typeIri,classColumns,classRows);map.set(id,{id,type:'pipeline',position:fallbackPosition,data:{label:displayName(id,r.label?.value),type,typeIri},style:{background:nodeColor(classIndex,theme==='light'),color:'white',border:'1px solid #ffffff55',boxShadow:'0 10px 22px #00000033',borderRadius:10,width:180,padding:12}})}if(r.p&&r.target){const predicate=r.p.value;const edgeColor=relationshipColor(predicate,theme==='light');const eid=`${id}|${predicate}|${r.target.value}`;edgeMap.set(eid,{id:eid,source:id,target:r.target.value,sourceHandle:r.sourceHandle?.value||'bottom',targetHandle:r.targetHandle?.value||'top',label:displayName(predicate),type:'relationship',data:{predicate},reconnectable:true,markerEnd:{type:MarkerType.ArrowClosed,color:edgeColor},style:{stroke:edgeColor,strokeWidth:2},labelStyle:{fill:theme==='light'?'#26364d':'#d9e5f7',fontWeight:650}})}});const legend=[...classColumns.entries()].sort((a,b)=>a[1]-b[1]).map(([iri,index])=>({iri,label:classLabel(iri,String([...map.values()].find(node=>node.data.typeIri===iri)?.data.type??compact(iri))),color:nodeColor(index,theme==='light'),count:[...map.values()].filter(node=>node.data.typeIri===iri).length}));setClassLegend(legend);setNodes(current=>{const currentPositions=new Map(current.map(node=>[node.id,node.position]));return[...map.values()].map(node=>({...node,position:currentPositions.get(node.id)??node.position,selected:current.find(item=>item.id===node.id)?.selected??false}))});setEdges(arrangeParallelEdges([...edgeMap.values()].filter(e=>map.has(e.target))));},[graph.data,theme]);

  const connect=(c:Connection)=>{if(!c.source||!c.target)return;const predicate=linkPredicate;const sourceHandle=c.sourceHandle||'bottom';const targetHandle=c.targetHandle||'top';const edgeColor=relationshipColor(predicate,theme==='light');setEdges(es=>arrangeParallelEdges(addEdge({...c,sourceHandle,targetHandle,id:`${c.source}|${predicate}|${c.target}`,label:displayName(predicate),type:'relationship',data:{predicate},reconnectable:true,markerEnd:{type:MarkerType.ArrowClosed,color:edgeColor},style:{stroke:edgeColor,strokeWidth:2}},es)));save.mutate(`INSERT DATA { <${c.source}> <${predicate}> <${c.target}> . ${connectionMetadata(c.source,predicate,c.target,sourceHandle,targetHandle)} }`)};
  const reconnect=(oldEdge:Edge,connection:Connection)=>{if(!connection.source||!connection.target)return;const predicate=String(oldEdge.data?.predicate??oldEdge.id.split('|')[1]);const sourceHandle=connection.sourceHandle||'bottom';const targetHandle=connection.targetHandle||'top';const nextId=`${connection.source}|${predicate}|${connection.target}`;setEdges(current=>arrangeParallelEdges(current.map(edge=>edge.id===oldEdge.id?{...edge,...connection,sourceHandle,targetHandle,id:nextId}:edge)));const oldMetadata=connectionIri(oldEdge.source,predicate,oldEdge.target);save.mutate(`DELETE WHERE { <${oldMetadata}> ?p ?o }; DELETE DATA { <${oldEdge.source}> <${predicate}> <${oldEdge.target}> }; INSERT DATA { <${connection.source}> <${predicate}> <${connection.target}> . ${connectionMetadata(connection.source,predicate,connection.target,sourceHandle,targetHandle)} }`,{onError:()=>qc.invalidateQueries({queryKey:['pipeline']})})};
  const createResource=()=>{if(!resourceLabel.trim()||!resourceType)return;const iri=`${RESOURCE_NS}${safeLocal(resourceLabel)}`;save.mutate(`PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> INSERT DATA { <${iri}> a <${resourceType}>; rdfs:label ${literal(resourceLabel.trim())} }`,{onSuccess:()=>{setModalOpen(false);setResourceLabel('')}})};
  const deleteEdges=(items:Edge[])=>{const operations=items.flatMap(e=>{const predicate=String(e.data?.predicate??e.id.split('|')[1]);return[`DELETE DATA { <${e.source}> <${predicate}> <${e.target}> }`,`DELETE WHERE { <${connectionIri(e.source,predicate,e.target)}> ?p ?o }`]});if(items.some(edge=>edge.id===selectedEdge?.id))setSelectedEdge(null);if(operations.length)save.mutate(operations.join('; '))};
  const deleteSelectedEdge=()=>{if(!selectedEdge)return;const from=String(nodes.find(node=>node.id===selectedEdge.source)?.data.label??compact(selectedEdge.source));const to=String(nodes.find(node=>node.id===selectedEdge.target)?.data.label??compact(selectedEdge.target));if(!window.confirm(`Delete relationship arrow from “${from}” to “${to}”?`))return;const edge=selectedEdge;setEdges(current=>current.filter(item=>item.id!==edge.id));deleteEdges([edge])};
  const deleteNodes=(items:Node[])=>{if(!items.length)return;const operations=items.flatMap(n=>[`DELETE WHERE { <${n.id}> ?p ?o }`,`DELETE WHERE { ?s ?p <${n.id}> }`]);save.mutate(operations.join('; '))};
  const deleteSelected=()=>{const selected=nodes.filter(n=>n.selected);if(!selected.length)return;if(!window.confirm(`Delete ${selected.length} selected resource${selected.length===1?'':'s'} and all RDF links to them?`))return;const ids=new Set(selected.map(n=>n.id));setNodes(current=>current.filter(n=>!ids.has(n.id)));setEdges(current=>current.filter(e=>!ids.has(e.source)&&!ids.has(e.target)));deleteNodes(selected)};
  const openBulkLink=()=>{const selected=nodes.filter(n=>n.selected);if(selected.length<2)return;setSourceIds(new Set([selected[0].id]));setTargetIds(new Set(selected.slice(1).map(n=>n.id)));setLinkModalOpen(true)};
  const toggleSet=(setter:React.Dispatch<React.SetStateAction<Set<string>>>,id:string)=>setter(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next});
  const createBulkLinks=()=>{const triples=[...sourceIds].flatMap(source=>[...targetIds].filter(target=>target!==source).map(target=>`<${source}> <${linkPredicate}> <${target}>`));if(!triples.length)return;save.mutate(`INSERT DATA { ${triples.join(' . ')} . }`,{onSuccess:()=>setLinkModalOpen(false)})};
  const saveNewRelation=()=>{const local=newRelationName.trim().replace(/[^A-Za-z0-9._~-]/g,'');const iri=`${NS}${local}`;if(!/^[A-Za-z_][A-Za-z0-9._~-]*$/.test(local)){window.alert('Relation name must start with a letter or underscore.');return}if(propertyRows.some(row=>row.property.value===iri)){setLinkPredicate(iri);if(selectedEdge)changeEdgeRelationship(selectedEdge,iri);setNewRelationOpen(false);return}createRelation.mutate(`PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> INSERT DATA { <${iri}> a owl:ObjectProperty ; rdfs:label ${literal(newRelationLabel.trim()||local)} }`,{onSuccess:()=>{setLinkPredicate(iri);if(selectedEdge)changeEdgeRelationship(selectedEdge,iri)}})};
  const relationLabel=(iri:string)=>displayName(iri,propertyRows.find(row=>row.property.value===iri)?.label?.value);
  const changeEdgeRelationship=(edge:Edge,newPredicate:string)=>{const oldPredicate=String(edge.data?.predicate??edge.id.split('|')[1]);if(newPredicate===oldPredicate)return;const sourceHandle=String(edge.sourceHandle||'bottom');const targetHandle=String(edge.targetHandle||'top');const edgeColor=relationshipColor(newPredicate,theme==='light');const nextId=`${edge.source}|${newPredicate}|${edge.target}`;const nextEdge={...edge,id:nextId,label:relationLabel(newPredicate),data:{...edge.data,predicate:newPredicate},markerEnd:{type:MarkerType.ArrowClosed,color:edgeColor},style:{...edge.style,stroke:edgeColor,strokeWidth:2}} as Edge;setEdges(current=>arrangeParallelEdges(current.map(item=>item.id===edge.id?nextEdge:item)));setSelectedEdge(nextEdge);setLinkPredicate(newPredicate);save.mutate(`DELETE WHERE { <${connectionIri(edge.source,oldPredicate,edge.target)}> ?p ?o }; DELETE DATA { <${edge.source}> <${oldPredicate}> <${edge.target}> }; INSERT DATA { <${edge.source}> <${newPredicate}> <${edge.target}> . ${connectionMetadata(edge.source,newPredicate,edge.target,sourceHandle,targetHandle)} }`,{onError:()=>qc.invalidateQueries({queryKey:['pipeline']})})};
  const changeResourceClass=(classIri:string)=>{if(!selectedResource||classIri===String(selectedResource.data.typeIri))return;const classRow=classRows.find(row=>row.class.value===classIri);save.mutate(`PREFIX owl: <http://www.w3.org/2002/07/owl#> DELETE { <${selectedResource.id}> a ?oldClass } WHERE { <${selectedResource.id}> a ?oldClass . ?oldClass a owl:Class }; INSERT DATA { <${selectedResource.id}> a <${classIri}> }`,{onSuccess:()=>{setAttributeDraft({});setSelectedResource(current=>current?{...current,data:{...current.data,typeIri:classIri,type:classLabel(classIri,classRow?.label?.value),classLabel:classLabel(classIri,classRow?.label?.value)}}:current)}})};
  const saveResourceDescription=()=>{if(!selectedResource)return;const value=resourceDescriptionDraft.trim();const operations=[`DELETE WHERE { <${selectedResource.id}> <http://www.w3.org/2000/01/rdf-schema#comment> ?oldComment }`,`DELETE WHERE { <${selectedResource.id}> <${DCTERMS}description> ?oldDescription }`];if(value)operations.push(`INSERT DATA { <${selectedResource.id}> <http://www.w3.org/2000/01/rdf-schema#comment> ${literal(value)} }`);save.mutate(operations.join('; '))};
  const saveAttributes=()=>{if(!selectedResource)return;const missing=attributes.find(attribute=>attribute.required&&!attributeDraft[attribute.iri]?.trim());if(missing){window.alert(`${missing.label} is required.`);return}const deletes=attributes.map(attribute=>`DELETE WHERE { <${selectedResource.id}> <${attribute.iri}> ?value }`);const triples=attributes.flatMap(attribute=>{const raw=attributeDraft[attribute.iri]??'';const values=attribute.multiple?raw.split('\n').map(value=>value.trim()).filter(Boolean):raw.trim()?[raw.trim()]:[];return values.map(value=>`<${selectedResource.id}> <${attribute.iri}> ${attribute.valueKind==='resource'?`<${value}>`:typedLiteral(value,actualDatatype(attribute.datatype))}`)});const insert=triples.length?`INSERT DATA { ${triples.join(' . ')} . }`:'';save.mutate([...deletes,insert].filter(Boolean).join('; '))};
  const deleteResourceProperty=(attribute:AttributeDef)=>{if(!selectedResource||!attribute.resourceSpecific)return;if(!window.confirm(`Delete resource-specific property “${attribute.label}”? Its values on this resource will also be removed.`))return;save.mutate(`PREFIX rps: <${NS}> DELETE WHERE { <${attribute.iri}> ?p ?o }; DELETE WHERE { <${selectedResource.id}> <${attribute.iri}> ?value }; DELETE WHERE { ?connection <http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate> <${attribute.iri}> ; ?cp ?co }`)};
  const createResourceProperty=()=>{if(!selectedResource)return;const local=propertyLocal(resourceProperty.name);if(!validLocal(local)){window.alert('Property name must start with a letter or underscore.');return}const propertyIri=`${selectedResource.id}#${local}`;const isTextarea=resourceProperty.typeIri===TEXTAREA_TYPE;const isResourceType=!resourceProperty.typeIri.startsWith(XSD)&&!isTextarea;const value=resourceProperty.value.trim();const valueTriple=value?`<${selectedResource.id}> <${propertyIri}> ${isResourceType?`<${value}>`:typedLiteral(value,actualDatatype(resourceProperty.typeIri))} .`:'';const kind=isResourceType?'owl:ObjectProperty':'owl:DatatypeProperty';const widgetTriple=isTextarea?`; rps:uiWidget "textarea"`:'';save.mutate(`PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX rps: <${NS}> INSERT DATA { <${propertyIri}> a ${kind} ; rps:resourceDomain <${selectedResource.id}> ; rdfs:label ${literal(resourceProperty.label.trim()||local)} ; rdfs:range <${actualDatatype(resourceProperty.typeIri)}> ${widgetTriple} . ${valueTriple} }`,{onSuccess:()=>{setResourceProperty({name:'',label:'',typeIri:`${XSD}string`,value:''});setPropertyFormOpen(false)}})};
  const persistPositions=(dragged:Node[])=>{if(!dragged.length)return;storeLayout(dragged);qc.setQueryData(['pipeline'],data=>patchPipelineCache(data,dragged));const resources=dragged.map(node=>`<${node.id}>`).join(' ');const triples=dragged.flatMap(node=>[`<${node.id}> rps:canvasX "${node.position.x.toFixed(2)}"^^xsd:decimal`,`<${node.id}> rps:canvasY "${node.position.y.toFixed(2)}"^^xsd:decimal`]);savePositions.mutate(`PREFIX rps: <${NS}> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> DELETE { ?resource rps:canvasX ?oldX . ?resource rps:canvasY ?oldY } WHERE { VALUES ?resource { ${resources} } OPTIONAL { ?resource rps:canvasX ?oldX } OPTIONAL { ?resource rps:canvasY ?oldY } }; INSERT DATA { ${triples.join(' . ')} . }`)};
  const restructurePipeline=()=>{if(!nodes.length)return;const arranged=treeLayout(nodes,edges);setNodes(arranged);persistPositions(arranged)};
  const openResourceEditor=(resource:MatrixResource)=>{setSelectedEdge(null);setSelectedResource({id:resource.id,type:'pipeline',position:{x:0,y:0},data:{label:resource.label,type:resource.classLabel,typeIri:resource.classIri}} as Node)};
  const selectedCount=nodes.filter(n=>n.selected).length;
  const selectedNodes=nodes.filter(n=>n.selected);

  return <Page className="pipeline-page" title="Pipeline editor" description="Create typed resources, connect them as RDF, and manage selections on the canvas." actions={<div className="pipeline-header-actions"><button className="secondary" disabled={viewMode==='matrix'} onClick={()=>setViewMode('matrix')}>View Matrix Hybrid Graph</button><button className="secondary" disabled={viewMode==='graph'} onClick={()=>setViewMode('graph')}>View Heirarchial Graph</button><button className="secondary" disabled={!nodes.length||savePositions.isPending||viewMode==='matrix'} onClick={restructurePipeline}>Resturcture</button><button onClick={()=>setModalOpen(true)}><Plus size={17}/>Add resource</button></div>}>
    <ErrorBox error={graph.error||matrixQuery.error||classes.error||properties.error||resourceDetails.error||resourceMeta.error||save.error||savePositions.error||createRelation.error}/>
    {viewMode==='matrix'?<MatrixHybridGraph resources={matrixItems} pipelineNodes={nodes} pipelineEdges={edges} selectedId={matrixSelectedId} setSelectedId={setMatrixSelectedId} onResourceClick={openResourceEditor} theme={theme}/>:<div className={`flow card pipeline-${tool}`}><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={(c:NodeChange[])=>setNodes(n=>applyNodeChanges(c,n))} onNodeClick={(_,node)=>{setSelectedEdge(null);setSelectedResource(node)}} onEdgeClick={(_,edge)=>{setSelectedResource(null);setSelectedEdge(edge);setLinkPredicate(String(edge.data?.predicate??edge.id.split('|')[1]))}} onNodeDragStop={(_,node,draggedNodes)=>persistPositions(draggedNodes.length?draggedNodes:[node])} onEdgesChange={(c:EdgeChange[])=>setEdges(e=>applyEdgeChanges(c,e))} onConnect={connect} onReconnect={reconnect} edgesReconnectable reconnectRadius={18} connectionMode={ConnectionMode.Loose} onEdgesDelete={deleteEdges} onNodesDelete={deleteNodes} onPaneClick={()=>{setSelectedEdge(null);if(tool==='select')setNodes(current=>current.map(n=>({...n,selected:false})))}} panOnDrag={tool==='pan'} selectionOnDrag={tool==='select'} selectionMode={SelectionMode.Partial} multiSelectionKeyCode={null} fitView deleteKeyCode="Delete">
      {classLegend.length>0&&<Panel position="top-left" className="pipeline-layer-panel"><button className="layer-toggle-button" title={legendExpanded?'Hide class colors':'Show class colors'} onClick={()=>setLegendExpanded(value=>!value)}><Layers3 size={19}/></button>{legendExpanded&&<div className="pipeline-class-legend"><div className="legend-header"><strong>Class colors</strong><span>{classLegend.length} classes</span></div><div className="legend-items">{classLegend.map(item=><div className="legend-item" key={item.iri} title={item.iri}><i style={{background:item.color}}/><span>{item.label}</span><em>{item.count}</em></div>)}</div></div>}</Panel>}
      <PipelineCanvasToolbar tool={tool} setTool={setTool} linkPredicate={linkPredicate} setLinkPredicate={setLinkPredicate} propertyRows={propertyRows as unknown as PropertyRow[]} selectedCount={selectedCount} savePending={save.isPending} openBulkLink={openBulkLink} deleteSelected={deleteSelected}/>
      <Background/><MiniMap/>
    </ReactFlow></div>}
    {modalOpen&&<div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setModalOpen(false)}}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="resource-modal-title"><div className="modal-header"><div><h2 id="resource-modal-title">Add pipeline resource</h2><p>Create an RDF resource using any OWL class in the ontology.</p></div><button className="icon-button" title="Close" onClick={()=>setModalOpen(false)}><X size={19}/></button></div><div className="modal-body"><label>Resource name<input autoFocus value={resourceLabel} onChange={e=>setResourceLabel(e.target.value)} onKeyDown={e=>e.key==='Enter'&&createResource()} placeholder="Monthly revenue model"/></label><label>Ontology class<select value={resourceType} onChange={e=>setResourceType(e.target.value)}>{classRows.map(row=><option key={row.class.value} value={row.class.value}>{row.label?.value??compact(row.class.value)} — {compact(row.class.value)}</option>)}</select></label>{resourceLabel&&<div className="iri-preview"><span>Resource IRI</span><code>{RESOURCE_NS}{safeLocal(resourceLabel)}</code></div>}</div><div className="modal-footer"><button className="secondary" onClick={()=>setModalOpen(false)}>Cancel</button><button disabled={!resourceLabel.trim()||!resourceType||save.isPending} onClick={createResource}>{save.isPending?'Creating…':'Create resource'}</button></div></div></div>}
    {selectedEdge&&<div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setSelectedEdge(null)}}><div className="modal edge-editor-modal" role="dialog" aria-modal="true" aria-labelledby="edge-editor-title"><div className="modal-header"><div><h2 id="edge-editor-title">Relationship manager</h2><p>Change the selected arrow’s RDF relationship.</p></div><button className="icon-button" title="Close" onClick={()=>setSelectedEdge(null)}><X size={19}/></button></div><div className="modal-body edge-editor-body"><div className="edge-summary"><div><span>From</span><strong>{String(nodes.find(node=>node.id===selectedEdge.source)?.data.label??compact(selectedEdge.source))}</strong></div><div><span>To</span><strong>{String(nodes.find(node=>node.id===selectedEdge.target)?.data.label??compact(selectedEdge.target))}</strong></div></div><label>Relationship<select value={String(selectedEdge.data?.predicate??selectedEdge.id.split('|')[1])} onChange={e=>changeEdgeRelationship(selectedEdge,e.target.value)}>{propertyRows.map(row=><option key={row.property.value} value={row.property.value}>{row.label?.value??compact(row.property.value)} — {compact(row.property.value)}</option>)}</select></label><button className="secondary" onClick={()=>setNewRelationOpen(value=>!value)}><Plus size={15}/>{newRelationOpen?'Cancel new relation':'Create custom relationship'}</button>{newRelationOpen&&<div className="new-relation-form inline-relation-form"><label>Relation name<input value={newRelationName} onChange={e=>setNewRelationName(e.target.value)} placeholder="dependsOn"/></label><label>Label<input value={newRelationLabel} onChange={e=>setNewRelationLabel(e.target.value)} placeholder="Depends on"/></label><button disabled={createRelation.isPending} onClick={saveNewRelation}>Save relation</button></div>}<p className="hint">Saving a custom relationship adds it to the relationship dropdowns. Select it here to update this arrow.</p></div><div className="modal-footer"><button className="secondary danger-button edge-delete-button" disabled={save.isPending} onClick={deleteSelectedEdge}><Trash2 size={15}/>Delete relationship</button><button className="secondary" onClick={()=>setSelectedEdge(null)}>Close</button></div></div></div>}
    {selectedResource&&<div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setSelectedResource(null)}}><div className="modal resource-editor-modal" role="dialog" aria-modal="true" aria-labelledby="edit-resource-title"><div className="modal-header"><div><h2 id="edit-resource-title">{String(selectedResource.data.label)}</h2><p>{String(selectedResource.data.type)} · Edit RDF properties</p></div><button className="icon-button" title="Close" onClick={()=>setSelectedResource(null)}><X size={19}/></button></div><div className="resource-editor-body">
      <div className="resource-class-selector"><label>Ontology class<select value={String(selectedResource.data.typeIri??'')} disabled={save.isPending} onChange={e=>changeResourceClass(e.target.value)}>{classRows.map(row=><option key={row.class.value} value={row.class.value}>{row.label?.value??compact(row.class.value)} — {compact(row.class.value)}</option>)}</select></label><p>Changing the class refreshes the available properties. Existing RDF values are retained.</p></div>
      <div className="resource-comment-grid"><section className="resource-description-editor"><div><span>Resource description</span><p>Saved on this resource as RDF comment metadata.</p></div><textarea value={resourceDescriptionDraft} onChange={e=>setResourceDescriptionDraft(e.target.value)} placeholder="Describe this pipeline resource…"/><button className="secondary" disabled={save.isPending||resourceDescriptionDraft.trim()===resourceComment} onClick={saveResourceDescription}><Save size={15}/>Save description</button></section>{classComment&&<section><span>Class description</span><p>{classComment}</p></section>}</div>
      {resourceDetails.isLoading?<div className="section-empty">Loading class definition…</div>:<>
        <section className="resource-section">
          <div className="resource-section-title"><div><h3>Properties</h3><p>Values are stored directly on this RDF resource. Class-valued properties use another resource as the value.</p></div><div className="resource-section-actions"><button className="secondary" onClick={()=>setPropertyFormOpen(value=>!value)}><Plus size={15}/>{propertyFormOpen?'Cancel':'Add resource property'}</button><button disabled={save.isPending} onClick={saveAttributes}><Save size={15}/>Save properties</button></div></div>
          {propertyFormOpen&&<div className="resource-specific-property"><label>Property name<input value={resourceProperty.name} onChange={e=>setResourceProperty(current=>({...current,name:propertyLocal(e.target.value)}))} placeholder="approvalStatus"/></label><label>Label<input value={resourceProperty.label} onChange={e=>setResourceProperty(current=>({...current,label:e.target.value}))} placeholder="Approval status"/></label><label>Type<select value={resourceProperty.typeIri} onChange={e=>setResourceProperty(current=>({...current,typeIri:e.target.value,value:''}))}>{propertyTypeOptions.map(option=><option key={option} value={option}>{typeLabel(option)}</option>)}</select></label>{resourceProperty.typeIri===TEXTAREA_TYPE?<label className="resource-specific-wide">Initial value<textarea value={resourceProperty.value} onChange={e=>setResourceProperty(current=>({...current,value:e.target.value}))} placeholder="Paste long text or code…"/></label>:resourceProperty.typeIri.startsWith(XSD)?<label>Initial value<input value={resourceProperty.value} onChange={e=>setResourceProperty(current=>({...current,value:e.target.value}))}/></label>:<label>Initial value<select value={resourceProperty.value} onChange={e=>setResourceProperty(current=>({...current,value:e.target.value}))}><option value="">Not set</option>{nodes.filter(node=>node.id!==selectedResource.id&&String(node.data.typeIri)===resourceProperty.typeIri).map(node=><option key={node.id} value={node.id}>{String(node.data.label)} — {String(node.data.type)}</option>)}</select></label>}<button disabled={save.isPending} onClick={createResourceProperty}>Create property</button></div>}
          <div className="resource-fields">{attributes.length===0?<div className="section-empty">This class has no properties.</div>:attributes.map(attribute=>{const resourceCandidates=nodes.filter(node=>node.id!==selectedResource.id&&(!attribute.range||String(node.data.typeIri)===attribute.range));return <label key={attribute.iri}>{attribute.label}{attribute.resourceSpecific?<button type="button" className="icon-button danger-button property-delete-button" title="Delete resource-specific property" disabled={save.isPending} onClick={event=>{event.preventDefault();deleteResourceProperty(attribute)}}><Trash2 size={13}/></button>:attribute.required&&<strong>Required</strong>}{attribute.valueKind==='resource'?<select value={attributeDraft[attribute.iri]??''} onChange={e=>setAttributeDraft(current=>({...current,[attribute.iri]:e.target.value}))}><option value="">Not set</option>{resourceCandidates.map(node=><option key={node.id} value={node.id}>{String(node.data.label)} — {String(node.data.type)}</option>)}</select>:attribute.multiple||attribute.widget==='textarea'?<textarea value={attributeDraft[attribute.iri]??''} onChange={e=>setAttributeDraft(current=>({...current,[attribute.iri]:e.target.value}))} placeholder={attribute.multiple?'One value per line':'Paste long text or code…'}/>:attribute.datatype.endsWith('#boolean')?<select value={attributeDraft[attribute.iri]??''} onChange={e=>setAttributeDraft(current=>({...current,[attribute.iri]:e.target.value}))}><option value="">Not set</option><option value="true">True</option><option value="false">False</option></select>:<input type={attribute.datatype.endsWith('#date')?'date':attribute.datatype.endsWith('#dateTime')?'datetime-local':attribute.datatype.endsWith('#integer')||attribute.datatype.endsWith('#decimal')?'number':'text'} value={attributeDraft[attribute.iri]??''} onChange={e=>setAttributeDraft(current=>({...current,[attribute.iri]:e.target.value}))}/>}<small>{attribute.resourceSpecific?'Resource-specific · ':''}{attribute.valueKind==='resource'?(attribute.range?`Resource: ${compact(attribute.range)}`:'Resource') : typeLabel(attribute.datatype)}{attribute.multiple?' · multiple values':''}</small></label>})}</div>
        </section>
      </>}
    </div><div className="modal-footer"><button className="secondary" onClick={()=>setSelectedResource(null)}>Close</button></div></div></div>}
    {linkModalOpen&&<div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setLinkModalOpen(false)}}><div className="modal bulk-link-modal" role="dialog" aria-modal="true" aria-labelledby="link-modal-title"><div className="modal-header"><div><h2 id="link-modal-title">Link selected resources</h2><p>Choose multiple sources and targets. Every source will be linked to every target.</p></div><button className="icon-button" title="Close" onClick={()=>setLinkModalOpen(false)}><X size={19}/></button></div><div className="modal-body"><label>Relationship<select value={linkPredicate} onChange={e=>setLinkPredicate(e.target.value)}>{propertyRows.map(row=><option key={row.property.value} value={row.property.value}>{row.label?.value??compact(row.property.value)} — {compact(row.property.value)}</option>)}</select></label><button className="secondary" onClick={()=>setNewRelationOpen(value=>!value)}><Plus size={15}/>{newRelationOpen?'Cancel new relation':'Create relation'}</button>{newRelationOpen&&<div className="new-relation-form inline-relation-form"><label>Relation name<input value={newRelationName} onChange={e=>setNewRelationName(e.target.value)} placeholder="dependsOn"/></label><label>Label<input value={newRelationLabel} onChange={e=>setNewRelationLabel(e.target.value)} placeholder="Depends on"/></label><button disabled={createRelation.isPending} onClick={saveNewRelation}>Save relation</button></div>}<div className="bulk-link-list"><div className="bulk-link-head"><span>Resource</span><span>Source</span><span>Target</span></div>{selectedNodes.map(node=><div className="bulk-link-row" key={node.id}><div><strong>{String(node.data.label)}</strong><small>{String(node.data.type)}</small></div><input aria-label={`${String(node.data.label)} as source`} type="checkbox" checked={sourceIds.has(node.id)} onChange={()=>toggleSet(setSourceIds,node.id)}/><input aria-label={`${String(node.data.label)} as target`} type="checkbox" checked={targetIds.has(node.id)} onChange={()=>toggleSet(setTargetIds,node.id)}/></div>)}</div><div className="link-summary">Creates {[...sourceIds].reduce((count,source)=>count+[...targetIds].filter(target=>target!==source).length,0)} RDF relationship(s). Self-links are skipped.</div></div><div className="modal-footer"><button className="secondary" onClick={()=>setLinkModalOpen(false)}>Cancel</button><button disabled={!sourceIds.size||!targetIds.size||save.isPending} onClick={createBulkLinks}>{save.isPending?'Linking…':'Create relationships'}</button></div></div></div>}
  </Page>
}
