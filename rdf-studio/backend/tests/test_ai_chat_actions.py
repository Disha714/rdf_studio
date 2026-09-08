from app.ai import chat


def test_create_class_action_survives_normalization():
    actions = chat._normalize([{"kind": "createClass", "instruction": "add a lookup table class"}])
    assert [a["kind"] for a in actions] == ["createClass"]


def test_create_class_is_exclusive_and_suppresses_auto_applying_actions():
    """Regression: "add a class ... as an input to build_gtfs_route_schedule" reads to the
    model as rule 6's two-part input/output change, so it emitted createClass AND
    modifyOntology. modifyOntology applies as soon as the turn completes - it wrote to the
    graph before the user approved the class, and against a graph where the class did not
    exist yet, minting a generic product node instead."""
    actions, dropped = chat._enforce_class_exclusivity([
        {"kind": "createClass", "instruction": "add a dimension class for the service calendar"},
        {"kind": "modifyOntology", "instruction": "add the new dimension as an input", "targetStageId": "s1"},
        {"kind": "editCode", "instruction": "accept the calendar", "iri": "s1"},
    ])
    assert [a["kind"] for a in actions] == ["createClass"]
    assert dropped is True


def test_ordinary_edit_turns_are_untouched():
    original = [
        {"kind": "editCode", "instruction": "change epsilon", "iri": "n1"},
        {"kind": "modifyOntology", "instruction": "update the comment", "targetStageId": "s1"},
    ]
    actions, dropped = chat._enforce_class_exclusivity(original)
    assert actions == original
    assert dropped is False


def test_a_lone_create_class_reports_nothing_dropped():
    actions, dropped = chat._enforce_class_exclusivity([{"kind": "createClass", "instruction": "x"}])
    assert len(actions) == 1 and dropped is False


def test_resolve_actions_leaves_create_class_alone():
    """It targets a class that does not exist yet: there is no IRI to repair, and the
    modifyOntology branch would have tried to invent a targetStageId for it."""
    context = {"code_nodes": [], "stages": [{"iri": "https://x/s1", "label": "normalize_routes"}], "metric_to_stage": {}}
    actions = chat._resolve_actions(
        [{"kind": "createClass", "iri": "", "label": "Lookup", "targetStageId": "", "instruction": "add a lookup class for normalize_routes", "why": ""}],
        context,
    )
    assert actions[0]["targetStageId"] == ""
    assert actions[0]["iri"] == ""
