import json

from rdflib import Graph, Literal, RDF, RDFS, URIRef
from rdflib.namespace import OWL, XSD

from app.ai import classgen


RPS = "https://w3id.org/rdf-pipeline-studio#"
PRODUCT = URIRef(f"{RPS}product")
STAGE_CLASS = URIRef(f"{RPS}analyticalProcess")
HAS_INPUT = URIRef(f"{RPS}hasInput")


TABLE = URIRef(f"{RPS}Table")
STRUCTURAL = URIRef(f"{RPS}structuralClass")


def _graph() -> Graph:
    """A minimal ontology + one labelled stage, mirroring the seeded shape."""
    graph = Graph()
    graph.add((PRODUCT, RDF.type, OWL.Class))
    graph.add((PRODUCT, RDFS.label, Literal("Product")))
    graph.add((STAGE_CLASS, RDF.type, OWL.Class))
    graph.add((STAGE_CLASS, RDFS.label, Literal("Analytical Process")))
    graph.add((HAS_INPUT, RDF.type, OWL.ObjectProperty))
    graph.add((HAS_INPUT, RDFS.label, Literal("has input")))
    # A data-structure class, marked as such - a reuse trap for the class generator.
    graph.add((TABLE, RDF.type, OWL.Class))
    graph.add((TABLE, RDFS.label, Literal("Table")))
    graph.add((TABLE, STRUCTURAL, Literal(True)))
    stage = URIRef("https://example.org/pipeline/normalize_routes")
    graph.add((stage, RDF.type, STAGE_CLASS))
    graph.add((stage, RDFS.label, Literal("normalize_routes")))
    return graph


def test_existing_class_is_reused_even_when_the_model_asks_to_mint_it():
    # The model ignored the reuse instruction and proposed "Product" from scratch.
    proposal = classgen.normalize_proposal(
        {"classes": [{"localName": "Product", "label": "product", "comment": "x", "properties": []}]},
        _graph(),
    )
    assert proposal["reuse"]["classIri"] == str(PRODUCT)
    assert proposal["classes"] == []
    assert "already exists" in proposal["warnings"][0]


def test_class_iri_inherits_the_ontology_namespace_rather_than_a_hardcoded_one():
    graph = Graph()
    custom = URIRef("https://acme.example/onto#Thing")
    graph.add((custom, RDF.type, OWL.Class))
    proposal = classgen.normalize_proposal(
        {"classes": [{"localName": "RouteCodeLookup", "label": "Route Code Lookup", "comment": "", "properties": []}]},
        graph,
    )
    assert proposal["classes"][0]["iri"] == "https://acme.example/onto#RouteCodeLookup"


def test_undefined_parent_class_is_dropped_not_invented():
    proposal = classgen.normalize_proposal(
        {"classes": [{"localName": "Lookup", "label": "Lookup", "comment": "", "parentClassIri": f"{RPS}NoSuchClass", "properties": []}]},
        _graph(),
    )
    assert proposal["classes"][0]["parentClassIri"] == ""
    assert any("Dropped parent class" in warning for warning in proposal["warnings"])


def test_property_typing_follows_the_range_and_matches_the_class_editor_predicates():
    proposal = classgen.normalize_proposal(
        {"classes": [{
            "localName": "Lookup", "label": "Lookup", "comment": "",
            "properties": [
                {"localName": "lookupKey", "rangeIri": str(XSD.string), "required": True, "multiple": False},
                {"localName": "sourceProduct", "rangeIri": str(PRODUCT), "required": False, "multiple": True},
                {"localName": "notes", "rangeIri": classgen.TEXTAREA_TYPE},
                {"localName": "bogus", "rangeIri": "https://example.org/NotAClass"},
            ],
        }]},
        _graph(),
    )
    properties = {item["localName"]: item for item in proposal["classes"][0]["properties"]}
    assert properties["lookupKey"]["kind"] == "datatype"
    assert properties["sourceProduct"]["kind"] == "object"
    assert "bogus" not in properties

    graph = Graph().parse(data=json.dumps(classgen.render_jsonld(proposal)), format="json-ld")
    key = URIRef(f"{RPS}lookupKey")
    assert (key, RDF.type, OWL.DatatypeProperty) in graph
    assert (key, RDFS.domain, URIRef(f"{RPS}Lookup")) in graph
    assert (key, URIRef(f"{RPS}required"), Literal(True)) in graph
    assert (URIRef(f"{RPS}sourceProduct"), RDF.type, OWL.ObjectProperty) in graph
    # TextArea is a UI widget hint, not a datatype: the range must degrade to xsd:string.
    notes = URIRef(f"{RPS}notes")
    assert (notes, RDFS.range, XSD.string) in graph
    assert (notes, URIRef(f"{RPS}uiWidget"), Literal("textarea")) in graph


