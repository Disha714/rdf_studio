from contextlib import asynccontextmanager
from io import BytesIO
import ipaddress
import json
from pathlib import Path
import re
import socket
from urllib.parse import urlparse

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pyld import jsonld as pyld_jsonld
from pyshacl import validate
import requests
from rdflib import BNode, Graph, Literal, RDF, RDFS, URIRef
from rdflib.namespace import OWL, XSD
from requests import RequestException

from .ai_router import router as ai_router
from .codegraph_router import router as codegraph_router
from .config import CORS_ORIGINS
from .models import JsonLdFrameRequest, JsonLdTableRequest, SparqlRequest, UpdateRequest
from .store import construct, initialize_seed, query_json, update, upload

ALL_TRIPLES = "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }"
CLEAN_EXPORT_TRIPLES = """
PREFIX rps: <https://w3id.org/rdf-pipeline-studio#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
CONSTRUCT { ?s ?p ?o }
WHERE {
  {
    VALUES ?kind { owl:Ontology owl:Class owl:ObjectProperty owl:DatatypeProperty }
    ?s a ?kind ; ?p ?o .
  }
  UNION
  {
    ?class a owl:Class .
    ?s a ?class ; ?p ?o .
  }
  FILTER(?p NOT IN (rps:canvasX, rps:canvasY, rps:sourceHandle, rps:targetHandle))
  FILTER NOT EXISTS { ?s rps:sourceHandle ?handle }
}
"""
ONTOLOGY_TRIPLES = """
PREFIX rps: <https://w3id.org/rdf-pipeline-studio#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
CONSTRUCT { ?term ?p ?o }
WHERE {
  VALUES ?kind { owl:Ontology owl:Class owl:ObjectProperty owl:DatatypeProperty }
  ?term a ?kind ; ?p ?o .
  FILTER NOT EXISTS { ?term rps:resourceDomain ?resource }
}
"""
FORMATS = {
    "turtle": ("turtle", "text/turtle", "ttl"),
    "json-ld": ("json-ld", "application/ld+json", "jsonld"),
    "xml": ("xml", "application/rdf+xml", "rdf"),
    "nt": ("nt", "application/n-triples", "nt"),
    "nquads": ("nquads", "application/n-quads", "nq"),
    "n3": ("n3", "text/n3", "n3"),
}
RDF_EXTENSIONS = {"ttl": "turtle", "jsonld": "json-ld", "rdf": "xml", "xml": "xml", "nt": "nt", "nq": "nquads", "n3": "n3"}
RPS = "https://w3id.org/rdf-pipeline-studio#"
UI_ONLY_PREDICATES = {URIRef(f"{RPS}canvasX"), URIRef(f"{RPS}canvasY"), URIRef(f"{RPS}sourceHandle"), URIRef(f"{RPS}targetHandle")}
BUILTIN_TYPES = {OWL.Class, OWL.ObjectProperty, OWL.DatatypeProperty, OWL.Ontology, RDF.Property}
SKIP_INFERRED_PROPERTIES = {RDF.type, RDFS.label, RDFS.comment}
SH = "http://www.w3.org/ns/shacl#"
SH_NODE_SHAPE = URIRef(f"{SH}NodeShape")
SH_TARGET_CLASS = URIRef(f"{SH}targetClass")
SH_PROPERTY = URIRef(f"{SH}property")
SH_PATH = URIRef(f"{SH}path")
SH_MIN_COUNT = URIRef(f"{SH}minCount")
SH_MAX_COUNT = URIRef(f"{SH}maxCount")
SH_DATATYPE = URIRef(f"{SH}datatype")
SH_CLASS = URIRef(f"{SH}class")
SH_MESSAGE = URIRef(f"{SH}message")
SH_VALIDATION_RESULT = URIRef(f"{SH}ValidationResult")
SH_SOURCE_SHAPE = URIRef(f"{SH}sourceShape")
SH_FOCUS_NODE = URIRef(f"{SH}focusNode")
SH_RESULT_PATH = URIRef(f"{SH}resultPath")
SH_VALUE = URIRef(f"{SH}value")
SH_RESULT_MESSAGE = URIRef(f"{SH}resultMessage")
SH_SOURCE_CONSTRAINT_COMPONENT = URIRef(f"{SH}sourceConstraintComponent")
SH_RESULT_SEVERITY = URIRef(f"{SH}resultSeverity")


# --- Safe remote @context resolution ---
#
# Goal: accept remote @context URLs (so real-world JSON-LD from other systems
# just works), without letting an uploaded document make this server issue an
# unguarded outbound request. Rather than let rdflib fetch contexts itself
# (which it does with no safety controls at all), we resolve every remote
# @context ourselves through a guarded fetcher and rewrite the document to
# use the fetched content inline -- so by the time rdflib touches the
# document, no network access is required at all.

_REMOTE_CONTEXT_CACHE: dict[str, dict] = {}
_MAX_REMOTE_CONTEXT_BYTES = 1 * 1024 * 1024  # 1 MB
_REMOTE_CONTEXT_TIMEOUT = 5  # seconds
_MAX_REDIRECTS = 3


