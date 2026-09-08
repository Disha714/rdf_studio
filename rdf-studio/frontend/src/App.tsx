import { useState } from 'react';
import { Boxes, Braces, CheckCircle2, Download, FlaskConical, GitBranch, Layers3, Moon, Network, PanelLeftClose, PanelLeftOpen, Sparkles, Sun, Table2, Upload } from 'lucide-react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AiAssistantPage } from './pages/AiAssistantPage';
import { ExportPage } from './pages/ExportPage';
import { GraphPage } from './pages/GraphPage';
import { ImportPage } from './pages/ImportPage';
import { JsonLdToolsPage } from './pages/JsonLdToolsPage';
import { LayerViewPage } from './pages/LayerViewPage';
import { OntologyPage } from './pages/OntologyPage';
import { PipelinePage } from './pages/PipelinePage';
import { PlaygroundPage } from './pages/PlaygroundPage';
import { SparqlPage } from './pages/SparqlPage';
import { ValidatePage } from './pages/ValidatePage';
import { useTheme } from './theme';

const links = [['/ontology','Meta model ontology',Boxes],['/graph','Meta model graph',Network],['/pipeline','User layer',GitBranch],['/layer-view','Full layer view',Layers3],['/playground','Playground',FlaskConical],['/sparql','SPARQL',Braces],['/validate','Validate',CheckCircle2],['/ai-assistant','AI Assistant',Sparkles],['/import','Import',Upload],['/export','Export',Download],['/jsonld-tools','JSON-LD Tools',Table2]] as const;
export default function App() { const {theme,toggleTheme}=useTheme(); const location=useLocation(); const [sidebarCollapsed,setSidebarCollapsed]=useState(false); if(location.pathname.startsWith('/playground'))return <Routes><Route path="/playground" element={<PlaygroundPage/>}/><Route path="*" element={<Navigate to="/playground" replace/>}/></Routes>; return <div className={`shell${sidebarCollapsed?' sidebar-collapsed':''}`}><aside><div className="brand"><img className="brand-logo" src="/logo.png" alt="RDF Pipeline Studio"/></div><button className="sidebar-toggle" onClick={()=>setSidebarCollapsed(value=>!value)} aria-label={sidebarCollapsed?'Expand sidebar':'Collapse sidebar'} title={sidebarCollapsed?'Expand sidebar':'Collapse sidebar'}>{sidebarCollapsed?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>}<span>{sidebarCollapsed?'Expand':'Collapse'}</span></button><nav>{links.map(([to,label,Icon])=><NavLink key={to} to={to} target={to==='/playground'?'_blank':undefined} rel={to==='/playground'?'noreferrer':undefined} title={sidebarCollapsed?label:undefined}><Icon size={18}/><span>{label}</span></NavLink>)}</nav><footer><button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme==='dark'?'light':'dark'} theme`} title={`Switch to ${theme==='dark'?'light':'dark'} theme`}>{theme==='dark'?<Sun size={16}/>:<Moon size={16}/>}<span>{theme==='dark'?'Light':'Dark'} theme</span></button><span className="source-truth">RDF is the source of truth</span></footer></aside><main><Routes><Route path="/" element={<Navigate to="/pipeline" replace/>}/><Route path="/ontology" element={<OntologyPage/>}/><Route path="/graph" element={<GraphPage/>}/><Route path="/layer-view" element={<LayerViewPage/>}/><Route path="/pipeline" element={<PipelinePage/>}/><Route path="/sparql" element={<SparqlPage/>}/><Route path="/validate" element={<ValidatePage/>}/><Route path="/ai-assistant" element={<AiAssistantPage/>}/><Route path="/import" element={<ImportPage/>}/><Route path="/export" element={<ExportPage/>}/><Route path="/jsonld-tools" element={<JsonLdToolsPage/>}/></Routes></main></div> }
