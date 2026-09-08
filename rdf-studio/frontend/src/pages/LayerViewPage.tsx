import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Background, BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Panel, Position, ReactFlow, applyNodeChanges, useReactFlow, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Layers3, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { api, compact, type Binding } from '../api';
import { ErrorBox, Page } from '../components/Page';
import { useTheme } from '../theme';

const NS = 'https://w3id.org/rdf-pipeline-studio#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';

const ONTOLOGY_QUERY = `PREFIX owl: <${OWL}>
PREFIX rdfs: <${RDFS}>
PREFIX rps: <${NS}>
SELECT ?class ?label ?parent ?property ?propertyLabel ?target ?layerX ?layerY WHERE {
  ?class a owl:Class .
  FILTER(isIRI(?class))
  OPTIONAL { ?class rdfs:label ?label }
  OPTIONAL { ?class rps:layerX ?layerX }
  OPTIONAL { ?class rps:layerY ?layerY }
  OPTIONAL { ?class rdfs:subClassOf ?parent . ?parent a owl:Class . FILTER(isIRI(?parent)) }
  OPTIONAL {
    ?property a owl:ObjectProperty ; rdfs:domain ?class ; rdfs:range ?target .
    ?target a owl:Class .
    FILTER(isIRI(?target))
    FILTER NOT EXISTS { ?property rps:resourceDomain ?resource }
    OPTIONAL { ?property rdfs:label ?propertyLabel }
  }
} ORDER BY ?label ?class ?property`;

const PIPELINE_QUERY = `PREFIX owl: <${OWL}>
PREFIX rdfs: <${RDFS}>
PREFIX rdf: <${RDF}>
PREFIX rps: <${NS}>
SELECT ?resource ?resourceLabel ?class ?classLabel ?layerX ?layerY ?predicate ?predicateLabel ?target ?targetLabel ?targetClass ?targetClassLabel WHERE {
  ?class a owl:Class .
  ?resource a ?class .
  FILTER(isIRI(?resource))
  FILTER(?resource != ?class)
  OPTIONAL { ?resource rdfs:label ?resourceLabel }
  OPTIONAL { ?class rdfs:label ?classLabel }
  OPTIONAL { ?resource rps:layerX ?layerX }
  OPTIONAL { ?resource rps:layerY ?layerY }
  OPTIONAL {
    ?resource ?predicate ?target .
    FILTER(isIRI(?target))
    FILTER(?predicate NOT IN (rdf:type, rdfs:label, rps:canvasX, rps:canvasY, rps:sourceHandle, rps:targetHandle, rps:resourceDomain))
    FILTER EXISTS {
      ?target a ?knownTargetClass .
      ?knownTargetClass a owl:Class .
      FILTER(?target != ?knownTargetClass)
    }
    OPTIONAL { ?predicate rdfs:label ?predicateLabel }
    OPTIONAL { ?target rdfs:label ?targetLabel }
    OPTIONAL {
      ?target a ?targetClass .
      ?targetClass a owl:Class .
      FILTER(?target != ?targetClass)
      OPTIONAL { ?targetClass rdfs:label ?targetClassLabel }
    }
  }
} ORDER BY ?class ?resource ?predicate ?target`;

type Item = { iri: string; label: string; classIri?: string; classLabel?: string; layerPosition?: Point };
type Link = { id: string; source: string; target: string; label: string; kind?: 'subclass' | 'relationship' | 'instance' };
type Point = { x: number; y: number };

const nodeW = 176;
const nodeH = 66;
const canvasHeight = 860;
const userTop = 0;
const userBottom = 420;
const dividerY = 424;
const metaTop = 436;
const metaBottom = canvasHeight;
const metaBottomRow = metaBottom - nodeH - 44;
const metaRowGap = 105;