def _host_is_public(host: str) -> bool:
    """Resolve a hostname and reject it if any resolved address is internal.

    Blocks loopback, link-local (this is what catches the AWS/GCP cloud
    metadata address 169.254.169.254), private ranges, and other reserved
    address space -- the standard SSRF target list.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise HTTPException(400, f"Could not resolve @context host '{host}': {exc}") from exc
    for info in infos:
        addr = info[4][0]
        ip = ipaddress.ip_address(addr)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


def _validate_public_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(400, f"@context URL must be http(s): {url!r}")
    if parsed.username or parsed.password:
        raise HTTPException(400, f"@context URL must not embed credentials: {url!r}")
    if not parsed.hostname:
        raise HTTPException(400, f"@context URL has no host: {url!r}")
    if not _host_is_public(parsed.hostname):
        raise HTTPException(
            400,
            f"@context URL '{url}' resolves to a private/internal address and is blocked "
            "for security (SSRF protection).",
        )


def _fetch_remote_context(url: str) -> dict:
    """Fetch a remote JSON-LD context document under strict guardrails.

    Validates the URL (and every redirect hop) against internal/private
    address space, caps response size, enforces a timeout, and caches
    results so repeated imports of the same document are deterministic
    and don't re-hit the network.
    """
    if url in _REMOTE_CONTEXT_CACHE:
        return _REMOTE_CONTEXT_CACHE[url]

    current_url = url
    for _ in range(_MAX_REDIRECTS + 1):
        _validate_public_url(current_url)
        try:
            resp = requests.get(
                current_url,
                timeout=_REMOTE_CONTEXT_TIMEOUT,
                allow_redirects=False,
                stream=True,
                headers={"Accept": "application/ld+json, application/json"},
            )
        except requests.RequestException as exc:
            raise HTTPException(502, f"Could not fetch remote @context '{url}': {exc}") from exc

        if resp.is_redirect or resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get("Location")
            resp.close()
            if not location:
                raise HTTPException(502, f"Remote @context '{url}' redirected with no Location header")
            current_url = location
            continue

        if resp.status_code != 200:
            resp.close()
            raise HTTPException(502, f"Remote @context '{url}' returned HTTP {resp.status_code}")

        body = bytearray()
        for chunk in resp.iter_content(chunk_size=8192):
            body.extend(chunk)
            if len(body) > _MAX_REMOTE_CONTEXT_BYTES:
                resp.close()
                raise HTTPException(413, f"Remote @context '{url}' exceeds {_MAX_REMOTE_CONTEXT_BYTES} byte limit")
        resp.close()

        try:
            doc = json.loads(bytes(body))
        except json.JSONDecodeError as exc:
            raise HTTPException(502, f"Remote @context '{url}' is not valid JSON: {exc}") from exc

        # A dereferenced remote context document's meaningful content is its
        # own top-level @context member (per the JSON-LD spec); fall back to
        # the whole document if it has no such wrapper.
        context_value = doc.get("@context", doc) if isinstance(doc, dict) else doc
        _REMOTE_CONTEXT_CACHE[url] = context_value
        return context_value

    raise HTTPException(502, f"Remote @context '{url}' exceeded {_MAX_REDIRECTS} redirects")


def _resolve_remote_contexts(node):
    """Recursively rewrite a JSON-LD document, replacing every remote
    @context reference (string, array entry, or @import) with the actual
    fetched context content, so no network access is needed downstream.
    """
    if isinstance(node, dict):
        if "@context" in node:
            node["@context"] = _resolve_context_value(node["@context"])
        for value in node.values():
            _resolve_remote_contexts(value)
    elif isinstance(node, list):
        for item in node:
            _resolve_remote_contexts(item)
    return node


def _resolve_context_value(ctx_val):
    if isinstance(ctx_val, str) and re.match(r"^https?://", ctx_val):
        return _fetch_remote_context(ctx_val)
    if isinstance(ctx_val, list):
        resolved = [_resolve_context_value(item) for item in ctx_val]
        # Flatten: multiple context objects merge left-to-right, later keys win.
        merged: dict = {}
        for item in resolved:
            if isinstance(item, dict):
                merged.update(item)
            else:
                # Non-dict entries (e.g. a lone @vocab-only string, unusual) keep as-is
                return resolved
        return merged
    if isinstance(ctx_val, dict):
        imp = ctx_val.get("@import")
        if isinstance(imp, str) and re.match(r"^https?://", imp):
            imported = _fetch_remote_context(imp)
            merged = dict(imported) if isinstance(imported, dict) else {}
            merged.update({k: v for k, v in ctx_val.items() if k != "@import"})
            ctx_val = merged
        for k, v in list(ctx_val.items()):
            if k == "@context":
                ctx_val[k] = _resolve_context_value(v)
            elif isinstance(v, dict) and "@context" in v:
                v["@context"] = _resolve_context_value(v["@context"])
        return ctx_val
    return ctx_val


def serialized_graph_response(graph: Graph, format: str, basename: str) -> Response:
    if format not in FORMATS:
        raise HTTPException(400, f"Format must be one of: {', '.join(FORMATS)}")
    rdf_format, media_type, extension = FORMATS[format]
    if rdf_format == "nquads":
        from rdflib import Dataset
        ds = Dataset()
        for triple in graph:
            ds.add(triple)
        content = re.sub(r" <urn:x-rdflib:default>( \.|\n|$)", r"\1", ds.serialize(format="nquads"))
    else:
        content = graph.serialize(format=rdf_format)
    return Response(
        content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{basename}.{extension}"'},
    )


def json_term(term):
    if isinstance(term, URIRef):
        return {"type": "iri", "value": str(term)}
    if isinstance(term, BNode):
        return {"type": "blankNode", "value": str(term)}
    value = {"type": "literal", "value": str(term)}
    if isinstance(term, Literal) and term.datatype:
        value["datatype"] = str(term.datatype)
    if isinstance(term, Literal) and term.language:
        value["language"] = term.language
    return value


def rdf_format_for_filename(filename: str | None, *, allow_json_ld: bool = True) -> str:
    suffix = (filename or "").rsplit(".", 1)[-1].lower()
    formats = {**RDF_EXTENSIONS}
    if allow_json_ld:
        formats["json"] = "json-ld"
    rdf_format = formats.get(suffix)
    if not rdf_format:
        supported = "ttl, jsonld, rdf, xml, nt, nq" + (", json/json-ld" if allow_json_ld else "")
        raise HTTPException(400, f"Unsupported file type. Supported RDF extensions: {supported}")
    return rdf_format


def parse_rdf_upload(raw: bytes, filename: str | None, *, allow_json_ld: bool = True) -> Graph:
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(413, "File exceeds 20 MB limit")
    rdf_format = rdf_format_for_filename(filename, allow_json_ld=allow_json_ld)
    if rdf_format == "json-ld":
        try:
            parsed_doc = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed_doc = None  # let rdflib produce the real syntax error below
        if parsed_doc is not None:
            _resolve_remote_contexts(parsed_doc)
            raw = json.dumps(parsed_doc).encode("utf-8")
    try:
        return Graph().parse(source=BytesIO(raw), format=rdf_format)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"Invalid RDF syntax for {filename or 'uploaded file'}: {exc}") from exc


def ontology_classes(graph: Graph) -> set[URIRef]:
    return {
        subject
        for kind in (OWL.Class, RDFS.Class)
        for subject in graph.subjects(RDF.type, kind)
        if isinstance(subject, URIRef)
    }


def ontology_properties(graph: Graph) -> set[URIRef]:
    return {
        subject
        for kind in (OWL.ObjectProperty, OWL.DatatypeProperty, RDF.Property)
        for subject in graph.subjects(RDF.type, kind)
        if isinstance(subject, URIRef)
    }


def local_label(iri: URIRef) -> str:
    text = str(iri).rstrip("/#")
    local = re.split(r"[/#]", text)[-1] or text
    return re.sub(r"(?<!^)([A-Z])", r" \1", local).replace("_", " ").replace("-", " ").strip() or local


def inferred_resource_types(graph: Graph) -> set[URIRef]:
    explicit_classes = ontology_classes(graph)
    return {
        resource_type for subject, resource_type in graph.subject_objects(RDF.type)
        if isinstance(subject, URIRef)
        and isinstance(resource_type, URIRef)
        and resource_type not in BUILTIN_TYPES
        and subject not in explicit_classes
    }


def infer_ontology_from_instances(graph: Graph, ontology_graph: Graph, known_classes: set[URIRef], known_properties: set[URIRef]) -> tuple[set[URIRef], set[URIRef]]:
    inferred_classes = inferred_resource_types(graph) - known_classes
    inferred_properties: set[URIRef] = set()
    for class_iri in inferred_classes:
        ontology_graph.add((class_iri, RDF.type, OWL.Class))
        ontology_graph.add((class_iri, RDFS.label, Literal(local_label(class_iri))))
    renderable_classes = known_classes | inferred_classes
    resources = {
        subject for subject, resource_type in graph.subject_objects(RDF.type)
        if isinstance(subject, URIRef) and resource_type in renderable_classes
    }
    for resource in resources:
        resource_classes = {value for value in graph.objects(resource, RDF.type) if value in renderable_classes}
        for predicate, value in graph.predicate_objects(resource):
            if not isinstance(predicate, URIRef) or predicate in SKIP_INFERRED_PROPERTIES or predicate in known_properties:
                continue
            inferred_properties.add(predicate)
            if isinstance(value, URIRef):
                ontology_graph.add((predicate, RDF.type, OWL.ObjectProperty))
                targets = {target_type for target_type in graph.objects(value, RDF.type) if target_type in renderable_classes}
                for target_type in targets:
                    ontology_graph.add((predicate, RDFS.range, target_type))
            else:
                ontology_graph.add((predicate, RDF.type, OWL.DatatypeProperty))
                datatype = value.datatype if isinstance(value, Literal) and value.datatype else XSD.string
                ontology_graph.add((predicate, RDFS.range, datatype))
            ontology_graph.add((predicate, RDFS.label, Literal(local_label(predicate))))
            for class_iri in resource_classes:
                ontology_graph.add((predicate, RDFS.domain, class_iri))
    return inferred_classes, inferred_properties


def extract_ontology_graph(
    graph: Graph,
    baseline_classes: set[URIRef] | None = None,
    baseline_properties: set[URIRef] | None = None,
) -> tuple[Graph, set[URIRef], set[URIRef], set[URIRef]]:
    """baseline_classes/baseline_properties are what the LIVE STORE already knows, distinct
    from what THIS uploaded document itself declares. A small instance-only document (e.g.
    a classgen pipeline export) never redeclares owl:Class/owl:ObjectProperty for things
    that already exist - without the baseline, infer_ontology_from_instances would treat
    already-known classes and shared plumbing predicates (hasInput, hasOutput, canvasX,
    canvasY, computesMetric) as brand-new every time, re-scoping their rdfs:domain/range to
    whatever classes happen to co-occur in that one upload - a real, previously-shipped bug."""
    own_classes = ontology_classes(graph)
    own_properties = ontology_properties(graph)
    # Used ONLY to decide what infer_ontology_from_instances may skip as already-known -
    # never mixed into the returned classes/properties, or every import would over-report
    # "discovering" things that already existed and re-upload their triples redundantly.
    known_classes = own_classes | (baseline_classes or set())
    known_properties = own_properties | (baseline_properties or set())
    instance_subjects = {
        subject for subject, resource_type in graph.subject_objects(RDF.type)
        if isinstance(subject, URIRef) and isinstance(resource_type, URIRef) and resource_type in known_classes and subject not in known_classes
    }
    resource_specific_properties = {
        subject for subject in graph.subjects(URIRef(f"{RPS}resourceDomain"), None) if isinstance(subject, URIRef)
    }
    ontology_graph = Graph()
    for prefix, namespace in graph.namespaces():
        ontology_graph.bind(prefix, namespace)
    ontology_terms = {
        subject
        for kind in (OWL.Ontology, OWL.Class, OWL.ObjectProperty, OWL.DatatypeProperty, RDF.Property)
        for subject in graph.subjects(RDF.type, kind)
        if isinstance(subject, URIRef) and subject not in resource_specific_properties
    }
    for term in ontology_terms:
        for predicate, value in graph.predicate_objects(term):
            if predicate == URIRef(f"{RPS}resourceDomain"):
                continue
            ontology_graph.add((term, predicate, value))
    inferred_classes, inferred_properties = infer_ontology_from_instances(graph, ontology_graph, known_classes, known_properties)
    classes = own_classes | inferred_classes
    properties = (own_properties - resource_specific_properties) | inferred_properties
    if not classes and not properties:
        raise HTTPException(400, "Ontology import must define or imply at least one class or property. Expected owl:Class/rdfs:Class declarations or resources typed with ontology classes.")
    instance_subjects = instance_subjects | {
        subject for subject, resource_type in graph.subject_objects(RDF.type)
        if isinstance(subject, URIRef) and resource_type in inferred_classes
    }
    return ontology_graph, classes, properties, instance_subjects


def validate_ontology_graph(graph: Graph) -> tuple[set[URIRef], set[URIRef]]:
    _, classes, properties, _ = extract_ontology_graph(graph)
    return classes, properties


def current_ontology_classes() -> set[URIRef]:
    graph = construct("PREFIX owl: <http://www.w3.org/2002/07/owl#> CONSTRUCT { ?class a owl:Class } WHERE { ?class a owl:Class }")
    return ontology_classes(graph)


def current_ontology_properties() -> set[URIRef]:
    graph = construct(
        "PREFIX owl: <http://www.w3.org/2002/07/owl#> "
        "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> "
        "CONSTRUCT { ?p a ?type } WHERE { ?p a ?type . "
        "FILTER(?type IN (owl:ObjectProperty, owl:DatatypeProperty, rdf:Property)) }"
    )
    return ontology_properties(graph)


def validate_pipeline_graph(graph: Graph, available_classes: set[URIRef]) -> set[URIRef]:
    file_classes = ontology_classes(graph)
    resource_types = {
        resource_type for subject, resource_type in graph.subject_objects(RDF.type)
        if isinstance(subject, URIRef)
        and isinstance(resource_type, URIRef)
        and resource_type not in BUILTIN_TYPES
        and subject not in file_classes
    }
    if not resource_types:
        raise HTTPException(400, "Pipeline import must contain at least one resource typed with an ontology class.")
    missing = sorted(str(resource_type) for resource_type in resource_types if resource_type not in available_classes)
    if missing:
        preview = ", ".join(missing[:5])
        suffix = "…" if len(missing) > 5 else ""
        raise HTTPException(400, f"Pipeline references classes that are not defined in the ontology: {preview}{suffix}. Import the ontology/classes first, then import the pipeline.")
    resources = {subject for subject, resource_type in graph.subject_objects(RDF.type) if resource_type in available_classes and isinstance(subject, URIRef)}
    if not resources:
        raise HTTPException(400, "No renderable pipeline resources found. Resources must use classes already defined in the ontology.")
    return resources


def extract_pipeline_graph(graph: Graph, available_classes: set[URIRef]) -> tuple[Graph, set[URIRef]]:
    resources = {
        subject for subject, resource_type in graph.subject_objects(RDF.type)
        if isinstance(subject, URIRef) and isinstance(resource_type, URIRef) and resource_type in available_classes
    }
    pipeline_graph = Graph()
    for prefix, namespace in graph.namespaces():
        pipeline_graph.bind(prefix, namespace)
    for resource in resources:
        for predicate, value in graph.predicate_objects(resource):
            pipeline_graph.add((resource, predicate, value))
        for source, predicate in graph.subject_predicates(resource):
            if source in resources and predicate != RDF.type:
                pipeline_graph.add((source, predicate, resource))
        for statement in set(graph.subjects(RDF.subject, resource)) | set(graph.subjects(RDF.object, resource)):
            for predicate, value in graph.predicate_objects(statement):
                pipeline_graph.add((statement, predicate, value))
        for property_iri in graph.subjects(URIRef(f"{RPS}resourceDomain"), resource):
            if isinstance(property_iri, URIRef):
                for predicate, value in graph.predicate_objects(property_iri):
                    pipeline_graph.add((property_iri, predicate, value))
    return pipeline_graph, resources


def clear_pipeline_resources(available_classes: set[URIRef]) -> None:
    if not available_classes:
        return
    values = " ".join(f"<{class_iri}>" for class_iri in sorted(available_classes, key=str))
    update(f"""
        DELETE {{ ?resource ?p ?o . ?s ?sp ?resource . ?connection ?cp ?co }}
        WHERE {{
          VALUES ?class {{ {values} }}
          ?resource a ?class .
          OPTIONAL {{ ?resource ?p ?o }}
          OPTIONAL {{ ?s ?sp ?resource }}
          OPTIONAL {{
            ?connection <http://www.w3.org/1999/02/22-rdf-syntax-ns#subject> ?resource ;
                        ?cp ?co .
          }}
          OPTIONAL {{
            ?connection <http://www.w3.org/1999/02/22-rdf-syntax-ns#object> ?resource ;
                        ?cp ?co .
          }}
        }}
    """)


def parse_pipeline_json(raw: bytes, available_classes: set[URIRef]) -> Graph:
    try:
        document = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(400, f"Invalid pipeline JSON: {exc}") from exc
    if document.get("format") != "rdf-pipeline-studio" or not isinstance(document.get("nodes"), list):
        raise HTTPException(400, "Pipeline JSON must be an RDF Pipeline Studio export with format='rdf-pipeline-studio' and a nodes array.")
    graph = Graph()
    resources: set[URIRef] = set()
    for node in document["nodes"]:
        if not isinstance(node, dict) or not node.get("id") or not isinstance(node.get("types"), list):
            raise HTTPException(400, "Every pipeline node must have an id and types array.")
        resource = URIRef(node["id"])
        resources.add(resource)
        for type_iri in node["types"]:
            class_iri = URIRef(type_iri)
            if class_iri not in available_classes:
                raise HTTPException(400, f"Pipeline references class {class_iri}, which is not defined in the ontology. Import ontology/classes first.")
            graph.add((resource, RDF.type, class_iri))
        if node.get("label"):
            graph.add((resource, RDFS.label, Literal(str(node["label"]))))
        position = node.get("position")
        if isinstance(position, dict):
            if position.get("x") is not None:
                graph.add((resource, URIRef(f"{RPS}canvasX"), Literal(str(position["x"]))))
            if position.get("y") is not None:
                graph.add((resource, URIRef(f"{RPS}canvasY"), Literal(str(position["y"]))))
        for prop in node.get("properties", []):
            predicate = URIRef(prop["predicate"])
            value = prop["value"]
            if value["type"] == "iri":
                graph.add((resource, predicate, URIRef(value["value"])))
            else:
                graph.add((resource, predicate, Literal(value["value"], datatype=URIRef(value["datatype"]) if value.get("datatype") else None, lang=value.get("language"))))
    for edge in document.get("edges", []):
        source, predicate, target = URIRef(edge["source"]), URIRef(edge["predicate"]), URIRef(edge["target"])
        if source not in resources or target not in resources:
            raise HTTPException(400, "Pipeline edge references a node that is not present in the nodes array.")
        graph.add((source, predicate, target))
        connection = BNode()
        graph.add((connection, RDF.type, RDF.Statement))
        graph.add((connection, RDF.subject, source))
        graph.add((connection, RDF.predicate, predicate))
        graph.add((connection, RDF.object, target))
        if edge.get("sourceHandle"):
            graph.add((connection, URIRef(f"{RPS}sourceHandle"), Literal(str(edge["sourceHandle"]))))
        if edge.get("targetHandle"):
            graph.add((connection, URIRef(f"{RPS}targetHandle"), Literal(str(edge["targetHandle"]))))
    if not resources:
        raise HTTPException(400, "Pipeline JSON contains no resources to render.")
    return graph


def edge_metadata(graph: Graph, source: URIRef, predicate: URIRef, target: URIRef) -> dict:
    metadata = {}
    for statement in graph.subjects(RDF.subject, source):
        if (statement, RDF.predicate, predicate) not in graph or (statement, RDF.object, target) not in graph:
            continue
        source_handle = next(graph.objects(statement, URIRef(f"{RPS}sourceHandle")), None)
        target_handle = next(graph.objects(statement, URIRef(f"{RPS}targetHandle")), None)
        if source_handle:
            metadata["sourceHandle"] = str(source_handle)
        if target_handle:
            metadata["targetHandle"] = str(target_handle)
        break
    return metadata


def build_pipeline_document(graph: Graph) -> dict:
    ontology_classes = set(graph.subjects(RDF.type, OWL.Class))
    resources = {subject for subject, resource_type in graph.subject_objects(RDF.type) if resource_type in ontology_classes and isinstance(subject, URIRef)}
    nodes = []
    for resource in sorted(resources, key=str):
        types = sorted(str(value) for value in graph.objects(resource, RDF.type) if value in ontology_classes)
        label = next(graph.objects(resource, RDFS.label), None)
        properties = []
        for predicate, value in sorted(graph.predicate_objects(resource), key=lambda pair: (str(pair[0]), str(pair[1]))):
            if predicate in {RDF.type, RDFS.label} | UI_ONLY_PREDICATES or (isinstance(value, URIRef) and value in resources):
                continue
            properties.append({"predicate": str(predicate), "value": json_term(value)})
        node = {"id": str(resource), "types": types, "label": str(label) if label else None, "properties": properties}
        canvas_x = next(graph.objects(resource, URIRef(f"{RPS}canvasX")), None)
        canvas_y = next(graph.objects(resource, URIRef(f"{RPS}canvasY")), None)
        if canvas_x is not None or canvas_y is not None:
            node["position"] = {"x": float(canvas_x) if canvas_x is not None else 0, "y": float(canvas_y) if canvas_y is not None else 0}
        nodes.append(node)
    edges = []
    for source, predicate, target in graph:
        if source in resources and isinstance(target, URIRef) and target in resources and predicate != RDF.type:
            edges.append({"source": str(source), "predicate": str(predicate), "target": str(target), **edge_metadata(graph, source, predicate, target)})
    edges.sort(key=lambda edge: (edge["source"], edge["predicate"], edge["target"]))
    return {"format": "rdf-pipeline-studio", "version": 2, "nodes": nodes, "edges": edges}


def pipeline_rdf_graph() -> Graph:
    return construct("""
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        PREFIX rps: <https://w3id.org/rdf-pipeline-studio#>
        CONSTRUCT {
          ?resource ?resourcePredicate ?resourceObject .
          ?source ?edgePredicate ?resource .
          ?connection ?connectionPredicate ?connectionObject .
          ?edgePredicate ?edgePredicateProperty ?edgePredicateObject .
          ?resourceProperty ?resourcePropertyPredicate ?resourcePropertyObject .
        }
        WHERE {
          {
            SELECT DISTINCT ?resource WHERE {
              ?class a owl:Class .
              ?resource a ?class .
              FILTER(?resource != ?class)
            }
          }
          OPTIONAL { ?resource ?resourcePredicate ?resourceObject }
          OPTIONAL {
            ?source ?edgePredicate ?resource .
            ?source a ?sourceClass .
            ?sourceClass a owl:Class .
            FILTER(?edgePredicate != rdf:type)
          }
          OPTIONAL {
            ?resource ?edgePredicate ?target .
            ?target a ?targetClass .
            ?targetClass a owl:Class .
            FILTER(?edgePredicate != rdf:type)
            OPTIONAL {
              ?edgePredicate ?edgePredicateProperty ?edgePredicateObject .
              FILTER NOT EXISTS { ?edgePredicate rps:resourceDomain ?ownedResource }
            }
          }
          OPTIONAL {
            ?connection rdf:subject|rdf:object ?resource ;
                        ?connectionPredicate ?connectionObject .
          }
          OPTIONAL {
            ?resourceProperty rps:resourceDomain ?resource ;
                              ?resourcePropertyPredicate ?resourcePropertyObject .
          }
        }
    """)


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        initialize_seed()
    except Exception as exc:
        print(f"Seed initialization deferred: {exc}")
    yield


app = FastAPI(title="RDF Ontology Studio API", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])
app.include_router(ai_router)
app.include_router(codegraph_router)


@app.get("/api/health")
def health():
    try:
        result = query_json("ASK { ?s ?p ?o }")
        return {"status": "ok", "store": "connected", "hasData": result["boolean"]}
    except Exception as exc:
        raise HTTPException(503, f"Fuseki unavailable: {exc}") from exc


@app.post("/api/rdf/import")
async def import_rdf(file: UploadFile = File(...), replace: bool = Query(False)):
    raw = await file.read()
    graph = parse_rdf_upload(raw, file.filename)
    try:
        if replace:
            update("CLEAR ALL")
        triples = upload(graph)
    except RequestException as exc:
        raise HTTPException(503, f"Fuseki operation failed during RDF import: {exc}") from exc
    return {"triples": triples, "filename": file.filename, "replaced": replace, "mode": "raw"}


@app.post("/api/import/ontology")
async def import_ontology(file: UploadFile = File(...), replace: bool = Query(False)):
    raw = await file.read()
    graph = parse_rdf_upload(raw, file.filename)
    try:
        # A merge import (replace=False) should never treat what the LIVE store already knows
        # as newly "inferred" - a fresh replace has no prior state to baseline against.
        baseline_classes = set() if replace else current_ontology_classes()
        baseline_properties = set() if replace else current_ontology_properties()
        ontology_graph, classes, properties, _ = extract_ontology_graph(graph, baseline_classes, baseline_properties)
        if replace:
            update("CLEAR ALL")
            initialize_seed()
        ontology_triples = upload(ontology_graph)
        available_classes = current_ontology_classes() | classes
        pipeline_graph, resources = extract_pipeline_graph(graph, available_classes)
        pipeline_triples = upload(pipeline_graph) if resources else 0
    except RequestException as exc:
        raise HTTPException(503, f"Fuseki operation failed during ontology import: {exc}") from exc
    return {
        "mode": "ontology",
        "triples": ontology_triples + pipeline_triples,
        "ontologyTriples": ontology_triples,
        "pipelineTriples": pipeline_triples,
        "filename": file.filename,
        "classes": len(classes),
        "properties": len(properties),
        "resources": len(resources),
        "replaced": replace,
    }


@app.post("/api/import/pipeline")
async def import_pipeline(file: UploadFile = File(...), replace: bool = Query(False)):
    raw = await file.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(413, "File exceeds 20 MB limit")
    try:
        available_classes = current_ontology_classes()
        suffix = (file.filename or "").rsplit(".", 1)[-1].lower()
        if suffix == "json":
            try:
                document = json.loads(raw.decode("utf-8"))
            except Exception:
                document = None
            if isinstance(document, dict) and document.get("format") == "rdf-pipeline-studio":
                graph = parse_pipeline_json(raw, available_classes)
            else:
                graph = parse_rdf_upload(raw, file.filename, allow_json_ld=True)
        else:
            graph = parse_rdf_upload(raw, file.filename, allow_json_ld=True)
        if not available_classes or any(resource_type not in available_classes for resource_type in inferred_resource_types(graph)):
            ontology_graph, inferred_classes, _, _ = extract_ontology_graph(graph, available_classes, current_ontology_properties())
            if inferred_classes:
                upload(ontology_graph)
                available_classes = current_ontology_classes()
        if not available_classes:
            raise HTTPException(400, "No ontology classes are currently defined or inferable from this pipeline file. Import ontology/classes first, or use RDF resources typed with class IRIs.")
        resources = validate_pipeline_graph(graph, available_classes)
        if replace:
            clear_pipeline_resources(available_classes)
        triples = upload(graph)
    except RequestException as exc:
        raise HTTPException(503, f"Fuseki operation failed during pipeline import: {exc}") from exc
    return {
        "mode": "pipeline",
        "triples": triples,
        "filename": file.filename,
        "resources": len(resources),
        "replaced": replace,
    }


@app.get("/api/rdf/export")
def export_rdf(format: str = Query("turtle"), include_ui_metadata: bool = Query(False)):
    query = ALL_TRIPLES if include_ui_metadata else CLEAN_EXPORT_TRIPLES
    return serialized_graph_response(construct(query), format, "rdf-pipeline-dataset")


@app.get("/api/export/pipeline")
def export_pipeline(format: str = Query("json")):
    if format == "json":
        document = build_pipeline_document(construct(ALL_TRIPLES))
        return JSONResponse(document, headers={"Content-Disposition": 'attachment; filename="pipeline.json"'})
    return serialized_graph_response(pipeline_rdf_graph(), format, "pipeline")


@app.get("/api/export/ontology")
def export_ontology(format: str = Query("turtle")):
    return serialized_graph_response(construct(ONTOLOGY_TRIPLES), format, "ontology")


def _live_graph(include_ui_metadata: bool) -> Graph:
    return construct(ALL_TRIPLES if include_ui_metadata else CLEAN_EXPORT_TRIPLES)


def _paste_graph(document: str | None) -> Graph:
    if not document or not document.strip():
        raise HTTPException(400, "A JSON-LD document is required when source='paste'.")
    try:
        parsed_doc = json.loads(document)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"Could not parse pasted JSON-LD: {exc}") from exc
    _resolve_remote_contexts(parsed_doc)
    graph = Graph()
    try:
        graph.parse(data=json.dumps(parsed_doc), format="json-ld")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"Could not parse pasted JSON-LD: {exc}") from exc
    return graph


def _live_jsonld_document(include_ui_metadata: bool) -> dict | list:
    return json.loads(_live_graph(include_ui_metadata).serialize(format="json-ld"))


def _term_display(term) -> str:
    if isinstance(term, BNode):
        return f"_:{term}"
    return str(term)


def _graph_table_rows(graph: Graph) -> list[dict]:
    rows = []
    for subject, predicate, obj in graph:
        row = {
            "subject": _term_display(subject),
            "predicate": str(predicate),
            "object": _term_display(obj) if not isinstance(obj, Literal) else str(obj),
            "language": obj.language if isinstance(obj, Literal) else None,
            "datatype": str(obj.datatype) if isinstance(obj, Literal) and obj.datatype else None,
            "graph": None,
        }
        rows.append(row)
    return rows


@app.post("/api/jsonld/table")
def jsonld_table(body: JsonLdTableRequest):
    graph = _paste_graph(body.document) if body.source == "paste" else _live_graph(body.include_ui_metadata)
    rows = _graph_table_rows(graph)
    return {"rows": rows, "count": len(rows)}


@app.post("/api/jsonld/frame")
def jsonld_frame(body: JsonLdFrameRequest):
    try:
        frame = json.loads(body.frame)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"Frame is not valid JSON: {exc}") from exc
    _resolve_remote_contexts(frame)
    if body.source == "paste":
        if not body.document or not body.document.strip():
            raise HTTPException(400, "A JSON-LD document is required when source='paste'.")
        try:
            document = json.loads(body.document)
        except json.JSONDecodeError as exc:
            raise HTTPException(400, f"Pasted document is not valid JSON-LD: {exc}") from exc
        _resolve_remote_contexts(document)
    else:
        document = _live_jsonld_document(body.include_ui_metadata)
    try:
        framed = pyld_jsonld.frame(document, frame)
    except Exception as exc:
        raise HTTPException(400, f"Framing failed: {exc}") from exc
    return framed


@app.post("/api/sparql/query")
def sparql_query(body: SparqlRequest):
    try:
        operation = re.search(r"\b(SELECT|ASK|CONSTRUCT|DESCRIBE)\b", body.query, re.IGNORECASE)
        if operation and operation.group(1).upper() in {"CONSTRUCT", "DESCRIBE"}:
            graph = construct(body.query)
            return {"type": "graph", "turtle": graph.serialize(format="turtle"), "triples": len(graph)}
        return {"type": "result", **query_json(body.query)}
    except Exception as exc:
        raise HTTPException(400, f"SPARQL query failed: {exc}") from exc


@app.post("/api/sparql/update")
def sparql_update(body: UpdateRequest):
    try:
        update(body.update)
        return {"status": "updated"}
    except RequestException as exc:
        fuseki_detail = exc.response.text.strip() if exc.response is not None else str(exc)
        raise HTTPException(400, f"SPARQL update failed: {fuseki_detail}") from exc


def term_payload(term):
    if term is None:
        return None
    return {"type": "iri" if isinstance(term, URIRef) else "blank" if isinstance(term, BNode) else "literal", "value": str(term)}


def validation_rules(shapes_graph: Graph, data_graph: Graph, results_graph: Graph):
    violations_by_shape: dict[str, list[dict]] = {}
    for result in results_graph.subjects(RDF.type, SH_VALIDATION_RESULT):
      source_shape = results_graph.value(result, SH_SOURCE_SHAPE)
      key = str(source_shape) if source_shape is not None else ""
      violations_by_shape.setdefault(key, []).append({
          "focusNode": term_payload(results_graph.value(result, SH_FOCUS_NODE)),
          "path": term_payload(results_graph.value(result, SH_RESULT_PATH)),
          "value": term_payload(results_graph.value(result, SH_VALUE)),
          "message": str(results_graph.value(result, SH_RESULT_MESSAGE) or "Validation constraint failed."),
          "severity": term_payload(results_graph.value(result, SH_RESULT_SEVERITY)),
          "constraint": term_payload(results_graph.value(result, SH_SOURCE_CONSTRAINT_COMPONENT)),
      })

    rules = []
    for shape in shapes_graph.subjects(RDF.type, SH_NODE_SHAPE):
        target_class = shapes_graph.value(shape, SH_TARGET_CLASS)
        target_count = len(set(data_graph.subjects(RDF.type, target_class))) if target_class is not None else 0
        for index, property_shape in enumerate(shapes_graph.objects(shape, SH_PROPERTY), start=1):
            path = shapes_graph.value(property_shape, SH_PATH)
            messages = [str(item) for item in shapes_graph.objects(property_shape, SH_MESSAGE)]
            constraints = []
            for predicate, label in [(SH_MIN_COUNT, "minCount"), (SH_MAX_COUNT, "maxCount"), (SH_DATATYPE, "datatype"), (SH_CLASS, "class")]:
                for item in shapes_graph.objects(property_shape, predicate):
                    constraints.append({"type": label, "value": str(item)})
            key = str(property_shape)
            failures = violations_by_shape.get(key, [])
            rules.append({
                "id": key or f"{shape}:{index}",
                "shape": str(shape),
                "targetClass": term_payload(target_class),
                "path": term_payload(path),
                "message": messages[0] if messages else "SHACL property constraint",
                "constraints": constraints,
                "targetCount": target_count,
                "violationCount": len(failures),
                "status": "failed" if failures else "passed",
            })
    return rules, [item for items in violations_by_shape.values() for item in items]


@app.post("/api/validate")
def validate_graph():
    data_graph = construct(ALL_TRIPLES)
    shapes_graph = Graph().parse(Path(__file__).parent.parent / "data" / "shapes.ttl", format="turtle")
    conforms, results_graph, report = validate(data_graph, shacl_graph=shapes_graph, inference="rdfs", abort_on_first=False)
    rules, violations = validation_rules(shapes_graph, data_graph, results_graph)
    return {"conforms": bool(conforms), "report": report, "triples": len(data_graph), "rules": rules, "violations": violations}


@app.get("/api/graph")
def graph_data():
    graph = construct("""
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        CONSTRUCT {
          ?s ?p ?o . ?s rdfs:label ?sourceLabel . ?o rdfs:label ?targetLabel .
          ?s a ?sourceType . ?o a ?targetType .
        }
        WHERE {
          ?s ?p ?o . FILTER(isIRI(?s) && isIRI(?o))
          OPTIONAL { ?s rdfs:label ?sourceLabel } OPTIONAL { ?o rdfs:label ?targetLabel }
          OPTIONAL { ?s a ?sourceType } OPTIONAL { ?o a ?targetType }
        } LIMIT 1000
    """)

    def value(term):
        return {"type": "uri" if isinstance(term, URIRef) else "literal", "value": str(term)}

    rows = []
    for source, predicate, target in graph:
        if not isinstance(source, URIRef) or not isinstance(target, URIRef):
            continue
        row = {"source": value(source), "predicate": value(predicate), "target": value(target)}
        source_label = next(graph.objects(source, RDFS.label), None)
        target_label = next(graph.objects(target, RDFS.label), None)
        source_type = next(graph.objects(source, RDF.type), None)
        target_type = next(graph.objects(target, RDF.type), None)
        if source_label: row["sourceLabel"] = value(source_label)
        if target_label: row["targetLabel"] = value(target_label)
        if source_type: row["sourceType"] = value(source_type)
        if target_type: row["targetType"] = value(target_type)
        rows.append(row)
    return rows
