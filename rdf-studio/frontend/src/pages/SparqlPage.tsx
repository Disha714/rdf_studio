import { useState } from 'react';
import Editor from '@monaco-editor/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type Binding, type SparqlResponse } from '../api';
import { ErrorBox, Page } from '../components/Page';
import { useTheme } from '../theme';
const initial=`PREFIX rps: <https://w3id.org/rdf-pipeline-studio#>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n\nSELECT ?resource ?type ?label WHERE {\n  ?resource a ?type .\n  FILTER(STRSTARTS(STR(?type), STR(rps:)))\n  OPTIONAL { ?resource rdfs:label ?label }\n}\nORDER BY ?type ?label`;
const descriptorQuery=`PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?table ?tableLabel ?column ?columnLabel ?kind ?range ?rangeLabel
       (COUNT(DISTINCT ?resource) AS ?rowCount)
       (COUNT(DISTINCT ?value) AS ?valueCount)
WHERE {
  ?table a owl:Class .
  OPTIONAL { ?table rdfs:label ?tableLabel }
  OPTIONAL { ?resource a ?table . FILTER(?resource != ?table) }
  OPTIONAL {
    {
      ?column a owl:DatatypeProperty ;
              rdfs:domain ?domain .
      ?table rdfs:subClassOf* ?domain .
      BIND("Property" AS ?kind)
    }
    UNION
    {
      ?column a owl:ObjectProperty ;
              rdfs:domain ?domain .
      ?table rdfs:subClassOf* ?domain .
      BIND("Relationship" AS ?kind)
    }
    OPTIONAL { ?column rdfs:label ?columnLabel }
    OPTIONAL {
      ?column rdfs:range ?range .
      OPTIONAL { ?range rdfs:label ?rangeLabel }
    }
    OPTIONAL { ?resource ?column ?value }
  }
}
GROUP BY ?table ?tableLabel ?column ?columnLabel ?kind ?range ?rangeLabel
ORDER BY LCASE(STR(COALESCE(?tableLabel, ?table))) LCASE(STR(COALESCE(?columnLabel, ?column)))`;

type ColumnInfo={iri:string;label:string;kind:string;range:string;valueCount:string};
type TableInfo={iri:string;label:string;rowCount:string;columns:ColumnInfo[]};

function display(value?:string){return value?.split(/[\/#]/).pop()||value||''}
function iriTitle(iri:string,label?:string){return label||display(iri)}
function buildDescriptor(rows:Binding[]):TableInfo[]{
  const tables=new Map<string,TableInfo>();
  for(const row of rows){
    const tableIri=row.table?.value;if(!tableIri)continue;
    const table=tables.get(tableIri)??{iri:tableIri,label:iriTitle(tableIri,row.tableLabel?.value),rowCount:row.rowCount?.value??'0',columns:[]};
    table.rowCount=row.rowCount?.value??table.rowCount;
    const columnIri=row.column?.value;
    if(columnIri&&!table.columns.some(column=>column.iri===columnIri)){
      table.columns.push({iri:columnIri,label:iriTitle(columnIri,row.columnLabel?.value),kind:row.kind?.value??'Property',range:row.rangeLabel?.value??(row.range?.value?display(row.range.value):'any'),valueCount:row.valueCount?.value??'0'});
    }
    tables.set(tableIri,table);
  }
  return [...tables.values()];
}

function QueryResult({result,vars,rows,isSuccess}:{result:SparqlResponse|undefined;vars:string[];rows:Binding[];isSuccess:boolean}){
  if(result?.type==='graph')return <pre className="result sparql-result">{result.turtle}</pre>;
  if(result?.type==='result'&&result.boolean!==undefined)return <div className="card status">ASK result: <strong>{String(result.boolean)}</strong></div>;
  if(rows.length>0)return <div className="card table-wrap sparql-result-table"><table><thead><tr>{vars.map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{vars.map(v=><td key={v}>{r[v]?.value??''}</td>)}</tr>)}</tbody></table></div>;
  return isSuccess?<div className="empty sparql-empty">No results</div>:<div className="empty sparql-empty">Run a query to see results</div>;
}

export function SparqlPage(){
  const {theme}=useTheme();const [text,setText]=useState(initial);
  const descriptor=useQuery({queryKey:['sparql-descriptor'],queryFn:()=>api.query(descriptorQuery)});
  const run=useMutation({mutationFn:()=>api.query(text)});
  const result=run.data;const vars=result?.type==='result'?result.head.vars:[];const rows:Binding[]=result?.type==='result'?result.results?.bindings??[]:[];
  const descriptorRows:Binding[]=descriptor.data?.type==='result'?descriptor.data.results?.bindings??[]:[];
  const tables=buildDescriptor(descriptorRows);
  return <Page className="sparql-page" title="SPARQL console" description="Run SELECT, ASK, CONSTRUCT, or DESCRIBE against the live dataset." actions={<button onClick={()=>run.mutate()} disabled={run.isPending}>{run.isPending?'Running…':'Run query'}</button>}>
    <ErrorBox error={run.error||descriptor.error}/>
    <div className="sparql-workbench">
      <section className="sparql-console">
        <div className="section-heading"><div><h2>Console</h2><p>Write and execute SPARQL against the RDF dataset.</p></div></div>
        <div className="editor card"><Editor height="42vh" defaultLanguage="sparql" theme={theme==='dark'?'vs-dark':'light'} value={text} onChange={v=>setText(v??'')} options={{minimap:{enabled:false},fontSize:14,automaticLayout:true}}/></div>
        <QueryResult result={result} vars={vars} rows={rows} isSuccess={run.isSuccess}/>
      </section>
      <section className="sparql-descriptor card">
        <div className="descriptor-header"><div><h2>Tables descriptor</h2><p>Ontology classes shown as tables. Columns are inherited RDF properties.</p></div><button className="secondary" onClick={()=>descriptor.refetch()} disabled={descriptor.isFetching}>{descriptor.isFetching?'Refreshing…':'Refresh'}</button></div>
        {descriptor.isLoading?<div className="descriptor-empty">Loading tables…</div>:tables.length===0?<div className="descriptor-empty">No OWL classes found.</div>:<div className="descriptor-list">{tables.map(table=><details key={table.iri} open className="descriptor-table"><summary><span><strong>{table.label}</strong><small>{table.iri}</small></span><em>{table.rowCount} rows · {table.columns.length} columns</em></summary>{table.columns.length===0?<div className="descriptor-empty small">No defined columns.</div>:<table><thead><tr><th>Column</th><th>Type</th><th>Range</th><th>Values</th></tr></thead><tbody>{table.columns.map(column=><tr key={column.iri}><td><strong>{column.label}</strong><small>{column.iri}</small></td><td>{column.kind}</td><td>{column.range}</td><td>{column.valueCount}</td></tr>)}</tbody></table>}</details>)}</div>}
      </section>
    </div>
  </Page>
}