const displayName = (iri: string, label?: string) => {
  const text = label?.trim();
  return text && !/^https?:\/\//.test(text) ? text : compact(iri);
};
const value = (row: Binding, key: string) => row[key]?.value ?? '';
const numeric = (row: Binding, key: string) => {
  const raw = value(row, key);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const savedPoint = (row: Binding) => {
  const x = numeric(row, 'layerX');
  const y = numeric(row, 'layerY');
  return x === undefined || y === undefined ? undefined : { x, y };
};
const groupBy = <T,>(items: T[], key: (item: T) => string) => items.reduce((map, item) => {
  const group = key(item);
  map.set(group, [...(map.get(group) ?? []), item]);
  return map;
}, new Map<string, T[]>());

function parseOntology(rows: Binding[]) {
  const classes = new Map<string, Item>();
  const links = new Map<string, Link>();
  for (const row of rows) {
    const iri = value(row, 'class');
    if (!iri) continue;
    const existing = classes.get(iri);
    const layerPosition = savedPoint(row);
    classes.set(iri, { iri, label: existing?.label ?? displayName(iri, value(row, 'label')), layerPosition: existing?.layerPosition ?? layerPosition });
    const parent = value(row, 'parent');
    if (parent) {
      if (!classes.has(parent)) classes.set(parent, { iri: parent, label: displayName(parent) });
      links.set(`subclass:${iri}:${parent}`, { id: `subclass:${iri}:${parent}`, source: iri, target: parent, label: 'subclass of', kind: 'subclass' });
    }
    const property = value(row, 'property');
    const target = value(row, 'target');
    if (property && target) {
      if (!classes.has(target)) classes.set(target, { iri: target, label: displayName(target) });
      links.set(`class-link:${property}:${iri}:${target}`, { id: `class-link:${property}:${iri}:${target}`, source: iri, target, label: displayName(property, value(row, 'propertyLabel')), kind: 'relationship' });
    }
  }
  return { classes: [...classes.values()].sort((a, b) => a.label.localeCompare(b.label)), links: [...links.values()] };
}

function parsePipeline(rows: Binding[]) {
  const resources = new Map<string, Item>();
  const pipelineLinks = new Map<string, Link>();
  for (const row of rows) {
    const iri = value(row, 'resource');
    const classIri = value(row, 'class');
    if (!iri || !classIri) continue;
    const existing = resources.get(iri);
    const item = { iri, label: displayName(iri, value(row, 'resourceLabel')), classIri, classLabel: displayName(classIri, value(row, 'classLabel')), layerPosition: savedPoint(row) };
    resources.set(iri, existing ? { ...item, ...existing, classIri: existing.classIri || item.classIri, classLabel: existing.classLabel || item.classLabel, layerPosition: existing.layerPosition || item.layerPosition } : item);
    const target = value(row, 'target');
    const predicate = value(row, 'predicate');
    if (target && predicate) {
      const targetClass = value(row, 'targetClass');
      const targetItem = { iri: target, label: displayName(target, value(row, 'targetLabel')), classIri: targetClass, classLabel: targetClass ? displayName(targetClass, value(row, 'targetClassLabel')) : undefined };
      const targetExisting = resources.get(target);
      resources.set(target, targetExisting ? { ...targetItem, ...targetExisting, classIri: targetExisting.classIri || targetItem.classIri, classLabel: targetExisting.classLabel || targetItem.classLabel } : targetItem);
      pipelineLinks.set(`resource-link:${predicate}:${iri}:${target}`, { id: `resource-link:${predicate}:${iri}:${target}`, source: iri, target, label: displayName(predicate, value(row, 'predicateLabel')), kind: 'relationship' });
    }
  }
  return { resources: [...resources.values()].sort((a, b) => a.label.localeCompare(b.label)), pipelineLinks: [...pipelineLinks.values()] };
}

function hierarchyDepths(classes: Item[], links: Link[]) {
  const parentByChild = new Map(links.filter(link => link.kind === 'subclass').map(link => [link.source, link.target]));
  const depths = new Map<string, number>();
  const depthOf = (iri: string, seen = new Set<string>()): number => {
    if (depths.has(iri)) return depths.get(iri)!;
    const parent = parentByChild.get(iri);
    if (!parent || seen.has(parent)) {
      depths.set(iri, 0);
      return 0;
    }
    seen.add(iri);
    const depth = depthOf(parent, seen) + 1;
    depths.set(iri, depth);
    return depth;
  };
  classes.forEach(item => depthOf(item.iri));
  return depths;
}

function positionsForClasses(classes: Item[], links: Link[], width: number) {
  const positions = new Map<string, Point>();
  const byIri = new Map(classes.map(item => [item.iri, item]));
  const subclassLinks = links.filter(link => link.kind === 'subclass');
  const parentByChild = new Map(subclassLinks.map(link => [link.source, link.target]));
  const childrenByParent = groupBy(subclassLinks, link => link.target);
  const rootOf = (iri: string) => {
    let current = iri;
    const seen = new Set<string>();
    while (parentByChild.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentByChild.get(current)!;
    }
    return current;
  };
  const roots = [...new Set(classes.map(item => rootOf(item.iri)))]
    .sort((a, b) => (byIri.get(a)?.label ?? compact(a)).localeCompare(byIri.get(b)?.label ?? compact(b)));
  const columnGap = Math.max(250, (width - 220) / Math.max(roots.length, 1));

  const place = (iri: string, columnX: number, depthFromRoot: number, siblingIndex = 0, siblingCount = 1, seen = new Set<string>()) => {
    if (seen.has(iri)) return;
    seen.add(iri);
    const horizontalOffset = depthFromRoot === 0 ? 0 : (siblingIndex - (siblingCount - 1) / 2) * Math.min(72, Math.max(28, 180 / Math.max(siblingCount, 1)));
    const y = Math.max(metaTop + 54, metaBottomRow - depthFromRoot * metaRowGap);
    const saved = byIri.get(iri)?.layerPosition;
    positions.set(iri, saved ?? { x: columnX + horizontalOffset, y });
    const children = (childrenByParent.get(iri) ?? [])
      .map(link => link.source)
      .filter(child => byIri.has(child))
      .sort((a, b) => byIri.get(a)!.label.localeCompare(byIri.get(b)!.label));
    children.forEach((child, index) => place(child, columnX, depthFromRoot + 1, index, children.length, new Set(seen)));
  };

  roots.forEach((root, index) => {
    const x = 110 + columnGap * index + Math.max(0, columnGap - nodeW) / 2;
    place(root, x, 0);
  });

  for (const [index, item] of classes.filter(item => !positions.has(item.iri)).entries()) {
    const x = 110 + columnGap * (roots.length + index) + Math.max(0, columnGap - nodeW) / 2;
    positions.set(item.iri, item.layerPosition ?? { x, y: metaBottomRow });
  }
  return positions;
}

function positionsForResources(resources: Item[], classPositions: Map<string, Point>, width: number) {
  const positions = new Map<string, Point>();
  const byClass = groupBy(resources, item => item.classIri && classPositions.has(item.classIri) ? item.classIri : '__untyped');
  for (const [classIri, items] of byClass) {
    const anchorX = classIri === '__untyped' ? width / 2 : classPositions.get(classIri)!.x + nodeW / 2;
    const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(items.length))));
    items.forEach((item, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const x = Math.min(Math.max(anchorX - (columns * 210) / 2 + col * 210 + 20, 80), width - 260);
      const y = userTop + 58 + row * 112;
      positions.set(item.iri, item.layerPosition ?? { x, y: Math.min(y, userBottom - nodeH - 18) });
    });
  }
  return positions;
}

