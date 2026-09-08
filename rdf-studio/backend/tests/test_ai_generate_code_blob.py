from app.ai import generate

RPS = "https://w3id.org/rdf-pipeline-studio#"


def test_render_jsonld_attaches_code_artifact_property():
    process_class = f"{RPS}analyticalProcess"
    available_classes = {process_class}
    nodes = generate._render_jsonld(
        [{
            "label": "generate_route_similarity_pairs",
            "processClass": process_class,
            "comment": "Generate route similarity pairs.",
            "code": "import json\nprint('routes')",
            "language": "python",
            "entrypoint": "main",
            "inputs": [],
            "outputs": [],
        }],
        {},
        available_classes,
    )

    stage = next(node for node in nodes if node["@id"].endswith("/generate_route_similarity_pairs"))
    assert stage[f"{RPS}codeArtifact"] == [{"@value": "import json\nprint('routes')"}]
    assert stage[f"{RPS}codeLanguage"] == [{"@value": "python"}]
    assert stage[f"{RPS}codeEntrypoint"] == [{"@value": "main"}]


def test_render_jsonld_links_inputs_and_outputs():
    process_class = f"{RPS}analyticalProcess"
    available_classes = {process_class}
    nodes = generate._render_jsonld(
        [{
            "label": "compute",
            "processClass": process_class,
            "comment": "Compute the result.",
            "code": "def compute():\n    return 1",
            "inputs": ["InputData"],
            "outputs": ["OutputData"],
        }],
        {},
        available_classes,
    )

    stage = next(node for node in nodes if node["@id"].endswith("/compute"))
    assert stage[f"{RPS}hasInput"] == [{"@id": f"{generate.AI_BASE}/inputdata"}]
    assert stage[f"{RPS}hasOutput"] == [{"@id": f"{generate.AI_BASE}/outputdata"}]