def test_inbound_link_emits_a_typed_stub_so_the_import_keeps_the_triple():
    proposal = classgen.normalize_proposal(
        {
            "classes": [{"localName": "Lookup", "label": "Lookup", "comment": "", "properties": []}],
            "instances": [{
                "name": "route code table",
                "classLocalName": "Lookup",
                "links": [{"predicateIri": str(HAS_INPUT), "targetLabel": "normalize_routes", "direction": "in"}],
            }],
        },
        _graph(),
    )
    instance_iri = URIRef(proposal["instances"][0]["iri"])
    stage = URIRef("https://example.org/pipeline/normalize_routes")
    graph = Graph().parse(data=json.dumps(classgen.render_jsonld(proposal)), format="json-ld")

    assert (stage, HAS_INPUT, instance_iri) in graph
    # Without this type, main.extract_pipeline_graph() drops the triple above.
    assert (stage, RDF.type, STAGE_CLASS) in graph
    assert (instance_iri, RDF.type, URIRef(f"{RPS}Lookup")) in graph


def test_links_to_unknown_predicates_or_unknown_targets_are_dropped():
    proposal = classgen.normalize_proposal(
        {
            "classes": [{"localName": "Lookup", "label": "Lookup", "comment": "", "properties": []}],
            "instances": [{
                "name": "route code table",
                "classLocalName": "Lookup",
                "links": [
                    {"predicateIri": f"{RPS}inventedProperty", "targetLabel": "normalize_routes", "direction": "out"},
                    {"predicateIri": str(HAS_INPUT), "targetLabel": "no such node", "direction": "out"},
                ],
            }],
        },
        _graph(),
    )
    assert proposal["instances"][0]["links"] == []
    assert len([w for w in proposal["warnings"] if "Dropped a link" in w]) == 2


def test_target_label_matching_tolerates_case_and_punctuation_differences():
    proposal = classgen.normalize_proposal(
        {
            "classes": [{"localName": "Lookup", "label": "Lookup", "comment": "", "properties": []}],
            "instances": [{
                "name": "table",
                "classLocalName": "Lookup",
                "links": [{"predicateIri": str(HAS_INPUT), "targetLabel": "Normalize-Routes", "direction": "in"}],
            }],
        },
        _graph(),
    )
    assert proposal["instances"][0]["links"][0]["targetIri"] == "https://example.org/pipeline/normalize_routes"


def test_nothing_is_proposed_when_the_model_returns_no_class():
    proposal = classgen.normalize_proposal({"classes": [], "instances": []}, _graph())
    assert proposal["classes"] == [] and proposal["reuse"] is None
    assert proposal["warnings"]


def _lookup_with_inbound_link():
    return classgen.normalize_proposal(
        {
            "classes": [{
                "localName": "Lookup", "label": "Lookup", "comment": "",
                "properties": [{"localName": "lookupKey", "rangeIri": str(XSD.string)}],
            }],
            "instances": [{
                "name": "route code table",
                "classLocalName": "Lookup",
                "links": [{"predicateIri": str(HAS_INPUT), "targetLabel": "normalize_routes", "direction": "in"}],
            }],
        },
        _graph(),
    )


