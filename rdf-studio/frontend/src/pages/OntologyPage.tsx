import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Code2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { api, compact, type Binding, type BindingValue } from '../api';
import { ErrorBox, Page } from '../components/Page';
import { OWL, RDF, RDFS, RPS, TEXTAREA_TYPE, XSD, cleanLocal, datatypeOptions, esc, iriName, isDatatype, rdfRange, shortRange, splitIri, validIri, validLocal } from '../ontology';

const CLASS_QUERY=`PREFIX owl: <${OWL}> PREFIX rdfs: <${RDFS}>
SELECT ?class ?classLabel ?description ?parent ?property ?propertyLabel ?propertyDescription ?propertyWidget ?range ?required ?multiple WHERE {
  ?class a owl:Class . FILTER(isIRI(?class))
  OPTIONAL { ?class rdfs:label ?classLabel }
  OPTIONAL { ?class rdfs:comment ?description }
  OPTIONAL { ?class rdfs:subClassOf ?parent . FILTER(isIRI(?parent)) }
  OPTIONAL {
    ?property rdfs:domain ?class ; a ?kind .
    VALUES ?kind { owl:DatatypeProperty owl:ObjectProperty }
    FILTER NOT EXISTS { ?property <${RPS}globalRelationship> true }
    OPTIONAL { ?property rdfs:label ?propertyLabel }
    OPTIONAL { ?property rdfs:comment ?propertyDescription }
    OPTIONAL { ?property <${RPS}uiWidget> ?propertyWidget }
    OPTIONAL { ?property rdfs:range ?range }
    OPTIONAL { ?property <${RPS}required> ?required }
    OPTIONAL { ?property <${RPS}multiple> ?multiple }
  }
} ORDER BY ?class ?property`;
const ADVANCED_QUERY=(iri:string)=>`SELECT ?p ?o WHERE { <${iri}> ?p ?o FILTER(?p NOT IN (<${RDF}type>, <${RDFS}label>, <${RDFS}comment>, <${RDFS}subClassOf>)) } ORDER BY ?p`;
const DEPENDENCY_QUERY=(iri:string)=>`PREFIX owl: <${OWL}> PREFIX rdfs: <${RDFS}> SELECT ?property ?source WHERE { ?property a owl:ObjectProperty ; rdfs:range <${iri}> . OPTIONAL { ?property rdfs:domain ?source } }`;

type RdfStatement={id:string;predicateIri:string;objectType:'iri'|'literal';objectValue:string;datatype?:string;language?:string};
type OntologyProperty={id:string;localName:string;iri:string;label:string;description:string;rangeIri:string;required:boolean;multiple:boolean};
type OntologyClass={id:string;namespace:string;localName:string;iri:string;label:string;description:string;parentClassIri:string;properties:OntologyProperty[];advancedStatements:RdfStatement[]};

const uid=()=>`${Date.now()}-${Math.random()}`;
const rdfObject=(statement:RdfStatement)=>statement.objectType==='iri'?`<${statement.objectValue}>`:`${esc(statement.objectValue)}${statement.language?`@${statement.language}`:statement.datatype?`^^<${statement.datatype}>`:''}`;
const emptyProperty=():OntologyProperty=>({id:uid(),localName:'',iri:'',label:'',description:'',rangeIri:`${XSD}string`,required:false,multiple:false});
const emptyStatement=():RdfStatement=>({id:uid(),predicateIri:'',objectType:'literal',objectValue:''});
const emptyClass=():OntologyClass=>({id:uid(),namespace:RPS,localName:'',iri:'',label:'',description:'',parentClassIri:'',properties:[],advancedStatements:[]});
const value=(row:Binding,key:string)=>row[key]?.value??'';