function relationColor(kind: Link['kind'], theme: 'dark' | 'light') {
  if (kind === 'instance') return theme === 'light' ? '#b7791f' : '#f6b94a';
  if (kind === 'subclass') return theme === 'light' ? '#7c3aed' : '#a78bfa';
  return theme === 'light' ? '#1d4ed8' : '#7da2ff';
}

function LayerNode({ data }: NodeProps) {
  return <div className={`layer-flow-node ${String(data.variant)}`}>
    <Handle id="source-top" type="source" position={Position.Top} />
    <Handle id="target-top" type="target" position={Position.Top} />
    <Handle id="source-right" type="source" position={Position.Right} />
    <Handle id="target-right" type="target" position={Position.Right} />
    <Handle id="source-bottom" type="source" position={Position.Bottom} />
    <Handle id="target-bottom" type="target" position={Position.Bottom} />
    <Handle id="source-left" type="source" position={Position.Left} />
    <Handle id="target-left" type="target" position={Position.Left} />
    <strong>{String(data.label)}</strong>
    {data.subtitle ? <small>{String(data.subtitle)}</small> : null}
  </div>;
}

function LayerBand({ data }: NodeProps) {
  return <div className={`layer-band ${String(data.variant)}`}>
    <span>{String(data.label)}</span>
  </div>;
}

function LayerDivider() {
  return <div className="layer-flow-divider" />;
}