def test_split_nodes_separates_definitions_from_instances_and_stubs():
    schema, instances = classgen.split_nodes(classgen.render_jsonld(_lookup_with_inbound_link()))
    assert sorted(node["@id"] for node in schema) == [f"{RPS}Lookup", f"{RPS}lookupKey"]
    # The instance and the typed stub of its link target both belong to the pipeline doc.
    assert {node["@id"] for node in instances} == {
        "https://bmtc.datakaveri.org/freqrec/ai/route_code_table",
        "https://example.org/pipeline/normalize_routes",
    }


# --- Regressions from a live run against the BMTC pipeline with a 20B model ---------
# The model returned, across three attempts: a class with a label but no localName; a
# reuse of rps:Table for "GTFS Service Calendar"; and no class at all. Each produced a
# different confusing outcome for the same prompt.


def test_local_name_is_derived_from_the_label_when_the_model_omits_it():
    """Symptom: “Skipped a class with an unusable name: “(empty)”.” The model gave a
    perfectly good label and simply never filled localName."""
    proposal = classgen.normalize_proposal(
        {"classes": [{"label": "GTFS Service Calendar", "comment": "Day-type each trip runs on.", "properties": []}]},
        _graph(),
    )
    assert not any("name" in warning for warning in proposal["warnings"])
    assert proposal["classes"][0]["localName"] == "GTFSServiceCalendar"
    assert proposal["classes"][0]["label"] == "GTFS Service Calendar"


def test_property_local_name_is_derived_and_lower_camel_cased():
    proposal = classgen.normalize_proposal(
        {"classes": [{"label": "Service Calendar", "properties": [{"label": "Service ID", "rangeIri": str(XSD.string)}]}]},
        _graph(),
    )
    assert proposal["classes"][0]["properties"][0]["localName"] == "serviceID"


def test_a_data_structure_class_is_never_accepted_as_a_reuse():
    """Symptom: “Reusing Table — the table class already represents any tabular data
    product.” rps:Table describes a value's shape, not a domain concept."""
    proposal = classgen.normalize_proposal(
        {
            "reuseExistingClassIri": str(TABLE),
            "reuseRationale": "A service calendar is a tabular mapping.",
            "classes": [{"label": "GTFS Service Calendar", "properties": []}],
        },
        _graph(),
    )
    assert proposal["reuse"] is None
    assert proposal["classes"][0]["localName"] == "GTFSServiceCalendar"
    assert any("data structure" in warning for warning in proposal["warnings"])


def test_a_data_structure_class_is_never_accepted_as_a_parent():
    proposal = classgen.normalize_proposal(
        {"classes": [{"label": "Service Calendar", "parentClassIri": str(TABLE), "properties": []}]},
        _graph(),
    )
    assert proposal["classes"][0]["parentClassIri"] == ""
    assert any("data structure" in warning for warning in proposal["warnings"])


def test_model_proposed_reuse_needs_lexical_evidence_for_the_concept():
    """Nothing validated the model's reuse claim, so its word was final. A reuse produces
    zero triples and no editable card, so it must denote the same concept."""
    proposal = classgen.normalize_proposal(
        {"reuseExistingClassIri": str(PRODUCT), "classes": [{"label": "GTFS Service Calendar", "properties": []}]},
        _graph(),
    )
    assert proposal["reuse"] is None
    assert any("does not denote" in warning for warning in proposal["warnings"])


def test_a_genuine_synonym_reuse_is_still_honoured():
    proposal = classgen.normalize_proposal(
        {"reuseExistingClassIri": str(PRODUCT), "classes": [{"label": "Data Product", "properties": []}]},
        _graph(),
    )
    assert proposal["reuse"]["classIri"] == str(PRODUCT)
    assert proposal["classes"] == []


