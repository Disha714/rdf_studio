import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import { Maximize2 } from 'lucide-react';
import { api, displayName, type Binding } from '../api';
import { ErrorBox, Page } from '../components/Page';
import { useTheme } from '../theme';

const OWL='http://www.w3.org/2002/07/owl#';
const RDFS='http://www.w3.org/2000/01/rdf-schema#';
const CLASS_QUERY=`PREFIX owl: <${OWL}> PREFIX rdfs: <${RDFS}>
SELECT ?class ?label ?parent ?relationship ?relationshipLabel ?target WHERE {
  ?class a owl:Class .
  FILTER(isIRI(?class))
  OPTIONAL { ?class rdfs:label ?label }
  OPTIONAL { ?class rdfs:subClassOf ?parent . ?parent a owl:Class . FILTER(isIRI(?parent)) }
  OPTIONAL {
    ?relationship a owl:ObjectProperty ; rdfs:domain ?class ; rdfs:range ?target .
    ?target a owl:Class .
    FILTER(isIRI(?target))
    OPTIONAL { ?relationship rdfs:label ?relationshipLabel }
  }
} ORDER BY ?label ?class`;

function elements(rows:Binding[]):ElementDefinition[]{
  const nodes=new Map<string,ElementDefinition>();const edges=new Map<string,ElementDefinition>();
  const putNode=(iri:string,label?:string)=>{if(iri&&!nodes.has(iri))nodes.set(iri,{data:{id:iri,label:displayName(iri,label)}})};
  for(const row of rows){
    const classIri=row.class.value;putNode(classIri,row.label?.value);
    const parent=row.parent?.value;if(parent){putNode(parent);const id=`subclass:${classIri}:${parent}`;edges.set(id,{data:{id,source:classIri,target:parent,label:'is a'}})}
    const target=row.target?.value;const relationship=row.relationship?.value;if(target&&relationship){putNode(target);const id=`relationship:${relationship}:${classIri}:${target}`;edges.set(id,{data:{id,source:classIri,target,label:displayName(relationship,row.relationshipLabel?.value),kind:'relationship'}})}
  }
  return [...nodes.values(),...edges.values()];
}

export function GraphPage(){
  const {theme}=useTheme();
  const ref=useRef<HTMLDivElement>(null);const cyRef=useRef<Core|null>(null);
  const query=useQuery({queryKey:['graph'],queryFn:()=>api.query(CLASS_QUERY)});
  const rows=query.data?.type==='result'?query.data.results?.bindings??[]:[];
  const classCount=new Set(rows.map(row=>row.class.value)).size;
  useEffect(()=>{
    if(!ref.current||query.data?.type!=='result')return;
    const light=theme==='light';
    const cy=cytoscape({container:ref.current,elements:elements(query.data.results?.bindings??[]),style:[
      {selector:'node',style:{'width':54,'height':54,'background-color':light?'#3d6ed8':'#2859c5','border-width':2,'border-color':light?'#19499f':'#8baeff','label':'data(label)','color':light?'#17233a':'#dce7ff','font-size':11,'font-weight':'bold','text-wrap':'wrap','text-max-width':'140px','text-valign':'bottom','text-margin-y':10}},
      {selector:'node:selected',style:{'background-color':'#4779e5','border-color':light?'#17233a':'#fff','border-width':3}},
      {selector:'edge',style:{'width':1.5,'line-color':light?'#8997ab':'#53647e','target-arrow-color':light?'#65758d':'#7185a5','target-arrow-shape':'triangle','curve-style':'bezier','label':'data(label)','font-size':9,'color':light?'#435269':'#9aabc5','text-background-color':light?'#f8fafc':'#101827','text-background-opacity':.95,'text-background-padding':'4px'}},
      {selector:'edge[kind = "relationship"]',style:{'line-color':'#2f8f86','target-arrow-color':'#4bc1b5','line-style':'solid'}},
      {selector:'edge:selected',style:{'line-color':'#8eb0ff','target-arrow-color':'#8eb0ff','width':3}}
    ],layout:{name:'breadthfirst',directed:true,padding:55,spacingFactor:1.65,avoidOverlap:true,grid:true,animate:false}});
    cyRef.current=cy;return()=>{cy.destroy();cyRef.current=null};
  },[query.data,theme]);
  return <Page className="graph-page" title="Knowledge graph" description="Classes defined in the ontology and the relationships between them." actions={<button className="secondary" onClick={()=>cyRef.current?.fit(undefined,45)}><Maximize2 size={16}/>Fit</button>}>
    <ErrorBox error={query.error}/>
    <div className="graph-key"><span><i className="class-node"/>Ontology class</span><span><i className="class-relationship"/>Class relationship</span><span>{classCount} classes · drag to inspect · scroll to zoom</span></div>
    <div ref={ref} className="graph card">{query.isLoading&&'Loading ontology classes…'}</div>
  </Page>
}