function LayerEdge({ sourceX, sourceY, targetX, targetY, label, data, selected, markerEnd }: EdgeProps) {
  const offset = Number(data?.offset ?? 0);
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.max(Math.hypot(dx, dy), 1);
  const controlX = (sourceX + targetX) / 2 - (dy / length) * offset;
  const controlY = (sourceY + targetY) / 2 + (dx / length) * offset;
  const path = `M ${sourceX},${sourceY} Q ${controlX},${controlY} ${targetX},${targetY}`;
  const labelX = sourceX * 0.25 + controlX * 0.5 + targetX * 0.25;
  const labelY = sourceY * 0.25 + controlY * 0.5 + targetY * 0.25;
  return <>
    <BaseEdge path={path} markerEnd={markerEnd} style={{ strokeWidth: selected ? 3 : 2.2, stroke: String(data?.color ?? '#7da2ff'), strokeDasharray: data?.dash ? String(data.dash) : undefined }} interactionWidth={18} />
    {label ? <EdgeLabelRenderer>
      <div className="layer-edge-label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}>
        {label}
      </div>
    </EdgeLabelRenderer> : null}
  </>;
}

const nodeTypes = { layerNode: LayerNode, layerBand: LayerBand, layerDivider: LayerDivider };
const edgeTypes = { layerEdge: LayerEdge };

function offsetEdges(edges: Edge[]) {
  const groups = new Map<string, Edge[]>();
  for (const edge of edges) {
    const key = [edge.source, edge.target].sort().join('|');
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }
  return edges.map(edge => {
    const siblings = groups.get([edge.source, edge.target].sort().join('|')) ?? [];
    const index = siblings.findIndex(item => item.id === edge.id);
    const offset = (index - (siblings.length - 1) / 2) * 48;
    return { ...edge, data: { ...edge.data, offset } };
  });
}

function treePositions(items: Item[], links: Link[], top: number, bottom: number, width: number) {
  const byId = new Map(items.map(item => [item.iri, item]));
  const children = new Map<string, string[]>();
  const indegree = new Map(items.map(item => [item.iri, 0]));
  for (const link of links) {
    if (!byId.has(link.source) || !byId.has(link.target) || link.source === link.target) continue;
    children.set(link.source, [...(children.get(link.source) ?? []), link.target]);
    indegree.set(link.target, (indegree.get(link.target) ?? 0) + 1);
  }
  for (const [id, childIds] of children) {
    children.set(id, [...new Set(childIds)].sort((a, b) => byId.get(a)!.label.localeCompare(byId.get(b)!.label)));
  }
  const roots = items.filter(item => (indegree.get(item.iri) ?? 0) === 0).sort((a, b) => a.label.localeCompare(b.label)).map(item => item.iri);
  const queue = roots.length ? [...roots] : items.sort((a, b) => a.label.localeCompare(b.label)).map(item => item.iri);
  const remaining = new Map(indegree);
  const depth = new Map<string, number>();
  const visited = new Set<string>();
  queue.forEach(id => depth.set(id, 0));
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (visited.has(id)) continue;
    visited.add(id);
    for (const child of children.get(id) ?? []) {
      depth.set(child, Math.max(depth.get(child) ?? 0, (depth.get(id) ?? 0) + 1));
      remaining.set(child, (remaining.get(child) ?? 0) - 1);
      if ((remaining.get(child) ?? 0) <= 0) queue.push(child);
    }
  }
  for (const item of items) {
    if (!depth.has(item.iri)) depth.set(item.iri, 0);
  }
  const levels = groupBy(items, item => String(depth.get(item.iri) ?? 0));
  const positions = new Map<string, Point>();
  const maxDepth = Math.max(...[...depth.values(), 0]);
  const verticalGap = Math.min(116, Math.max(88, (bottom - top - nodeH - 56) / Math.max(maxDepth, 1)));
  for (const [levelRaw, levelItems] of [...levels.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const level = Number(levelRaw);
    const ordered = levelItems.sort((a, b) => (a.classLabel ?? '').localeCompare(b.classLabel ?? '') || a.label.localeCompare(b.label));
    const horizontalGap = Math.max(210, Math.min(285, (width - 220) / Math.max(ordered.length, 1)));
    const startX = Math.max(80, (width - (ordered.length - 1) * horizontalGap - nodeW) / 2);
    const y = Math.min(bottom - nodeH - 28, top + 56 + level * verticalGap);
    ordered.forEach((item, index) => positions.set(item.iri, { x: startX + index * horizontalGap, y }));
  }
  return positions;
}