def test_instance_binds_to_the_sole_class_when_the_model_names_it_in_prose():
    """The model writes classLocalName: "GTFS Service Calendar" while we mint
    GTFSServiceCalendar - the instance must not be dropped over that mismatch."""
    proposal = classgen.normalize_proposal(
        {
            "classes": [{"label": "GTFS Service Calendar", "properties": []}],
            "instances": [{
                "name": "service calendar table",
                "classLocalName": "GTFS Service Calendar",
                "links": [{"predicateIri": str(HAS_INPUT), "targetLabel": "normalize_routes", "direction": "in"}],
            }],
        },
        _graph(),
    )
    assert proposal["instances"][0]["classIri"] == f"{RPS}GTFSServiceCalendar"
    assert proposal["instances"][0]["links"][0]["targetIri"] == "https://example.org/pipeline/normalize_routes"


def test_a_class_with_no_proposed_instance_still_gets_a_node():
    """Regression: the tool schema tells the model to emit an instance only when the request
    implies a concrete node, so it usually returns instances: []. That left instanceJsonld
    empty, the pipeline import skipped, and nothing on the Playground canvas - the feature
    looked like it had done nothing."""
    proposal = classgen.normalize_proposal(
        {"classes": [{"label": "GTFS Service Calendar", "properties": []}], "instances": []},
        _graph(),
    )
    instance = proposal["instances"][0]
    assert instance["name"] == "GTFS Service Calendar"
    assert instance["classIri"] == f"{RPS}GTFSServiceCalendar"
    assert instance["links"] == []
    _, instance_nodes = classgen.split_nodes(classgen.render_jsonld(proposal))
    assert instance_nodes and instance_nodes[0]["@id"] == instance["iri"]


def _graph_with_stage_using_has_input() -> Graph:
    """normalize_routes already has an input, so it is a legitimate SUBJECT of rps:hasInput."""
    graph = _graph()
    stage = URIRef("https://example.org/pipeline/normalize_routes")
    feed = URIRef("https://example.org/pipeline/raw_feed")
    graph.add((feed, RDF.type, PRODUCT))
    graph.add((feed, RDFS.label, Literal("Raw Feed")))
    graph.add((stage, HAS_INPUT, feed))
    return graph


def test_the_link_named_in_the_instruction_is_recovered_when_the_model_omits_it():
    """Regression: the agent answered "it will be added as an input to
    build_gtfs_route_schedule", the model returned instances: [], and the synthesized node
    was created with no links at all - invisible on the canvas, promise silently broken."""
    proposal = classgen.normalize_proposal(
        {"classes": [{"label": "GTFS Service Calendar", "properties": []}], "instances": []},
        _graph_with_stage_using_has_input(),
        "Add a dimension class for the service calendar. It should be an input to the normalize_routes stage.",
    )
    link = proposal["instances"][0]["links"][0]
    assert link["predicateIri"] == str(HAS_INPUT)
    assert link["targetIri"] == "https://example.org/pipeline/normalize_routes"
    # normalize_routes already uses hasInput as a subject, so it is the subject here too.
    assert link["direction"] == "in"
    assert proposal["warnings"] == []


def test_no_link_is_invented_when_the_instruction_names_no_stage():
    proposal = classgen.normalize_proposal(
        {"classes": [{"label": "Lookup", "properties": []}], "instances": []},
        _graph_with_stage_using_has_input(),
        "Add a lookup table class for route codes.",
    )
    assert proposal["instances"][0]["links"] == []
    assert any("not linked to anything" in warning for warning in proposal["warnings"])


def test_no_link_is_invented_when_the_instruction_names_no_relationship():
    proposal = classgen.normalize_proposal(
        {"classes": [{"label": "Lookup", "properties": []}], "instances": []},
        _graph_with_stage_using_has_input(),
        "Add a lookup class related somehow to normalize_routes.",
    )
    assert proposal["instances"][0]["links"] == []


def test_an_explicitly_proposed_instance_is_never_overridden_by_inference():
    proposal = classgen.normalize_proposal(
        {"classes": [{"label": "Lookup", "properties": []}],
         "instances": [{"name": "my table", "classLocalName": "Lookup", "links": []}]},
        _graph_with_stage_using_has_input(),
        "Add a lookup class as an input to normalize_routes.",
    )
    assert proposal["instances"][0]["name"] == "my table"
    assert proposal["instances"][0]["links"] == []


