"""Propose a brand-new ontology class (and an instance of it wired into the live
pipeline) from a user's request plus any code they attached.

This is the counterpart to generate.py: that module types instance nodes against
classes that already exist, silently falling back to a default class when the
model names an undefined one. Here the user is explicitly asking for a term that
does *not* exist yet ("add a lookup table class for route codes"), so the class
definition itself is the output.

Same invariant as generate.py: the LLM returns plain fields, and this module -
not the model - mints IRIs and serializes RDF. Two further rules matter here:

- Reuse beats minting. A request satisfied by an existing class returns a reuse
  proposal instead. That is enforced twice: in the prompt, and again in Python
  against the normalized label of every defined class, because a model that
  ignores the instruction must still not be able to mint a near-duplicate.
- Nothing is written. This module never issues a SPARQL update; the caller
  reviews the proposal and approves it through the existing /api/import/ontology
  endpoint, which ingests the class definitions and the instances together.

The emitted property triples are exactly the set the hand-authoring class editor
writes (rdfs:domain/range, rps:required, rps:multiple, rps:uiWidget), so a
generated class round-trips through that editor like any other.
"""
import json
import re
from collections import Counter

from rdflib import RDF, RDFS, Graph, URIRef
from rdflib.namespace import OWL, XSD

from ..store import construct
from .client import call_structured
from .generate import (
    AI_BASE,
    ALL_TRIPLES,
    ANALYTICAL_PROCESS,
    FINAL_PRODUCT,
    HAS_INPUT,
    HAS_OUTPUT,
    INTERMEDIATE_PRODUCT,
    METRIC_CLASS,
    PRODUCT,
    RPS,
    SOURCE_OF_RECORD,
    _available_classes,
    _normalize_label,
    _ontology_catalog,
    _slug,
)

# The app's own built-in taxonomy (stage/product/source/metric types every pipeline is
# typed against, see generate.py/modify.py) - never the ontology the USER is authoring,
# so it must not count toward "which namespace does this ontology use".
_CORE_TAXONOMY_CLASSES = {str(ANALYTICAL_PROCESS), str(PRODUCT), str(INTERMEDIATE_PRODUCT), str(FINAL_PRODUCT), str(SOURCE_OF_RECORD), str(METRIC_CLASS)}

TEXTAREA_TYPE = f"{RPS}TextArea"
REQUIRED = f"{RPS}required"
MULTIPLE = f"{RPS}multiple"
UI_WIDGET = f"{RPS}uiWidget"
STRUCTURAL_CLASS = URIRef(f"{RPS}structuralClass")
LABEL = str(RDFS.label)
COMMENT = str(RDFS.comment)
SUB_CLASS_OF = str(RDFS.subClassOf)
DOMAIN = str(RDFS.domain)
RANGE = str(RDFS.range)

PROPERTY_TYPES = (OWL.ObjectProperty, OWL.DatatypeProperty, RDF.Property)

# Predicates every resource carries; never offered as a link predicate.
_STRUCTURAL_PREDICATES = {str(RDF.type), LABEL, COMMENT}
# Studio plumbing rather than pipeline lineage - an object property, but not a relationship
# a user would ever draw between two nodes.
_INTERNAL_PREDICATES = {f"{RPS}resourceDomain"}

PROPOSE_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "reuseExistingClassIri": {
            "type": ["string", "null"],
            "description": "If a class in the catalog ALREADY denotes the same concept the user asked for, put its exact IRI here. Only for a genuine synonym - not for a class that could merely hold the data. Leave null otherwise.",
        },
        "reuseRationale": {"type": "string", "description": "One sentence on why that existing class fits, or why none did."},
        "classes": {
            "type": "array",
            "description": "The class to define. ALWAYS fill this in with the class you would define, even when you also set reuseExistingClassIri - it names the concept, and is what gets defined if the reuse is rejected.",
            "items": {
                "type": "object",
                "properties": {
                    "localName": {"type": "string", "description": "UpperCamelCase term name, e.g. RouteCodeLookup. No namespace, no spaces."},
                    "label": {"type": "string"},
                    "comment": {"type": "string", "description": "What this class represents, one or two sentences."},
                    "parentClassIri": {"type": "string", "description": "Exact IRI of a class from the catalog that this specialises, or \"\" when none genuinely fits. Never invent an IRI."},
                    "properties": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "localName": {"type": "string", "description": "lowerCamelCase, e.g. lookupKey."},
                                "label": {"type": "string"},
                                "comment": {"type": "string"},
                                "rangeIri": {"type": "string", "description": f"An XSD datatype IRI (e.g. {XSD.string}), or {TEXTAREA_TYPE} for long text, or the exact IRI of a class (from the catalog, or one you define here) for a relationship."},
                                "required": {"type": "boolean"},
                                "multiple": {"type": "boolean"},
                            },
                            "required": ["localName", "rangeIri"],
                        },
                    },
                },
                "required": ["localName", "label", "comment", "properties"],
            },
        },
        "instances": {
            "type": "array",
            "description": "Instance node(s) of the new class to place into the pipeline, and how they attach to what is already there. Emit one only when the request implies a concrete node; otherwise leave empty.",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Human-readable name of this node."},
                    "classLocalName": {"type": "string", "description": "localName of the class above that this instantiates. Leave empty and set reuseClassIri instead when this instance belongs to a DIFFERENT existing class than the rest of this proposal."},
                    "reuseClassIri": {
                        "type": ["string", "null"],
                        "description": (
                            "Set this INSTEAD of classLocalName when this particular node should be "
                            "an instance of a DIFFERENT existing class than whatever this proposal is "
                            "primarily about - e.g. the request is mainly about a new STAGE (reused or "
                            "defined above), but this instance is that stage's own OUTPUT or its "
                            "computed METRIC, which must be an existing Product/Artifact or Metric "
                            "class, not the stage's own class. Exact IRI from the catalog only - never "
                            "invent one. Leave null when this instance uses classLocalName instead."
                        ),
                    },
                    "comment": {"type": "string"},
                    "links": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "predicateIri": {"type": "string", "description": "Exact property IRI from the catalog (e.g. rps:hasInput). Never invent one."},
                                "targetLabel": {"type": "string", "description": "The label of the node to link to - copied exactly from the pipeline node list, OR the exact `name` of ANOTHER instance you are proposing in this SAME request (e.g. a new stage's own new output/metric can link to each other by name, even though neither exists yet)."},
                                "direction": {"type": "string", "enum": ["out", "in"], "description": "\"out\" means (this instance) predicate (target) - use this when this NEW node consumes something that already exists, e.g. 'a new stage AFTER/downstream of X' means this node hasInput X's OUTPUT (direction out, target = X's output product, NOT X itself). \"in\" means (target) predicate (this instance) - use this only when an EXISTING node consumes this new one as one of ITS inputs. Getting this backwards rewires an existing stage's real inputs instead of adding a new downstream node."},
                            },
                            "required": ["predicateIri", "targetLabel", "direction"],
                        },
                    },
                    "properties": {
                        "type": "array",
                        "description": (
                            "Datatype property VALUES to set directly on this instance (e.g. a "
                            "grouping key, threshold, window, or strategy declared on its class) - "
                            "separate from `links`, which are relationships to OTHER pipeline nodes, "
                            "not values. Use a predicateIri that is a real datatype property of this "
                            "instance's class - either already in the catalog, or one you just "
                            "defined for this class above. Do not just describe such a setting in "
                            "`comment`; set it here so it is an actual queryable value, not prose. "
                            "For a MULTI-VALUED property, emit one entry per value, all with the "
                            "same predicateIri."
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "predicateIri": {"type": "string", "description": "Exact datatype property IRI - from the catalog, or from a property defined for this class above. Never invent one that doesn't exist."},
                                "value": {"type": "string", "description": "The literal value to set."},
                            },
                            "required": ["predicateIri", "value"],
                        },
                    },
                },
                "required": ["name", "classLocalName", "links"],
            },
        },
    },
    "required": ["classes", "instances"],
}