function LayerCanvasToolbar({ pending }: { pending: boolean }) {
  const flow = useReactFlow();
  return <Panel position="bottom-center" className="layer-bottom-toolbar">
    <span>{pending ? 'Saving layout…' : 'Drag nodes to save layout'}</span>
    <button title="Zoom out" onClick={() => flow.zoomOut()}><ZoomOut size={17} /></button>
    <button title="Zoom in" onClick={() => flow.zoomIn()}><ZoomIn size={17} /></button>
    <button title="Fit view" onClick={() => flow.fitView({ padding: 0.12 })}><Maximize2 size={17} /></button>
  </Panel>;
}

export function LayerViewPage() {
  const { theme } = useTheme();
  const queryClient = useQueryClient();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [legendExpanded, setLegendExpanded] = useState(false);
  const ontology = useQuery({ queryKey: ['layer-view', 'ontology'], queryFn: () => api.query(ONTOLOGY_QUERY) });
  const pipeline = useQuery({ queryKey: ['layer-view', 'pipeline'], queryFn: () => api.query(PIPELINE_QUERY) });
  const savePosition = useMutation({
    mutationFn: ({ iri, x, y }: { iri: string; x: number; y: number }) => api.update(`PREFIX rps: <${NS}> DELETE WHERE { <${iri}> rps:layerX ?oldX }; DELETE WHERE { <${iri}> rps:layerY ?oldY }; INSERT DATA { <${iri}> rps:layerX ${Math.round(x)} ; rps:layerY ${Math.round(y)} }`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['layer-view'] });
    },
  });
  const savePositions = useMutation({
    mutationFn: (items: { iri: string; x: number; y: number }[]) => {
      const values = items.map(item => `<${item.iri}>`).join(' ');
      const triples = items.flatMap(item => [`<${item.iri}> rps:layerX ${Math.round(item.x)}`, `<${item.iri}> rps:layerY ${Math.round(item.y)}`]);
      return api.update(`PREFIX rps: <${NS}> DELETE { ?item rps:layerX ?oldX . ?item rps:layerY ?oldY } WHERE { VALUES ?item { ${values} } OPTIONAL { ?item rps:layerX ?oldX } OPTIONAL { ?item rps:layerY ?oldY } }; INSERT DATA { ${triples.join(' . ')} . }`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['layer-view'] });
    },
  });
  const ontologyRows = ontology.data?.type === 'result' ? ontology.data.results?.bindings ?? [] : [];
  const pipelineRows = pipeline.data?.type === 'result' ? pipeline.data.results?.bindings ?? [] : [];
  const model = useMemo(() => {
    const ontologyModel = parseOntology(ontologyRows);
    const pipelineModel = parsePipeline(pipelineRows);
    const widestLevel = Math.max(ontologyModel.classes.length, pipelineModel.resources.length, 1);
    const width = Math.max(1320, widestLevel * 250 + 260);
    const classPositions = positionsForClasses(ontologyModel.classes, ontologyModel.links, width);
    const resourcePositions = positionsForResources(pipelineModel.resources, classPositions, width);
    const resourceClassLinks: Link[] = pipelineModel.resources
      .filter(resource => resource.classIri && classPositions.has(resource.classIri) && resourcePositions.has(resource.iri))
      .map(resource => ({ id: `type:${resource.iri}:${resource.classIri}`, source: resource.iri, target: resource.classIri!, label: 'is a', kind: 'instance' }));
    return { ...ontologyModel, ...pipelineModel, classPositions, resourcePositions, resourceClassLinks, width };
  }, [ontologyRows, pipelineRows]);

  const flow = useMemo(() => {
    const nodes: Node[] = [
      { id: '__user_layer', type: 'layerBand', position: { x: 0, y: userTop }, data: { label: 'User Layer', variant: 'user' }, draggable: false, selectable: false, style: { width: model.width, height: userBottom - userTop }, zIndex: -20 },
      { id: '__divider', type: 'layerDivider', position: { x: 0, y: dividerY }, data: {}, draggable: false, selectable: false, style: { width: model.width, height: 12 }, zIndex: -10 },
      { id: '__meta_layer', type: 'layerBand', position: { x: 0, y: metaTop }, data: { label: 'MetaModel Layer', variant: 'meta' }, draggable: false, selectable: false, style: { width: model.width, height: metaBottom - metaTop }, zIndex: -20 },
      ...model.resources.map(resource => ({ id: resource.iri, type: 'layerNode', position: model.resourcePositions.get(resource.iri)!, data: { label: resource.label, subtitle: resource.classLabel, variant: 'resource' }, style: { width: nodeW, height: nodeH }, zIndex: 10 }) satisfies Node),
      ...model.classes.map(item => ({ id: item.iri, type: 'layerNode', position: model.classPositions.get(item.iri)!, data: { label: item.label, subtitle: 'Ontology class', variant: 'class' }, style: { width: nodeW, height: nodeH }, zIndex: 10 }) satisfies Node),
    ];
    const edges: Edge[] = [...model.pipelineLinks, ...model.links, ...model.resourceClassLinks].map(link => {
      const color = relationColor(link.kind, theme);
      const vertical = link.kind === 'instance' || link.kind === 'subclass';
      return {
        id: link.id,
        source: link.source,
        target: link.target,
        sourceHandle: vertical ? 'source-bottom' : 'source-right',
        targetHandle: vertical ? 'target-top' : 'target-left',
        label: link.label,
        type: 'layerEdge',
        data: { color, dash: link.kind === 'instance' ? '6 7' : link.kind === 'subclass' ? '7 5' : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color },
        selectable: true,
      } satisfies Edge;
    });
    return { nodes, edges: offsetEdges(edges) };
  }, [model, theme]);

  const loading = ontology.isLoading || pipeline.isLoading;
  const flowKey = `${theme}:${[...model.resources, ...model.classes].map(item => `${item.iri}:${item.label}:${item.classIri ?? ''}:${item.layerPosition?.x ?? ''}:${item.layerPosition?.y ?? ''}`).join('|')}:${[...model.pipelineLinks, ...model.links, ...model.resourceClassLinks].map(link => link.id).join('|')}`;

  useEffect(() => {
    setNodes(flow.nodes);
    setEdges(flow.edges);
  }, [flowKey]);

  const restructureLayerView = () => {
    const resourcePositions = treePositions(model.resources, model.pipelineLinks, userTop, userBottom, model.width);
    const classPositions = treePositions(model.classes, model.links.filter(link => link.kind === 'subclass'), metaTop, metaBottom, model.width);
    const arranged = nodes.map(node => {
      if (node.id.startsWith('__')) return node;
      return { ...node, position: resourcePositions.get(node.id) ?? classPositions.get(node.id) ?? node.position };
    });
    const changed = arranged.filter(node => !node.id.startsWith('__')).map(node => ({ iri: node.id, x: node.position.x, y: node.position.y }));
    setNodes(arranged);
    if (changed.length) savePositions.mutate(changed);
  };

  return <Page className="layer-page" title="Layer View" description="View pipeline resources in the User Layer and ontology classes in the MetaModel Layer." actions={<button className="secondary" disabled={loading || (!model.resources.length && !model.classes.length) || savePositions.isPending} onClick={restructureLayerView}>Resturcture</button>}>
    <ErrorBox error={ontology.error || pipeline.error || savePosition.error || savePositions.error} />
    <section className="layer-view card">
      {loading ? <div className="empty">Loading layered RDF view…</div> : model.classes.length === 0 && model.resources.length === 0 ? <div className="empty">No ontology classes or pipeline resources found.</div> : <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={(changes: NodeChange[]) => setNodes(current => applyNodeChanges(changes, current))}
        nodesDraggable
        nodesConnectable={false}
        edgesFocusable
        onNodeDragStop={(_, node) => {
          if (node.id.startsWith('__')) return;
          savePosition.mutate({ iri: node.id, x: node.position.x, y: node.position.y });
        }}
        fitView
        minZoom={0.2}
        maxZoom={1.6}
      >
        <Panel position="top-left" className="pipeline-layer-panel layer-view-legend-panel"><button className="layer-toggle-button" title={legendExpanded ? 'Hide layer legend' : 'Show layer legend'} onClick={() => setLegendExpanded(value => !value)}><Layers3 size={19} /></button>{legendExpanded && <div className="pipeline-class-legend"><div className="legend-header"><strong>Layer legend</strong><span>{model.resources.length} resources · {model.classes.length} classes</span></div><div className="legend-items"><div className="legend-item"><i className="layer-resource-key" /><span>Pipeline resource</span><em>{model.resources.length}</em></div><div className="legend-item"><i className="layer-class-key" /><span>Ontology class</span><em>{model.classes.length}</em></div><div className="legend-item"><i className="layer-instance-key" /><span>Resource typed as class</span><em>is a</em></div></div></div>}</Panel>
        <LayerCanvasToolbar pending={savePosition.isPending || savePositions.isPending} />
        <Background />
      </ReactFlow>}
    </section>
  </Page>;
}