function parseClasses(rows:Binding[]):OntologyClass[]{
  const classes=new Map<string,OntologyClass>();
  for(const row of rows){
    const iri=value(row,'class');if(!iri)continue;
    if(!classes.has(iri)){const parts=splitIri(iri);classes.set(iri,{...emptyClass(),id:iri,iri,...parts,label:value(row,'classLabel'),description:value(row,'description'),parentClassIri:value(row,'parent')})}
    const item=classes.get(iri)!;const property=value(row,'property');if(!property||item.properties.some(candidate=>candidate.iri===property))continue;
    const widget=value(row,'propertyWidget');
    item.properties.push({id:property,iri:property,localName:iriName(property),label:value(row,'propertyLabel'),description:value(row,'propertyDescription'),rangeIri:widget==='textarea'?TEXTAREA_TYPE:value(row,'range')||`${XSD}string`,required:value(row,'required')==='true',multiple:value(row,'multiple')==='true'});
  }
  return[...classes.values()].sort((a,b)=>(a.label||a.localName).localeCompare(b.label||b.localName));
}

function inheritedProperties(classes:OntologyClass[],parentIri:string,child?:OntologyClass){
  const byIri=new Map(classes.map(item=>[item.iri,item]));const lineage:OntologyClass[]=[];const seen=new Set<string>();let current=parentIri;
  while(current&&!seen.has(current)){seen.add(current);const parent=byIri.get(current);if(!parent)break;lineage.push(parent);current=parent.parentClassIri}
  const own=new Set((child?.properties??[]).map(item=>item.iri||`${child!.namespace}${item.localName}`));const inherited=new Set<string>();const properties:{property:OntologyProperty;owner:OntologyClass}[]=[];
  for(const owner of lineage)for(const property of owner.properties)if(!own.has(property.iri)&&!inherited.has(property.iri)){inherited.add(property.iri);properties.push({property,owner})}
  return{properties,lineage};
}

function turtle(model:OntologyClass){
  const classIri=model.iri||`${model.namespace}${model.localName}`;const lines=[`<${classIri}> a owl:Class`];
  if(model.label)lines.push(`  rdfs:label ${esc(model.label)}`);if(model.description)lines.push(`  rdfs:comment ${esc(model.description)}`);if(model.parentClassIri)lines.push(`  rdfs:subClassOf <${model.parentClassIri}>`);
  let result=`@prefix owl: <${OWL}> .\n@prefix rdfs: <${RDFS}> .\n@prefix xsd: <${XSD}> .\n\n${lines.join(' ;\n')} .`;
  for(const property of model.properties){if(!property.localName)continue;const propertyIri=property.iri||`${model.namespace}${property.localName}`;const kind=isDatatype(property.rangeIri)?'DatatypeProperty':'ObjectProperty';const bits=[`<${propertyIri}> a owl:${kind}`,`  rdfs:domain <${classIri}>`,`  rdfs:range <${rdfRange(property.rangeIri)}>`,`  <${RPS}required> ${property.required}`,`  <${RPS}multiple> ${property.multiple}`];if(property.rangeIri===TEXTAREA_TYPE)bits.push(`  <${RPS}uiWidget> "textarea"`);if(property.label)bits.push(`  rdfs:label ${esc(property.label)}`);if(property.description)bits.push(`  rdfs:comment ${esc(property.description)}`);result+=`\n\n${bits.join(' ;\n')} .`}
  for(const statement of model.advancedStatements)if(statement.predicateIri&&statement.objectValue)result+=`\n<${classIri}> <${statement.predicateIri}> ${rdfObject(statement)} .`;
  return result;
}