SYSTEM = (
    "You define new terms for an RDF pipeline-lineage ontology. The user wants a class "
    "that does not exist yet. Rules: "
    "(0) ALWAYS fill `classes` with the class you would define, giving it a `localName` "
    "(UpperCamelCase) and a human `label`. Do this even when you set reuseExistingClassIri. "
    "(1) Check the ontology catalog AND the pipeline node list below. If a defined class is "
    "a genuine SYNONYM for what they asked for - it denotes the same concept, not merely a "
    "container that could hold it - set reuseExistingClassIri to its exact IRI and explain "
    "in reuseRationale. This includes 'another'/'a second'/'a new' node playing a ROLE that "
    "an existing pipeline node already plays (e.g. 'a second Aggregation stage' when "
    "'Aggregation Stage' is already listed as a node) - reuse THAT node's class, shown next "
    "to it in the pipeline node list, rather than minting one named after the specific new "
    "node you're adding (that specific name belongs in `instances[].name`, never in "
    "`classes[].label`). A data structure (Table, Matrix, Vector, Scalar, HashMap) is NEVER "
    "a reuse: 'a service calendar is just a Table' is wrong, because Table describes the "
    "shape of a value, not what it means. Minting a near-duplicate of a real domain class "
    "is equally wrong. "
    "(2) Otherwise define the class. Give it a parentClassIri ONLY when a catalog class "
    "genuinely generalises it - an empty string is correct and expected when nothing "
    "fits. Never invent an IRI that is not in the catalog. "
    "(3) Properties must be justified by the user's request or the attached code - do "
    "not pad the class with plausible-sounding fields nobody asked for. Use an XSD "
    "datatype for values, or an exact class IRI for a relationship. "
    "(4) Add an instance only when the request names a concrete node to place in the "
    "pipeline. Link it using property IRIs copied verbatim from the catalog and target "
    "labels copied verbatim from the pipeline node list. Choose `direction` carefully by "
    "thinking about which side actually PRODUCES the data: 'a new stage AFTER/downstream of "
    "X' or 'branching off X's output' means the NEW node consumes something that already "
    "exists - that is direction \"out\" on rps:hasInput, naming X's OUTPUT product (not X "
    "itself) as the target, because the new node is the one with an input, not X. Direction "
    "\"in\" is for the opposite case, where an EXISTING stage consumes this new node as one "
    "of its inputs. Getting this backwards silently rewires an existing stage's real inputs "
    "instead of adding a new downstream node, which is a much bigger mistake than it looks. "
    "CRITICAL: rps:hasInput and rps:hasOutput ALWAYS have a pipeline STAGE as their subject "
    "and a product/artifact/metric-ish node as their object - NEVER the reverse. If you are "
    "writing the `links` for a newly created ARTIFACT/PRODUCT/METRIC instance and want to "
    "say it feeds a downstream stage, do NOT give that artifact its own hasOutput naming "
    "the stage (an artifact never 'produces' a stage) - express it as that stage HAVING the "
    "artifact as an input instead (direction \"in\", predicate hasInput, target = that "
    "stage). Also never give the SAME instance both a hasOutput AND a hasInput naming the "
    "SAME target - a stage cannot consume the very thing it itself produces; if a stage "
    "already has hasOutput to its own new artifact, that artifact needs no separate link "
    "back describing the same relationship a second time. "
    "(5) If the request also configures a SETTING this instance's class declares (a grouping "
    "key, threshold, window, strategy, format, ...), set it via `properties` - a predicateIri "
    "and its literal value - not just in prose in `comment`. This applies whether the class "
    "already existed (reuse) or you just defined it above: either way, use the exact property "
    "IRI from the catalog, or from a property you defined for this class in this same "
    "proposal. Emit one `properties` entry per value for a multi-valued property (e.g. two "
    "entries with the same predicateIri for a grouping key on two columns). Never invent a "
    "predicateIri that isn't a real datatype property of this instance's class. "
    "(6) A request can need MULTIPLE new nodes of DIFFERENT existing classes at once - e.g. "
    "'add a stage for X, with its own output and the metric it computes' needs a Stage "
    "instance, an Artifact/Product instance, AND a Metric instance, three different "
    "classes, not one. reuseExistingClassIri only ever names ONE class for the whole "
    "proposal (whichever the request is primarily about), so give every OTHER instance "
    "that needs a DIFFERENT existing class its own `reuseClassIri` instead of leaving it "
    "typed as the proposal's main class - do not let an output or a metric end up typed as "
    "the stage's own class, that is wrong even though it produces no error. Instances in "
    "this SAME request can also link to EACH OTHER by name (e.g. the new stage hasOutput "
    "its own new output instance) - this works even though neither exists in the graph "
    "yet, using the same targetLabel/direction rules as linking to a pre-existing node. "
    "(7) When the user attached code, derive the class's properties from what the code "
    "actually contains, not from what such a class usually has."
)


def _split_iri(iri: str) -> tuple[str, str]:
    index = max(iri.rfind("#"), iri.rfind("/"))
    return iri[: index + 1], iri[index + 1 :]


def _is_datatype_range(iri: str) -> bool:
    return iri.startswith(str(XSD)) or iri == TEXTAREA_TYPE


def _rdf_range(iri: str) -> str:
    return str(XSD.string) if iri == TEXTAREA_TYPE else iri


def _valid_local_name(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z_][A-Za-z0-9._~-]*", value or ""))


