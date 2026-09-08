import { api, compact, type Binding } from './api';
import type { MatrixResource } from './pages/PipelinePage';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';

const CLASS_LABELS: Record<string, string> = {
  'https://w3id.org/rdf-pipeline-studio#analyticalProcess': 'Analytical Process',
  'https://w3id.org/rdf-pipeline-studio#product': 'Product',
  'https://bmtc.datakaveri.org/freqrec#Metric': 'Metric',
};

export const GENERATED_PREFIX = 'https://bmtc.datakaveri.org/freqrec/ai/';

export type JsonLdNode = { '@id': string; '@type'?: string[]; [predicate: string]: unknown };

export const localName = (iri: string) => iri.split(/[/#]/).filter(Boolean).pop() ?? iri;
export const friendlyClassLabel = (iri: string) => CLASS_LABELS[iri] ?? compact(iri || 'Resource');

export function literalOrRefValue(entry: unknown): string | undefined {
  if (entry && typeof entry === 'object') {
    const obj = entry as { '@value'?: string; '@id'?: string };
    return obj['@value'] ?? obj['@id'];
  }
  return typeof entry === 'string' ? entry : undefined;
}

export function proposalToMatrixResources(nodes: JsonLdNode[]): MatrixResource[] {
  const resources = new Map<string, MatrixResource>();
  const ensure = (id: string, label: string, type: string, comment: string): MatrixResource => {
    const found = resources.get(id);
    if (found) return found;
    const created: MatrixResource = { id, label, classLabel: type ? friendlyClassLabel(type) : 'Resource', classIri: type, resourceComment: comment, classComment: '', facts: [] };
    resources.set(id, created);
    return created;
  };
  for (const node of nodes) {
    const id = node['@id'];
    if (!id) continue;
    const type = (node['@type'] ?? [])[0] ?? '';
    const label = literalOrRefValue((node[RDFS_LABEL] as unknown[] | undefined)?.[0]) ?? localName(id);
    const comment = literalOrRefValue((node[RDFS_COMMENT] as unknown[] | undefined)?.[0]) ?? '';
    ensure(id, label, type, comment);
  }
  for (const node of nodes) {
    const sourceId = node['@id'];
    const source = resources.get(sourceId);
    if (!source) continue;
    for (const [predicate, values] of Object.entries(node)) {
      if (predicate === '@id' || predicate === '@type' || predicate === RDFS_LABEL || predicate === RDFS_COMMENT) continue;
      if (!Array.isArray(values)) continue;
      for (const entry of values) {
        if (!entry || typeof entry !== 'object') continue;
        const object = entry as { '@id'?: string; '@value'?: string };
        const predicateLabel = localName(predicate);
        if (object['@id']) {
          const targetId = object['@id'];
          const target = ensure(targetId, localName(targetId), '', '');
          source.facts.push({ predicate, predicateLabel, value: targetId, valueLabel: target.label, valueType: 'uri', valueClassIri: target.classIri, valueClassLabel: target.classLabel, direction: 'out' });
          target.facts.push({ predicate, predicateLabel, value: sourceId, valueLabel: source.label, valueType: 'uri', valueClassIri: source.classIri, valueClassLabel: source.classLabel, direction: 'in' });
        } else if (object['@value'] !== undefined) {
          source.facts.push({ predicate, predicateLabel, value: String(object['@value']), valueLabel: String(object['@value']), valueType: 'literal', valueClassIri: '', valueClassLabel: '', direction: 'out' });
        }
      }
    }
  }
  return [...resources.values()];
}

export async function fetchExternalNodeInfo(ids: string[]): Promise<Binding[]> {
  if (!ids.length) return [];
  const values = ids.map(id => `<${id}>`).join(' ');
  const query = `PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?s ?label ?comment ?type WHERE {
  VALUES ?s { ${values} }
  OPTIONAL { ?s rdfs:label ?label }
  OPTIONAL { ?s rdfs:comment ?comment }
  OPTIONAL { ?s a ?type }
}`;
  const result = await api.query(query);
  return result.type === 'result' ? result.results?.bindings ?? [] : [];
}

export function mergeExternalNodeInfo(resources: MatrixResource[], rows: Binding[]): MatrixResource[] {
  const infoById = new Map<string, { label?: string; comment?: string; type?: string }>();
  for (const row of rows) {
    const id = row.s?.value;
    if (!id) continue;
    const info = infoById.get(id) ?? {};
    if (row.label?.value) info.label = row.label.value;
    if (row.comment?.value) info.comment = row.comment.value;
    if (row.type?.value && !info.type) info.type = row.type.value;
    infoById.set(id, info);
  }
  return resources.map(resource => {
    const info = infoById.get(resource.id);
    if (!info) return resource;
    return {
      ...resource,
      label: info.label ?? resource.label,
      resourceComment: info.comment ?? resource.resourceComment,
      classIri: info.type ?? resource.classIri,
      classLabel: info.type ? friendlyClassLabel(info.type) : resource.classLabel,
    };
  });
}