export function OntologyPage(){
  const qc=useQueryClient();const [editor,setEditor]=useState<OntologyClass|null>(null);const [editingIri,setEditingIri]=useState<string|null>(null);const [advanced,setAdvanced]=useState(false);const [preview,setPreview]=useState(false);const [search,setSearch]=useState('');const [selectedClassIris,setSelectedClassIris]=useState<Set<string>>(new Set());const [formError,setFormError]=useState('');
  const classQuery=useQuery({queryKey:['ontology'],queryFn:()=>api.query(CLASS_QUERY)});
  const classRows=classQuery.data?.type==='result'?classQuery.data.results?.bindings??[]:[];const classes=useMemo(()=>parseClasses(classRows),[classRows]);
  const inherited=editor?inheritedProperties(classes,editor.parentClassIri,editor):{properties:[],lineage:[]};
  const refresh=()=>{for(const key of [['ontology'],['ontology-classes'],['ontology-object-properties'],['graph'],['pipeline']])qc.invalidateQueries({queryKey:key})};
  const close=()=>{setEditor(null);setEditingIri(null);setAdvanced(false);setPreview(false);setFormError('')};
  const saveClass=useMutation({mutationFn:api.update,onSuccess:()=>{refresh();close()}});const remove=useMutation({mutationFn:api.update,onSuccess:()=>{refresh();close()}});
  const openCreate=()=>{close();setEditor(emptyClass())};
  const openEdit=async(item:OntologyClass)=>{setFormError('');try{const response=await api.query(ADVANCED_QUERY(item.iri));const bindings=response.type==='result'?response.results?.bindings??[]:[];const statements=bindings.map((binding,index)=>{const object=binding.o as BindingValue;return{id:`${index}-${uid()}`,predicateIri:binding.p.value,objectType:object.type==='uri'?'iri':'literal',objectValue:object.value,datatype:object.datatype,language:object['xml:lang']} as RdfStatement});setEditor({...item,properties:item.properties.map(property=>({...property})),advancedStatements:statements});setEditingIri(item.iri)}catch(error){setFormError(error instanceof Error?error.message:'Unable to load class')}};
  const patchEditor=(patch:Partial<OntologyClass>)=>setEditor(current=>current?{...current,...patch}:current);const patchProperty=(id:string,patch:Partial<OntologyProperty>)=>patchEditor({properties:editor!.properties.map(property=>property.id===id?{...property,...patch}:property)});const patchStatement=(id:string,patch:Partial<RdfStatement>)=>patchEditor({advancedStatements:editor!.advancedStatements.map(statement=>statement.id===id?{...statement,...patch}:statement)});
  const validate=()=>{if(!editor)return'';if(!validLocal(editor.localName))return'Class local name is required and must start with a letter or underscore.';if(!validIri(`${editor.namespace}${editor.localName}`))return'Namespace and local name must form a valid IRI.';if(editingIri&&inherited.lineage.some(item=>item.iri===editingIri))return'A class cannot inherit from itself or one of its descendants.';if(classes.some(item=>item.namespace===editor.namespace&&item.localName===editor.localName&&item.iri!==editingIri))return'A class with this local name already exists in the namespace.';if(editor.properties.some(property=>!validLocal(property.localName)||!property.rangeIri))return'Every property needs a valid local name and type.';if(editor.advancedStatements.some(statement=>!validIri(statement.predicateIri)||!statement.objectValue||(statement.objectType==='iri'&&!validIri(statement.objectValue))))return'Every advanced RDF statement needs a valid predicate and value.';return''};
  const submit=()=>{if(!editor)return;const error=validate();setFormError(error);if(error)return;const classIri=editingIri||`${editor.namespace}${editor.localName}`;const document=turtle({...editor,iri:classIri});const data=document.slice(document.indexOf('\n\n')+2);const clear=editingIri?`DELETE { <${classIri}> ?classP ?classO . ?property ?propertyP ?propertyO } WHERE { OPTIONAL { <${classIri}> ?classP ?classO . FILTER(?classP IN (rdfs:label, rdfs:comment, rdfs:subClassOf)) } OPTIONAL { ?property rdfs:domain <${classIri}> ; ?propertyP ?propertyO . FILTER NOT EXISTS { ?property <${RPS}globalRelationship> true } } }; `:'';saveClass.mutate(`PREFIX owl: <${OWL}> PREFIX rdfs: <${RDFS}> ${clear}INSERT DATA { ${data} }`)};
  const deleteClassesUpdate=(items:OntologyClass[])=>{const values=items.map(item=>`<${item.iri}>`).join(' ');return`PREFIX owl: <${OWL}> PREFIX rdfs: <${RDFS}> PREFIX rdf: <${RDF}>
DELETE { ?connection ?p ?o } WHERE { VALUES ?class { ${values} } ?instance a ?class . ?connection rdf:subject ?instance ; ?p ?o };
DELETE { ?connection ?p ?o } WHERE { VALUES ?class { ${values} } ?instance a ?class . ?connection rdf:object ?instance ; ?p ?o };
DELETE { ?incoming ?p ?instance } WHERE { VALUES ?class { ${values} } ?instance a ?class . ?incoming ?p ?instance };
DELETE { ?instance ?p ?o } WHERE { VALUES ?class { ${values} } ?instance a ?class . ?instance ?p ?o };
DELETE { ?connection ?p ?o } WHERE { VALUES ?class { ${values} } ?owned rdfs:domain ?class . ?connection rdf:predicate ?owned ; ?p ?o };
DELETE { ?owned ?p ?o } WHERE { VALUES ?class { ${values} } ?owned rdfs:domain ?class ; ?p ?o };
DELETE { ?connection ?p ?o } WHERE { VALUES ?class { ${values} } ?targeting a owl:ObjectProperty ; rdfs:range ?class . ?connection rdf:predicate ?targeting ; ?p ?o };
DELETE { ?targeting ?p ?o } WHERE { VALUES ?class { ${values} } ?targeting a owl:ObjectProperty ; rdfs:range ?class ; ?p ?o };
DELETE { ?classRef ?p ?class } WHERE { VALUES ?class { ${values} } ?classRef ?p ?class };
DELETE { ?class ?p ?o } WHERE { VALUES ?class { ${values} } ?class ?p ?o }`};
  const confirmDelete=async(item:OntologyClass)=>{try{const response=await api.query(DEPENDENCY_QUERY(item.iri));const dependencies=response.type==='result'?response.results?.bindings??[]:[];if(!window.confirm(`Permanently delete class “${item.label||item.localName}”?\n\nThis removes the class definition, owned properties, references, and resources typed as this class.${dependencies.length?`\n\n${dependencies.length} class-valued propert${dependencies.length===1?'y':'ies'} reference it and will also be removed.`:''}`))return;remove.mutate(deleteClassesUpdate([item]),{onSuccess:()=>setSelectedClassIris(current=>{const next=new Set(current);next.delete(item.iri);return next})})}catch(error){setFormError(error instanceof Error?error.message:'Unable to check class dependencies')}};
  const filtered=classes.filter(item=>`${item.localName} ${item.label} ${item.parentClassIri}`.toLowerCase().includes(search.toLowerCase()));const typeOptions=[...datatypeOptions,...classes.map(item=>item.iri)];
  const selectedClasses=classes.filter(item=>selectedClassIris.has(item.iri));const allFilteredSelected=filtered.length>0&&filtered.every(item=>selectedClassIris.has(item.iri));
  const toggleClassSelection=(iri:string)=>setSelectedClassIris(current=>{const next=new Set(current);if(next.has(iri))next.delete(iri);else next.add(iri);return next});
  const toggleFilteredSelection=()=>setSelectedClassIris(current=>{const next=new Set(current);if(allFilteredSelected)filtered.forEach(item=>next.delete(item.iri));else filtered.forEach(item=>next.add(item.iri));return next});
  const deleteSelectedClasses=()=>{if(!selectedClasses.length)return;const sample=selectedClasses.slice(0,5).map(item=>item.label||item.localName).join(', ');const suffix=selectedClasses.length>5?`, and ${selectedClasses.length-5} more`:'';if(!window.confirm(`Permanently delete ${selectedClasses.length} selected class${selectedClasses.length===1?'':'es'}?\n\n${sample}${suffix}\n\nThis removes class definitions, owned properties, class references, and all User Layer resources typed as these classes. This cannot be undone.`))return;remove.mutate(deleteClassesUpdate(selectedClasses),{onSuccess:()=>setSelectedClassIris(new Set())})};

  return <Page className="ontology-page" title="Ontology" description="Define classes and properties. Pipeline relationships are created when building the pipeline." actions={<button onClick={editor?close:openCreate}>{editor?<X size={17}/>:<Plus size={17}/>} {editor?'Cancel':'Create class'}</button>}>
    <ErrorBox error={classQuery.error||saveClass.error||remove.error}/>{formError&&<div className="error">{formError}</div>}
    {editor&&<section className="class-editor card"><div className="class-editor-title"><div><span>Class editor</span><h2>{editingIri?editor.label||editor.localName:'New class'}</h2></div>{editingIri&&<code>{editingIri}</code>}</div><div className="class-fields">
      <label>Local name<input disabled={!!editingIri} value={editor.localName} onChange={event=>patchEditor({localName:cleanLocal(event.target.value)})} placeholder="Customer"/></label><label>Label<input value={editor.label} onChange={event=>patchEditor({label:event.target.value})} placeholder="Customer"/></label><label className="field-wide">Description<textarea value={editor.description} onChange={event=>patchEditor({description:event.target.value})} placeholder="What this class represents…"/></label><label>Namespace<input disabled={!!editingIri} value={editor.namespace} onChange={event=>patchEditor({namespace:event.target.value})}/></label><label>Parent class<select value={editor.parentClassIri} onChange={event=>patchEditor({parentClassIri:event.target.value})}><option value="">No parent class</option>{classes.filter(item=>item.iri!==editingIri).map(item=><option key={item.iri} value={item.iri}>{item.label||item.localName}</option>)}</select></label>
    </div><EditorSection title="Properties" subtitle="Fields whose type can be a datatype or another ontology class." onAdd={()=>patchEditor({properties:[...editor.properties,emptyProperty()]})} addLabel="Add property">
      {inherited.properties.length>0&&<div className="inherited-block"><div className="inherited-title">Inherited properties</div>{inherited.properties.map(({property,owner})=><div className="inherited-item" key={property.iri}><div><strong>{property.label||property.localName}</strong><small>{shortRange(property.rangeIri)}{property.required?' · required':''}{property.multiple?' · multiple':''}</small></div><span>From {owner.label||owner.localName}</span></div>)}</div>}
      {editor.properties.length===0&&inherited.properties.length===0?<div className="section-empty">No properties defined or inherited.</div>:editor.properties.map(property=><div className="ontology-row property-row" key={property.id}><label>Name<input value={property.localName} onChange={event=>patchProperty(property.id,{localName:cleanLocal(event.target.value),iri:''})} placeholder="owner"/></label><label>Label<input value={property.label} onChange={event=>patchProperty(property.id,{label:event.target.value})} placeholder="Owner"/></label><label>Type<select value={property.rangeIri} onChange={event=>patchProperty(property.id,{rangeIri:event.target.value})}>{typeOptions.map(option=><option key={option} value={option}>{shortRange(option)}</option>)}</select></label><label>Description<input value={property.description} onChange={event=>patchProperty(property.id,{description:event.target.value})}/></label><label className="ontology-check"><input type="checkbox" checked={property.required} onChange={event=>patchProperty(property.id,{required:event.target.checked})}/>Required</label><label className="ontology-check"><input type="checkbox" checked={property.multiple} onChange={event=>patchProperty(property.id,{multiple:event.target.checked})}/>Multiple values</label><button className="icon-button danger-button" title="Remove property" onClick={()=>patchEditor({properties:editor.properties.filter(item=>item.id!==property.id)})}><Trash2 size={16}/></button></div>)}
    </EditorSection><button className="advanced-toggle" onClick={()=>setAdvanced(value=>!value)}>{advanced?<ChevronDown size={16}/>:<ChevronRight size={16}/>}<Code2 size={15}/>Advanced RDF</button>{advanced&&<EditorSection title="Advanced RDF statements" subtitle="Optional low-level statements on this class." onAdd={()=>patchEditor({advancedStatements:[...editor.advancedStatements,emptyStatement()]})} addLabel="Add statement">{editor.advancedStatements.length===0?<div className="section-empty">No advanced statements.</div>:editor.advancedStatements.map(statement=><div className="ontology-row advanced-row" key={statement.id}><label>Predicate IRI<input value={statement.predicateIri} onChange={event=>patchStatement(statement.id,{predicateIri:event.target.value})}/></label><label>Object type<select value={statement.objectType} onChange={event=>patchStatement(statement.id,{objectType:event.target.value as 'iri'|'literal'})}><option value="literal">Literal</option><option value="iri">IRI</option></select></label><label>Value<input value={statement.objectValue} onChange={event=>patchStatement(statement.id,{objectValue:event.target.value})}/></label><button className="icon-button danger-button" onClick={()=>patchEditor({advancedStatements:editor.advancedStatements.filter(item=>item.id!==statement.id)})}><Trash2 size={16}/></button></div>)}</EditorSection>}<button className="preview-toggle" onClick={()=>setPreview(value=>!value)}>{preview?<ChevronDown size={16}/>:<ChevronRight size={16}/>}Generated Turtle preview</button>{preview&&<pre className="turtle-preview">{turtle(editor)}</pre>}<div className="ontology-footer"><span>Class-valued properties are generated as OWL object properties.</span><button disabled={saveClass.isPending} onClick={submit}>{saveClass.isPending?'Saving…':editingIri?'Save class':'Create class'}</button></div></section>}

    <section className="class-list card"><div className="class-list-header"><div><h2>Ontology classes</h2><span>{classes.length} classes</span></div><div className="class-list-actions"><label className="class-search"><Search size={15}/><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search classes…"/></label><button className="secondary danger-button" disabled={!selectedClasses.length||remove.isPending} onClick={deleteSelectedClasses}><Trash2 size={15}/>Delete selected{selectedClasses.length?` (${selectedClasses.length})`:''}</button></div></div><div className="table-wrap"><table><thead><tr><th className="class-select-cell"><input type="checkbox" aria-label="Select all visible classes" checked={allFilteredSelected} disabled={!filtered.length||remove.isPending} onChange={toggleFilteredSelection}/></th><th>Class</th><th>Parent</th><th>Properties</th><th>Label</th><th>Actions</th></tr></thead><tbody>{filtered.map(item=>{const inheritedForClass=inheritedProperties(classes,item.parentClassIri,item);return <tr key={item.iri}><td className="class-select-cell"><input type="checkbox" aria-label={`Select ${item.label||item.localName}`} checked={selectedClassIris.has(item.iri)} disabled={remove.isPending} onChange={()=>toggleClassSelection(item.iri)}/></td><td><strong>{item.localName}</strong><small>{compact(item.iri)}</small></td><td>{item.parentClassIri?compact(item.parentClassIri):'—'}</td><td><span className="count-pill" title={`${item.properties.length} defined, ${inheritedForClass.properties.length} inherited`}>{item.properties.length+inheritedForClass.properties.length}</span></td><td>{item.label||'—'}</td><td className="row-action"><button className="icon-button" title="Edit class" onClick={()=>openEdit(item)}><Pencil size={15}/></button><button className="icon-button danger-button" title="Delete class" disabled={remove.isPending} onClick={()=>confirmDelete(item)}><Trash2 size={15}/></button></td></tr>})}</tbody></table></div></section>
  </Page>;
}

function EditorSection({title,subtitle,onAdd,addLabel,children}:{title:string;subtitle:string;onAdd:()=>void;addLabel:string;children:React.ReactNode}){return <section className="ontology-section"><div className="ontology-section-header"><div><h3>{title}</h3><p>{subtitle}</p></div><button className="secondary" onClick={onAdd}><Plus size={15}/>{addLabel}</button></div><div className="ontology-section-body">{children}</div></section>}