def _derive_local_name(*candidates: str) -> str:
    """UpperCamelCase term name from whatever human text the model gave us.

    Models reliably return a `label` ("GTFS Service Calendar") and routinely omit the
    machine-readable `localName`. Skipping the class in that case throws away a perfectly
    good proposal over a field the model was never going to fill; derive it instead.
    Existing capitalisation is preserved so GTFS does not become Gtfs.
    """
    for candidate in candidates:
        words = re.findall(r"[A-Za-z0-9]+", candidate or "")
        if not words:
            continue
        name = "".join(word if word[:1].isupper() else word.capitalize() for word in words)
        name = re.sub(r"^[^A-Za-z_]+", "", name)
        if _valid_local_name(name):
            return name
    return ""


def _first(item: dict, *keys: str) -> str:
    """Small models drift between `localName`/`className`/`name` for the same field."""
    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


# Words that carry no meaning when deciding whether two class names denote the same thing.
_FILLER_TOKENS = {"a", "an", "the", "of", "for", "and", "class", "type", "kind", "data"}
# Additionally meaningless in a predicate's name: "has input" is the "input" relationship,
# and a user writes "an input to X", never "has input to X".
_RELATION_FILLER = _FILLER_TOKENS | {"has", "is", "to", "be", "as"}


def _significant_tokens(text: str) -> set[str]:
    return {token for token in _normalize_label(text).split() if token and token not in _FILLER_TOKENS}


def _predicate_tokens(text: str) -> set[str]:
    return {token for token in _normalize_label(text).split() if token and token not in _RELATION_FILLER}


def _structural_classes(graph) -> set[str]:
    """Classes that describe the shape of a value (Table, Matrix, ...) rather than a domain
    concept. Marked declaratively in the vocabulary via rps:structuralClass, not by name."""
    return {str(subject) for subject in graph.subjects(STRUCTURAL_CLASS, None)}


def _default_namespace(available_classes: set[str], structural_classes: set[str]) -> str:
    """The namespace new classes land in: whichever one the ontology's REAL domain
    classes overwhelmingly use - excluding the app's own built-in infrastructure
    (structural shape classes, and the core stage/product/source/metric taxonomy every
    pipeline is typed against). Neither reflects the user's own ontology, and on a
    small, freshly-authored one they can easily outnumber it and win the vote, sending
    new classes into rps:/freqrec: instead of the user's real namespace. Never a
    literal - an ontology imported under some other namespace must keep extending
    itself, not sprout RPS terms."""
    domain_classes = available_classes - structural_classes - _CORE_TAXONOMY_CLASSES
    namespaces = Counter(_split_iri(iri)[0] for iri in domain_classes)
    if not namespaces:
        return RPS
    return namespaces.most_common(1)[0][0]


def _linkable_properties(graph) -> dict[str, str]:
    """Only object properties can join two resources. Offering a datatype property (canvasX,
    formula, required) as a link would emit a triple whose object is an IRI where a literal
    belongs - so those are neither offered in the review card nor accepted from the model."""
    linkable: dict[str, str] = {}
    for property_iri in graph.subjects(RDF.type, OWL.ObjectProperty):
        if not isinstance(property_iri, URIRef) or str(property_iri) in _INTERNAL_PREDICATES:
            continue
        label = next(graph.objects(property_iri, RDFS.label), None)
        linkable[str(property_iri)] = str(label) if label else _split_iri(str(property_iri))[1]
    return linkable


def _instance_catalog(graph, available_classes: set[str]) -> dict[str, dict]:
    """normalized label -> {iri, label, classIri} for every labelled node typed with a
    defined class. This is what a proposed link's targetLabel resolves against, using the
    same normalized matching generate.py uses to avoid minting disconnected duplicates."""
    catalog: dict[str, dict] = {}
    for subject, label in graph.subject_objects(RDFS.label):
        if not isinstance(subject, URIRef) or str(subject) in available_classes:
            continue
        class_iri = next((str(t) for t in graph.objects(subject, RDF.type) if str(t) in available_classes), "")
        if not class_iri:
            continue
        catalog[_normalize_label(str(label))] = {"iri": str(subject), "label": str(label), "classIri": class_iri}
    return catalog


def _infer_links(graph, instruction: str, targets: dict[str, dict], predicates: dict[str, str]) -> list[dict]:
    """Recover the link the user asked for when the model forgot to emit an instance.

    "…should be an input to the build_gtfs_route_schedule stage" names both ends, and the
    chat's answer promises them. Without this the synthesized node lands unconnected: the
    promise is broken and nothing appears next to the stage on the canvas. Everything is
    matched against the live catalogs - no keyword tables, no hardcoded predicate names.

    Direction is decided by evidence, not grammar: if the named node already uses the named
    predicate as a subject (build_gtfs_route_schedule rps:hasInput …), then it is the subject
    here too, and the new node is the object.
    """
    haystack = f" {_normalize_label(instruction)} "
    if not instruction.strip():
        return []

    target = max(
        (entry for key, entry in targets.items() if key and f" {key} " in haystack),
        key=lambda entry: len(_normalize_label(entry["label"])),
        default=None,
    )
    words = _predicate_tokens(instruction)
    predicate = max(
        (
            (iri, label) for iri, label in predicates.items()
            if _predicate_tokens(label) and _predicate_tokens(label) <= words
        ),
        key=lambda item: len(_predicate_tokens(item[1])),
        default=None,
    )
    if not target or not predicate:
        return []

    predicate_iri, predicate_label = predicate
    subject_first = (URIRef(target["iri"]), URIRef(predicate_iri), None) in graph
    return [{
        "predicateIri": predicate_iri,
        "predicateLabel": predicate_label,
        "targetIri": target["iri"],
        "targetLabel": target["label"],
        "targetClassIri": target["classIri"],
        "direction": "in" if subject_first else "out",
    }]


def _resolve_target(catalog: dict[str, dict], target_iri: str, target_label: str) -> dict | None:
    if target_iri:
        match = next((entry for entry in catalog.values() if entry["iri"] == target_iri), None)
        if match:
            return match
    return catalog.get(_normalize_label(target_label)) if target_label else None


def _build_links(raw_links, instances_catalog: dict[str, dict], properties_catalog: dict[str, str], linkable: set[str], name: str, warnings: list[str]) -> list[dict]:
    """Resolve a proposed instance's links against the live catalogs, dropping anything
    that names an undefined predicate or an unrecognised target node. Shared by both the
    define-a-new-class path and the reuse-an-existing-class path, since a link is
    resolved identically either way."""
    links: list[dict] = []
    for raw_link in raw_links or []:
        if not isinstance(raw_link, dict):
            continue
        predicate = (raw_link.get("predicateIri") or "").strip()
        target_label = (raw_link.get("targetLabel") or "").strip()
        target_iri = (raw_link.get("targetIri") or "").strip()
        direction = raw_link.get("direction") if raw_link.get("direction") in ("in", "out") else "out"
        if not predicate and not target_iri and not target_label:
            continue  # an empty row the user has not filled in yet
        if predicate not in linkable or predicate in _STRUCTURAL_PREDICATES:
            warnings.append(f"Dropped a link on “{name}”: {predicate or '(no predicate)'} is not a defined property.")
            continue
        # The model names a target; the review card picks one by IRI from a dropdown.
        target = _resolve_target(instances_catalog, target_iri, target_label)
        if not target:
            warnings.append(f"Dropped a link on “{name}”: no pipeline node is called “{target_label or target_iri}”.")
            continue
        links.append({
            "predicateIri": predicate,
            "predicateLabel": properties_catalog.get(predicate) or _split_iri(predicate)[1],
            "targetIri": target["iri"],
            "targetLabel": target["label"],
            "targetClassIri": target["classIri"],
            "direction": direction,
        })
    return links


