/** Vocabulary and validation shared by everything that authors ontology terms: the
 *  hand-written class editor and the AI class-proposal review card. One definition of
 *  what a valid class or property looks like, so a generated term and a typed one are
 *  held to the same rules. */
import { compact } from './api';

export const RPS = 'https://w3id.org/rdf-pipeline-studio#';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL = 'http://www.w3.org/2002/07/owl#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** A UI widget hint, not a datatype: it narrows to xsd:string in the RDF. */
export const TEXTAREA_TYPE = `${RPS}TextArea`;

export const datatypeOptions = [`${XSD}string`, TEXTAREA_TYPE, `${XSD}integer`, `${XSD}decimal`, `${XSD}boolean`, `${XSD}date`, `${XSD}dateTime`, `${XSD}anyURI`];

export const splitIri = (iri: string) => { const index = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')); return { namespace: iri.slice(0, index + 1), localName: iri.slice(index + 1) }; };
export const iriName = (iri: string) => decodeURIComponent(splitIri(iri).localName);
export const cleanLocal = (value: string) => value.replace(/[^A-Za-z0-9._~-]/g, '');
export const validLocal = (value: string) => /^[A-Za-z_][A-Za-z0-9._~-]*$/.test(value);
export const validIri = (value: string) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/.test(value);
export const esc = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
export const isDatatype = (iri: string) => iri.startsWith(XSD) || iri === TEXTAREA_TYPE;
export const rdfRange = (iri: string) => iri === TEXTAREA_TYPE ? `${XSD}string` : iri;
export const shortRange = (iri: string) => iri === TEXTAREA_TYPE ? 'TextArea' : iri.startsWith(XSD) ? `xsd:${iri.slice(XSD.length)}` : compact(iri);