def test_renaming_an_instance_renames_its_iri():
    proposal = classgen.normalize_proposal(
        {"classes": [{"label": "Lookup", "properties": []}],
         "instances": [{"iri": "https://stale/old", "name": "route code table", "classLocalName": "Lookup", "links": []}]},
        _graph(),
    )
    assert proposal["instances"][0]["iri"].endswith("/route_code_table")


def test_links_resolve_by_target_iri_as_the_review_card_sends_them():
    proposal = classgen.normalize_proposal(
        {"classes": [{"label": "Lookup", "properties": []}],
         "instances": [{"name": "t", "classLocalName": "Lookup",
                        "links": [{"predicateIri": str(HAS_INPUT), "targetIri": "https://example.org/pipeline/normalize_routes", "direction": "in"}]}]},
        _graph(),
    )
    assert proposal["instances"][0]["links"][0]["targetLabel"] == "normalize_routes"


def test_an_unfilled_link_row_is_ignored_rather_than_warned_about():
    proposal = classgen.normalize_proposal(
        {"classes": [{"label": "Lookup", "properties": []}],
         "instances": [{"name": "t", "classLocalName": "Lookup", "links": [{"predicateIri": "", "targetIri": "", "direction": "out"}]}]},
        _graph(),
    )
    assert proposal["instances"][0]["links"] == []
    assert not any("Dropped a link" in warning for warning in proposal["warnings"])


def test_link_options_offer_only_object_properties_and_real_targets():
    """A datatype property (canvasX, formula, required) as a link predicate would emit a
    triple whose object is an IRI where a literal belongs."""
    graph = _graph()
    tier = URIRef(f"{RPS}tier")
    graph.add((tier, RDF.type, OWL.DatatypeProperty))
    graph.add((tier, RDFS.label, Literal("data tier")))

    options = classgen._link_options(graph)
    assert {p["iri"] for p in options["predicates"]} == {str(HAS_INPUT)}
    assert [t["label"] for t in options["targets"]] == ["normalize_routes"]


def test_a_datatype_property_is_rejected_as_a_link_predicate():
    graph = _graph()
    tier = URIRef(f"{RPS}tier")
    graph.add((tier, RDF.type, OWL.DatatypeProperty))
    graph.add((tier, RDFS.label, Literal("data tier")))

    proposal = classgen.normalize_proposal(
        {"classes": [{"label": "Lookup", "properties": []}],
         "instances": [{"name": "t", "classLocalName": "Lookup",
                        "links": [{"predicateIri": str(tier), "targetLabel": "normalize_routes", "direction": "out"}]}]},
        graph,
    )
    assert proposal["instances"][0]["links"] == []
    assert any("not a defined property" in warning for warning in proposal["warnings"])


def test_schema_document_carries_no_instance_so_the_ontology_import_infers_nothing():
    """The typed link-target stub is what lets an inbound triple survive the pipeline
    import, but it must never reach /api/import/ontology: that endpoint runs
    infer_ontology_from_instances() over any instance it finds, which would re-label
    rps:analyticalProcess and give the shared rps:hasInput an rdfs:domain/rdfs:range
    narrowed to the new class. Keeping the two documents apart is what prevents that.
    """
    from app.main import extract_ontology_graph

    schema, _ = classgen.split_nodes(classgen.render_jsonld(_lookup_with_inbound_link()))
    ontology_graph, _classes, _properties, instance_subjects = extract_ontology_graph(
        Graph().parse(data=json.dumps(schema), format="json-ld")
    )
    assert not instance_subjects
    touched = {str(subject) for subject, _, _ in ontology_graph}
    assert touched == {f"{RPS}Lookup", f"{RPS}lookupKey"}
    assert str(HAS_INPUT) not in touched and str(STAGE_CLASS) not in touched