def _datatype_properties(graph, class_iri: str) -> dict[str, str]:
    """label by IRI for every EXISTING datatype property whose rdfs:domain is class_iri -
    what an instance of this class may set a literal VALUE for via `properties`, as
    opposed to `links` (relationships to other pipeline nodes)."""
    result: dict[str, str] = {}
    for prop in graph.subjects(RDFS.domain, URIRef(class_iri)):
        if (prop, RDF.type, OWL.DatatypeProperty) not in graph:
            continue
        label = next(graph.objects(prop, RDFS.label), None)
        result[str(prop)] = str(label) if label else _split_iri(str(prop))[1]
    return result


def _settable_properties_catalog(graph) -> dict[str, str]:
    """label by IRI for every datatype property carrying rps:required/rps:multiple - the
    class generator's own marker that a property is a user-facing declared parameter, not
    Studio plumbing (canvasX, codeArtifact, ...). Offered globally in the review card's
    per-instance property-value editor, same discipline _linkable_properties uses for
    object-property links."""
    required = URIRef(REQUIRED)
    multiple = URIRef(MULTIPLE)
    result: dict[str, str] = {}
    for prop in graph.subjects(RDF.type, OWL.DatatypeProperty):
        if (prop, required, None) not in graph and (prop, multiple, None) not in graph:
            continue
        label = next(graph.objects(prop, RDFS.label), None)
        result[str(prop)] = str(label) if label else _split_iri(str(prop))[1]
    return result


def _build_property_values(raw_properties, settable: dict[str, str], name: str, warnings: list[str]) -> list[dict]:
    """Resolve a proposed instance's datatype property VALUES against the class's real
    settable properties, dropping anything that names an undefined one. A row with an
    empty predicate/value is a not-yet-filled-in row in the review card, not an error."""
    values: list[dict] = []
    for raw_value in raw_properties or []:
        if not isinstance(raw_value, dict):
            continue
        predicate = (raw_value.get("predicateIri") or "").strip()
        value = raw_value.get("value")
        value = value.strip() if isinstance(value, str) else value
        if not predicate and not value:
            continue
        if predicate not in settable:
            warnings.append(f"Dropped a property value on “{name}”: {predicate or '(no predicate)'} is not a datatype property of this class.")
            continue
        if value is None or value == "":
            continue
        values.append({
            "predicateIri": predicate,
            "predicateLabel": settable.get(predicate) or _split_iri(predicate)[1],
            "value": str(value),
        })
    return values


def _pipeline_node_block(catalog: dict[str, dict]) -> str:
    if not catalog:
        return "Pipeline nodes currently in the graph: (none)"
    lines = "\n".join(f"- {entry['label']} (instance of: {entry['classIri']})" for entry in sorted(catalog.values(), key=lambda e: e["label"]))
    return (
        "Pipeline nodes currently in the graph, with the class each one instantiates. A "
        "link's targetLabel must be one of these labels, copied exactly. IMPORTANT: if the "
        "request is for 'another'/'a second'/'a new' node playing the SAME ROLE as one "
        "already listed here (e.g. 'a second Aggregation stage' when 'Aggregation Stage' is "
        "already a node below), that role's class is shown in parentheses next to it - set "
        "reuseExistingClassIri to THAT class, and put the new node's own specific name (e.g. "
        "'Region Aggregation Stage') only in `instances[].name`, never as the class's own "
        "label. Naming the class after the one new node you're adding mints a needless "
        "one-off class instead of reusing the role that already exists:\n" + lines
    )


def _structural_block(graph) -> str:
    """Name the data-structure classes explicitly, so the model stops offering "it's just a
    Table" as a reuse. They appear in the ontology catalog above like any other class."""
    names = sorted(_class_label(graph, iri) for iri in _structural_classes(graph))
    if not names:
        return ""
    return (
        "These catalog entries are DATA-STRUCTURE classes - they describe the shape of a "
        "value, not a domain concept: " + ", ".join(names) + ". Never reuse one of them for "
        "the user's concept, and never make one a parent class. They are only valid as the "
        "range of a property."
    )


def _property_block(properties: dict[str, str]) -> str:
    if not properties:
        return "Linkable properties: (none)"
    lines = "\n".join(f"- {label}: {iri}" for iri, label in sorted(properties.items(), key=lambda item: item[1]))
    return "Properties available for links, copy the IRI verbatim:\n" + lines


def _reuse_match(label: str, graph, available_classes: set[str]) -> str:
    """The deterministic half of reuse-over-mint: a proposed label that collapses to the
    same normalized form as a defined class IS that class, whatever the model claimed."""
    target = _normalize_label(label)
    if not target:
        return ""
    for class_iri in available_classes:
        class_label = next(graph.objects(URIRef(class_iri), RDFS.label), None)
        names = {_normalize_label(_split_iri(class_iri)[1])}
        if class_label:
            names.add(_normalize_label(str(class_label)))
        if target in names:
            return class_iri
    return ""


def _class_label(graph, class_iri: str) -> str:
    label = next(graph.objects(URIRef(class_iri), RDFS.label), None)
    return str(label) if label else _split_iri(class_iri)[1]


def _class_names(graph, class_iri: str) -> set[str]:
    names = {_split_iri(class_iri)[1]}
    for label in graph.objects(URIRef(class_iri), RDFS.label):
        names.add(str(label))
    return names


def _reuse_is_plausible(graph, class_iri: str, concept: str) -> bool:
    """Does the class the model wants to reuse actually denote the concept asked for?

    Nothing checked this before, so the model's word was final: asked for a GTFS service
    calendar, a small model answered "reuse rps:Table" - and the user got no class, no
    editable card, and a confusing rationale. Reuse is a strong claim (it produces zero
    triples and no review surface), so it needs evidence: the class's name and the concept
    must share a meaningful word. Exact label equality is handled earlier by _reuse_match
    and always wins; this only gates the model's own suggestion.
    """
    wanted = _significant_tokens(concept)
    if not wanted:
        return False
    return any(_significant_tokens(name) & wanted for name in _class_names(graph, class_iri))


def _secondary_types(graph, class_iri: str) -> list[str]:
    """The extra rdf:type(s) - beyond class_iri itself - that EVERY existing instance of
    class_iri already carries, e.g. rps:analyticalProcess alongside the domain stage class
    on every other stage. modify.py/generate.py/rdf_consistency.py all match stages,
    products, etc. by that runtime type via an EXACT rdf:type lookup (Fuseki does no
    subclass inference), so a reused-class instance that skips it would be invisible to
    every one of those - the same bug the ontology's own hand-authored instances had before
    being dual-typed. Returns [] when there are no existing instances to learn this from,
    or when they disagree, rather than guessing."""
    instances = list(graph.subjects(RDF.type, URIRef(class_iri)))
    if not instances:
        return []
    type_sets = [{str(t) for t in graph.objects(instance, RDF.type) if str(t) != class_iri} for instance in instances]
    first = type_sets[0]
    if first and all(types == first for types in type_sets[1:]):
        return sorted(first)
    return []


def _stage_status(graph, iri: str, instances_by_iri: dict[str, dict]) -> bool | None:
    """Whether an IRI - a pre-existing graph node, or a SIBLING instance being created in
    this same proposal - denotes a pipeline STAGE (carries rps:analyticalProcess).

    True/False when we have real ground truth: a pre-existing node's actual rdf:type, or a
    sibling instantiating a REUSED existing class (its extraTypes were learned from that
    class's real instances). None ("unknown") for a sibling instantiating a class defined
    fresh in this same proposal - a brand-new class is never dual-typed with the runtime
    taxonomy (nothing existing to learn it from), so it could be a stage or not; treat that
    as "don't know" rather than "definitely not", or every hasInput/hasOutput on a
    genuinely new stage-like class would be wrongly flagged as backwards."""
    sibling = instances_by_iri.get(iri)
    if sibling is not None:
        if sibling.get("classIsNew"):
            return None
        return str(ANALYTICAL_PROCESS) in sibling.get("extraTypes", [])
    return (URIRef(iri), RDF.type, ANALYTICAL_PROCESS) in graph


def _link_pair(instance: dict, link: dict) -> tuple[str, str]:
    """The (subject_iri, object_iri) a link actually materializes to, regardless of which
    instance's `links` array it was written on or which direction was used."""
    if link["direction"] == "out":
        return instance["iri"], link["targetIri"]
    return link["targetIri"], instance["iri"]


def _validate_lineage_links(graph, instances: list[dict], warnings: list[str]) -> None:
    """rps:hasInput/rps:hasOutput always have a pipeline STAGE as their subject and an
    artifact/product/metric-ish node as their object - never the reverse, and never the
    SAME (stage, artifact) pair on both predicates (a stage cannot consume what it itself
    produces). Both are syntactically valid RDF - _build_links has no way to catch them,
    since it resolves one link at a time against real predicates/targets - but they produce
    nonsensical lineage, the kind of mistake a model composing a NEW artifact's own
    relationships back to a stage predictably makes (once correctly, from the stage's own
    hasOutput; once backwards, from the artifact's own reciprocal link - so the duplicate
    has to be caught across the whole batch, not within one instance's own list). Mutates
    `instances` in place, dropping the offending link and warning instead of silently
    writing it - same discipline as everything else _build_links already rejects."""
    instances_by_iri = {item["iri"]: item for item in instances}

    # Pass 1: drop a link whose SUBJECT is confirmed NOT a stage. A subject we have no
    # ground truth for (a sibling of a brand-new class) is left alone, not rejected.
    for instance in instances:
        kept: list[dict] = []
        for link in instance["links"]:
            predicate = link["predicateIri"]
            if predicate not in (str(HAS_INPUT), str(HAS_OUTPUT)):
                kept.append(link)
                continue
            subject_iri = link["targetIri"] if link["direction"] == "in" else instance["iri"]
            if _stage_status(graph, subject_iri, instances_by_iri) is False:
                predicate_name = _split_iri(predicate)[1]
                preposition = "from" if link["direction"] == "in" else "to"
                warnings.append(
                    f"Dropped a {predicate_name} link on “{instance['name']}” ({preposition} "
                    f"“{link['targetLabel']}”): {predicate_name} always has a pipeline STAGE as its "
                    f"subject, and neither side here is one - if this should feed a downstream stage, "
                    f"that stage's own hasInput should name this as its target instead."
                )
                continue
            kept.append(link)
        instance["links"] = kept

    # Pass 2: the SAME (stage, artifact) pair claimed as both hasOutput and hasInput -
    # computed across ALL instances' surviving links, since either half of the duplicate
    # could have come from a different instance than the other half.
    has_output_pairs = {
        _link_pair(instance, link)
        for instance in instances
        for link in instance["links"]
        if link["predicateIri"] == str(HAS_OUTPUT)
    }
    for instance in instances:
        kept = []
        for link in instance["links"]:
            if link["predicateIri"] == str(HAS_INPUT) and _link_pair(instance, link) in has_output_pairs:
                warnings.append(
                    f"Dropped a hasInput link on “{instance['name']}” ({'from' if link['direction'] == 'in' else 'to'} "
                    f"“{link['targetLabel']}”): that pair is already a hasOutput, and a stage cannot "
                    f"consume the very thing it itself produces."
                )
                continue
            kept.append(link)
        instance["links"] = kept


def normalize_proposal(raw: dict, graph, instruction: str = "") -> dict:
    """Validate and resolve a raw proposal - from the LLM, or edited by the user - into
    one with real IRIs. Both paths run through here so a user's edits get exactly the
    same guards the model's output does.
    """
    available_classes = _available_classes(graph)
    structural_classes = _structural_classes(graph)
    # Table/Matrix/... describe a value's shape, not a domain concept. They are never a
    # sensible parent for, or reuse of, a class the user is asking us to define - though
    # they stay valid as property ranges (see known_classes below).
    concept_classes = available_classes - structural_classes
    properties_catalog = _linkable_properties(graph)
    instances_catalog = _instance_catalog(graph, available_classes)
    warnings: list[str] = []

    reuse_iri = (raw.get("reuseExistingClassIri") or "").strip()
    raw_classes = [item for item in (raw.get("classes") or []) if isinstance(item, dict)]
    # The name the user's concept goes by, used to judge whether a proposed reuse is real.
    concept = next((_first(item, "label", "name", "localName", "className") for item in raw_classes), "")

    # A class whose name already exists IS that class, no matter what the model returned.
    if not reuse_iri:
        for item in raw_classes:
            proposed_name = _first(item, "label", "name", "localName", "className")
            match = _reuse_match(proposed_name, graph, concept_classes)
            if match:
                reuse_iri = match
                warnings.append(
                    f"“{proposed_name}” already exists as {_class_label(graph, match)}; reusing it instead of defining a duplicate."
                )
                break
    elif reuse_iri in structural_classes:
        warnings.append(
            f"Ignored a proposed reuse of {_class_label(graph, reuse_iri)}, which describes a data "
            f"structure rather than a domain concept."
        )
        reuse_iri = ""
    elif reuse_iri in available_classes and concept and not _reuse_is_plausible(graph, reuse_iri, concept):
        warnings.append(
            f"Ignored a proposed reuse of {_class_label(graph, reuse_iri)}, which does not denote "
            f"“{concept}”. Defining the class instead."
        )
        reuse_iri = ""

    if reuse_iri in concept_classes:
        # Reuse means no new class - but the user may still be asking for a NEW NODE of
        # that existing class in the pipeline ("a second Aggregation stage for region
        # only"), which is exactly as legitimate a request as defining a new class was.
        # Only linkable object properties already in the ontology apply here since no
        # new class/property is being minted alongside this reuse.
        raw_instances = [item for item in (raw.get("instances") or []) if isinstance(item, dict)]
        if not raw_instances:
            inferred = _infer_links(graph, instruction, instances_catalog, properties_catalog)
            if inferred:
                raw_instances = [{"name": concept or _class_label(graph, reuse_iri), "links": inferred}]
        # Pass 1: resolve each instance's NAME and CLASS before touching links, so a link
        # can target a SIBLING instance being created in this same batch (e.g. a new
        # stage's own new output/metric), not only nodes already in the graph. A request
        # can need several DIFFERENT existing classes at once (a stage + its own output +
        # its own metric) - reuseExistingClassIri only ever names ONE for the whole
        # proposal, so an instance whose reuseClassIri names a DIFFERENT real class opts
        # out of that default instead of being incorrectly forced onto it.
        resolved: list[dict] = []
        for raw_instance in raw_instances:
            name = _first(raw_instance, "name", "label")
            if not name:
                continue
            override = (raw_instance.get("reuseClassIri") or "").strip()
            class_iri = override if override in concept_classes else reuse_iri
            resolved.append({"raw": raw_instance, "name": name, "iri": f"{AI_BASE}/{_slug(name)}", "classIri": class_iri})

        local_catalog = {_normalize_label(item["name"]): {"iri": item["iri"], "label": item["name"], "classIri": item["classIri"]} for item in resolved}
        combined_catalog = {**instances_catalog, **local_catalog}

        # Every existing instance of the reused class carries this same extra runtime type
        # (if any) - propagate it, or the new node is invisible to modify.py/rdf_consistency,
        # which match stages/products by an exact rdf:type, not this domain class. A
        # per-instance reuseClassIri override needs its OWN lookup, not the default's.
        default_extra_types = _secondary_types(graph, reuse_iri)
        default_settable = _datatype_properties(graph, reuse_iri)
        instances: list[dict] = []
        for item in resolved:
            name, class_iri = item["name"], item["classIri"]
            is_default = class_iri == reuse_iri
            extra_types = default_extra_types if is_default else _secondary_types(graph, class_iri)
            settable = default_settable if is_default else _datatype_properties(graph, class_iri)
            if not extra_types and next(graph.subjects(RDF.type, URIRef(class_iri)), None) is not None:
                # Existing instances of this class exist but disagree on a runtime type
                # (e.g. some Artifacts are intermediate products, one is a source, one is
                # final) - refusing to guess is right, but the user should know this node
                # may need one set manually (Edit RDF properties, or a follow-up request).
                warnings.append(
                    f"“{name}” could not inherit a runtime type from existing "
                    f"{_class_label(graph, class_iri)} instances (they don't all agree on "
                    f"one) - you may want to set one manually afterward."
                )
            links = _build_links(item["raw"].get("links"), combined_catalog, properties_catalog, set(properties_catalog), name, warnings)
            property_values = _build_property_values(item["raw"].get("properties"), settable, name, warnings)
            instances.append({
                "iri": item["iri"],
                "name": name,
                "classIri": class_iri,
                "classLabel": _class_label(graph, class_iri),
                "classIsNew": False,  # reuse branch never mints a class
                "extraTypes": extra_types,
                "comment": (item["raw"].get("comment") or "").strip(),
                "links": links,
                "propertyValues": property_values,
            })
        _validate_lineage_links(graph, instances, warnings)
        for instance in instances:
            if not instance["links"]:
                warnings.append(
                    f"“{instance['name']}” is not linked to anything yet - it will be created on its "
                    f"own. Add a link below to attach it to an existing node."
                )
        return {
            "reuse": {
                "classIri": reuse_iri,
                "classLabel": _class_label(graph, reuse_iri),
                "rationale": (raw.get("reuseRationale") or "").strip(),
            },
            "classes": [],
            "instances": instances,
            "warnings": warnings,
        }
    if reuse_iri:
        warnings.append(f"Ignored a proposed reuse of {reuse_iri}, which is not a defined class.")

    namespace = _default_namespace(available_classes, structural_classes)
    classes: list[dict] = []
    for item in raw_classes:
        # Models reliably give a human label and routinely omit localName; derive it rather
        # than discarding the whole class over a field they were never going to fill.
        local_name = _first(item, "localName", "className")
        if not _valid_local_name(local_name):
            local_name = _derive_local_name(local_name, _first(item, "label", "name"))
        if not _valid_local_name(local_name):
            warnings.append("Skipped a class the model gave no usable name for.")
            continue
        class_namespace = (item.get("namespace") or "").strip() or namespace
        parent = (item.get("parentClassIri") or "").strip()
        if parent and parent in structural_classes:
            warnings.append(f"Dropped parent class {_class_label(graph, parent)}: it describes a data structure, not a domain concept.")
            parent = ""
        elif parent and parent not in concept_classes:
            warnings.append(f"Dropped parent class {parent}, which is not defined in the ontology.")
            parent = ""
        class_iri = f"{class_namespace}{local_name}"
        if class_iri in available_classes:
            warnings.append(f"{class_iri} is already defined; approving will update it rather than create a new class.")
        classes.append({
            "iri": class_iri,
            "namespace": class_namespace,
            "localName": local_name,
            "label": _first(item, "label", "name") or local_name,
            "comment": _first(item, "comment", "description"),
            "parentClassIri": parent,
            "properties": [],
            "_rawProperties": item.get("properties") or [],
        })

    if not classes:
        return {"reuse": None, "classes": [], "instances": [], "warnings": warnings or ["The model proposed no class to define."]}

    # Ranges may point at a class defined in this same proposal, so resolve properties
    # only once every proposed class IRI is known.
    known_classes = available_classes | {item["iri"] for item in classes}
    for item in classes:
        for raw_property in item.pop("_rawProperties"):
            if not isinstance(raw_property, dict):
                continue
            property_local = _first(raw_property, "localName", "name")
            if not _valid_local_name(property_local):
                # lowerCamelCase, matching the convention the class editor uses.
                derived = _derive_local_name(property_local, _first(raw_property, "label"))
                property_local = derived[:1].lower() + derived[1:] if derived else ""
            range_iri = _first(raw_property, "rangeIri", "range", "type")
            if not _valid_local_name(property_local) or not range_iri:
                warnings.append(f"Skipped a property of {item['label']} with an unusable name or type.")
                continue
            datatype = _is_datatype_range(range_iri)
            if not datatype and range_iri not in known_classes:
                warnings.append(f"Skipped property “{property_local}”: its type {range_iri} is neither a datatype nor a defined class.")
                continue
            property_iri = (raw_property.get("iri") or "").strip() or f"{item['namespace']}{property_local}"
            item["properties"].append({
                "iri": property_iri,
                "localName": property_local,
                "label": _first(raw_property, "label", "name") or property_local,
                "comment": _first(raw_property, "comment", "description"),
                "rangeIri": range_iri,
                "kind": "datatype" if datatype else "object",
                "required": bool(raw_property.get("required")),
                "multiple": bool(raw_property.get("multiple")),
            })

    # A newly proposed property may also be a link predicate, but only if it is an object
    # property - a datatype property's object is a literal, not a node.
    linkable = set(properties_catalog) | {
        property_item["iri"]
        for item in classes
        for property_item in item["properties"]
        if property_item["kind"] == "object"
    }
    classes_by_local = {item["localName"]: item for item in classes}

    raw_instances = [item for item in (raw.get("instances") or []) if isinstance(item, dict)]
    # A class with no instance is invisible: it lands in the ontology but nothing appears on
    # the pipeline canvas, so the feature looks like it did nothing. The tool schema tells
    # the model to emit an instance "only when the request implies a concrete node", and it
    # usually declines. Give every proposed class a node the user can name, place and link
    # in the review card - deleting it there is one click, whereas conjuring one is not.
    if not raw_instances:
        # The instruction usually names the stage and the relationship ("an input to the
        # build_gtfs_route_schedule stage"), and the chat's answer promises them. Recover
        # that link, or the node lands unconnected and the promise is silently broken.
        inferred = _infer_links(graph, instruction, instances_catalog, properties_catalog)
        raw_instances = [{"name": item["label"] or item["localName"], "classLocalName": item["localName"], "links": inferred} for item in classes]

    # Pass 1: resolve each instance's NAME and CLASS before touching links, so a link can
    # target a SIBLING instance in this same batch (e.g. a newly defined stage class's own
    # new output/metric, which reuses an EXISTING class via reuseClassIri rather than
    # instantiating anything defined in `classes` above).
    resolved: list[dict] = []
    for raw_instance in raw_instances:
        name = _first(raw_instance, "name", "label")
        if not name:
            continue
        override = (raw_instance.get("reuseClassIri") or "").strip()
        if override and override in concept_classes:
            resolved.append({"raw": raw_instance, "name": name, "iri": f"{AI_BASE}/{_slug(name)}", "classIri": override, "owner": None})
            continue
        owner_key = _first(raw_instance, "classLocalName", "className", "classIri")
        owner = classes_by_local.get(owner_key) or classes_by_local.get(_derive_local_name(owner_key))
        # The model names the class in prose ("GTFS Service Calendar") while we mint the
        # localName; when there is only one class on the table, that is the one it means.
        if not owner and len(classes) == 1:
            owner = classes[0]
        if not owner:
            warnings.append(f"Skipped instance “{name}”: it does not instantiate a class in this proposal.")
            continue
        resolved.append({"raw": raw_instance, "name": name, "iri": f"{AI_BASE}/{_slug(name)}", "classIri": owner["iri"], "owner": owner})

    local_catalog = {_normalize_label(item["name"]): {"iri": item["iri"], "label": item["name"], "classIri": item["classIri"]} for item in resolved}
    combined_catalog = {**instances_catalog, **local_catalog}

    instances: list[dict] = []
    for item in resolved:
        name, class_iri, owner = item["name"], item["classIri"], item["owner"]
        links = _build_links(item["raw"].get("links"), combined_catalog, properties_catalog, linkable, name, warnings)
        if owner is not None:
            # A brand-new class has no EXISTING datatype properties yet, but the proposal
            # may define some alongside it in this same request - those are exactly as
            # settable. It also has no established runtime type to propagate (see rule 6
            # for why a reused class's instances always inherit one).
            settable = _datatype_properties(graph, class_iri)
            settable.update({p["iri"]: p["label"] for p in owner["properties"] if p["kind"] == "datatype"})
            extra_types: list[str] = []
        else:
            settable = _datatype_properties(graph, class_iri)
            extra_types = _secondary_types(graph, class_iri)
            if not extra_types and next(graph.subjects(RDF.type, URIRef(class_iri)), None) is not None:
                warnings.append(
                    f"“{name}” could not inherit a runtime type from existing "
                    f"{_class_label(graph, class_iri)} instances (they don't all agree on "
                    f"one) - you may want to set one manually afterward."
                )
        property_values = _build_property_values(item["raw"].get("properties"), settable, name, warnings)
        instances.append({
            # Minted from the name, so renaming the node in the review card renames its IRI
            # too - the same rule the class editor applies to a class's local name.
            "iri": item["iri"],
            "name": name,
            "classIri": class_iri,
            "classLabel": _class_label(graph, class_iri),
            "classIsNew": owner is not None,  # a reuseClassIri override is NOT a new class
            "extraTypes": extra_types,
            "comment": (item["raw"].get("comment") or "").strip(),
            "links": links,
            "propertyValues": property_values,
        })

    _validate_lineage_links(graph, instances, warnings)
    for instance in instances:
        if not instance["links"]:
            warnings.append(
                f"“{instance['name']}” is not linked to anything yet - it will be created on its "
                f"own. Add a link below to attach it to an existing node."
            )
    return {"reuse": None, "classes": classes, "instances": instances, "warnings": warnings}


def _literal(value) -> list[dict]:
    return [{"@value": value}]


def render_jsonld(proposal: dict) -> list[dict]:
    """Serialize a normalized proposal into the expanded JSON-LD that
    /api/import/ontology ingests: class definitions, their properties, the instances,
    and a typed stub for every link target.
    """
    nodes: list[dict] = []
    for item in proposal.get("classes") or []:
        class_node = {"@id": item["iri"], "@type": [str(OWL.Class)], LABEL: _literal(item["label"])}
        if item.get("comment"):
            class_node[COMMENT] = _literal(item["comment"])
        if item.get("parentClassIri"):
            class_node[SUB_CLASS_OF] = [{"@id": item["parentClassIri"]}]
        nodes.append(class_node)

        for property_item in item.get("properties") or []:
            kind = OWL.DatatypeProperty if property_item["kind"] == "datatype" else OWL.ObjectProperty
            property_node = {
                "@id": property_item["iri"],
                "@type": [str(kind)],
                DOMAIN: [{"@id": item["iri"]}],
                RANGE: [{"@id": _rdf_range(property_item["rangeIri"])}],
                REQUIRED: _literal(bool(property_item["required"])),
                MULTIPLE: _literal(bool(property_item["multiple"])),
            }
            if property_item["rangeIri"] == TEXTAREA_TYPE:
                property_node[UI_WIDGET] = _literal("textarea")
            if property_item.get("label"):
                property_node[LABEL] = _literal(property_item["label"])
            if property_item.get("comment"):
                property_node[COMMENT] = _literal(property_item["comment"])
            nodes.append(property_node)

    # extract_pipeline_graph() only keeps a triple pointing AT an instance when its
    # subject is itself typed in the uploaded document. Re-assert each link target's
    # existing class (an idempotent triple) so inbound links survive the import.
    stubs: dict[str, dict] = {}
    for instance in proposal.get("instances") or []:
        instance_node = {"@id": instance["iri"], "@type": [instance["classIri"], *instance.get("extraTypes", [])], LABEL: _literal(instance["name"])}
        if instance.get("comment"):
            instance_node[COMMENT] = _literal(instance["comment"])
        for value_item in instance.get("propertyValues") or []:
            instance_node.setdefault(value_item["predicateIri"], []).append({"@value": value_item["value"]})
        for link in instance.get("links") or []:
            if link["targetClassIri"]:
                stub = stubs.setdefault(link["targetIri"], {"@id": link["targetIri"], "@type": [link["targetClassIri"]]})
            else:
                stub = stubs.setdefault(link["targetIri"], {"@id": link["targetIri"]})
            if link["direction"] == "out":
                instance_node.setdefault(link["predicateIri"], []).append({"@id": link["targetIri"]})
            else:
                stub.setdefault(link["predicateIri"], []).append({"@id": instance["iri"]})
        nodes.append(instance_node)
    nodes.extend(stubs.values())
    return nodes


def _turtle(nodes: list[dict]) -> str:
    graph = Graph()
    graph.parse(data=json.dumps(nodes), format="json-ld")
    graph.bind("owl", OWL)
    graph.bind("rdfs", RDFS)
    graph.bind("xsd", XSD)
    graph.bind("rps", RPS)
    return graph.serialize(format="turtle")


_SCHEMA_TYPES = {str(OWL.Class), str(OWL.ObjectProperty), str(OWL.DatatypeProperty), str(RDF.Property)}


def split_nodes(nodes: list[dict]) -> tuple[list[dict], list[dict]]:
    """Schema nodes (class + property definitions) and instance nodes, kept apart.

    They must be imported in that order, through two different endpoints, because
    /api/import/ontology runs infer_ontology_from_instances() over whatever instances
    it finds. An instance in the schema document makes it *infer* an ontology from the
    typed link-target stubs: it would re-label rps:analyticalProcess and slap an
    rdfs:domain/rdfs:range onto the shared rps:hasInput, narrowing it to the new class.
    Once the class exists, /api/import/pipeline skips inference entirely (main.py:530)
    and simply uploads the instance triples.
    """
    schema, instances = [], []
    for node in nodes:
        types = node.get("@type") or []
        (schema if any(t in _SCHEMA_TYPES for t in types) else instances).append(node)
    return schema, instances


def _link_options(graph) -> dict:
    """The predicates, pipeline nodes, and settable datatype properties a proposal's
    instances may legally use. The review card cannot derive these client-side, and
    anything else is dropped by normalize_proposal - so the card must only ever offer
    these."""
    available_classes = _available_classes(graph)
    predicates = _linkable_properties(graph)
    targets = _instance_catalog(graph, available_classes)
    settable = _settable_properties_catalog(graph)
    return {
        "predicates": [
            {"iri": iri, "label": label}
            for iri, label in sorted(predicates.items(), key=lambda item: item[1])
            if iri not in _STRUCTURAL_PREDICATES
        ],
        "targets": sorted(
            ({"iri": entry["iri"], "label": entry["label"]} for entry in targets.values()),
            key=lambda entry: entry["label"],
        ),
        "properties": [
            {"iri": iri, "label": label}
            for iri, label in sorted(settable.items(), key=lambda item: item[1])
        ],
    }


def _result(proposal: dict, graph) -> dict:
    nodes = render_jsonld(proposal)
    schema, instances = split_nodes(nodes)
    return {
        "proposal": proposal,
        "jsonld": nodes,
        "schemaJsonld": schema,
        "instanceJsonld": instances,
        "turtle": _turtle(nodes) if nodes else "",
        "options": _link_options(graph),
    }


def render_class_proposal(proposal: dict) -> dict:
    """Re-validate and re-serialize a proposal the user edited in the review card. No
    LLM call - the user's edits pass through the same guards as the model's output."""
    if not isinstance(proposal, dict):
        raise ValueError("A proposal object is required.")
    graph = construct(ALL_TRIPLES)
    return _result(normalize_proposal(proposal, graph), graph)


def propose_class(
    instruction: str,
    scripts: list[dict] | None = None,
    provider: str | None = None,
    model: str | None = None,
    model_code: str | None = None,
) -> dict:
    """scripts: [{"filename": str, "source": str}, ...] attached for this one request.
    Nothing is read from or persisted to disk, and nothing is written to the graph."""
    if not (instruction or "").strip():
        raise ValueError("Describe the class you want to create.")

    graph = construct(ALL_TRIPLES)
    available_classes = _available_classes(graph)
    instances_catalog = _instance_catalog(graph, available_classes)
    properties_catalog = _linkable_properties(graph)

    sources = "\n\n".join(
        f"### {script['filename']}\n```text\n{script['source']}\n```" for script in (scripts or [])
    ) or "No code was attached; work from the request alone."

    user_content = (
        f"The user asked for:\n{instruction}\n\n"
        f"{_ontology_catalog(graph)}\n\n"
        f"{_structural_block(graph)}\n\n"
        f"{_property_block(properties_catalog)}\n\n"
        f"{_pipeline_node_block(instances_catalog)}\n\n"
        f"Attached code:\n\n{sources}"
    )

    result = call_structured(
        system=SYSTEM,
        user_content=user_content,
        tool_name="report_class_proposal",
        tool_description="Propose a new ontology class, or the existing class that already covers the request.",
        tool_schema=PROPOSE_TOOL_SCHEMA,
        max_tokens=4000,
        provider=provider,
        model=model,
        model_code=model_code,
    )
    return _result(normalize_proposal(result, graph, instruction), graph)
