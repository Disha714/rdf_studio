import pytest
from app.ai import client


@pytest.fixture(autouse=True)
def _clear_llm_env(monkeypatch):
    monkeypatch.setattr(client, "LLM_MODEL", "")
    monkeypatch.setattr(client, "LLM_BASE_URL", "")


def test_anthropic_used_when_configured(monkeypatch):
    monkeypatch.setattr(client, "ANTHROPIC_API_KEY", "sk-ant-fake")
    monkeypatch.setattr(client, "OPENAI_API_KEY", "")
    monkeypatch.setattr(client, "OLLAMA_MODEL", "")
    assert client.active_provider() == {"provider": "anthropic", "model": client.ANTHROPIC_MODEL}


def test_openai_used_when_anthropic_missing(monkeypatch):
    monkeypatch.setattr(client, "ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(client, "OPENAI_API_KEY", "sk-oa-fake")
    monkeypatch.setattr(client, "OLLAMA_MODEL", "")
    assert client.active_provider() == {"provider": "openai", "model": client.OPENAI_MODEL}


def test_ollama_used_when_no_keys_present(monkeypatch):
    monkeypatch.setattr(client, "ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(client, "OPENAI_API_KEY", "")
    monkeypatch.setattr(client, "OLLAMA_MODEL", "llama3.1")
    assert client.active_provider() == {"provider": "ollama", "model": "llama3.1"}


def test_anthropic_wins_over_openai_when_both_configured(monkeypatch):
    monkeypatch.setattr(client, "ANTHROPIC_API_KEY", "sk-ant-fake")
    monkeypatch.setattr(client, "OPENAI_API_KEY", "sk-oa-fake")
    monkeypatch.setattr(client, "OLLAMA_MODEL", "llama3.1")
    assert client.active_provider()["provider"] == "anthropic"


def test_openai_wins_over_ollama_when_both_configured(monkeypatch):
    monkeypatch.setattr(client, "ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(client, "OPENAI_API_KEY", "sk-oa-fake")
    monkeypatch.setattr(client, "OLLAMA_MODEL", "llama3.1")
    assert client.active_provider()["provider"] == "openai"


def test_no_provider_configured(monkeypatch):
    monkeypatch.setattr(client, "ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(client, "OPENAI_API_KEY", "")
    monkeypatch.setattr(client, "OLLAMA_MODEL", "")
    assert client.active_provider() == {"provider": None, "model": None}


def test_provider_override_uses_selected_model(monkeypatch):
    monkeypatch.setattr(client, "ANTHROPIC_API_KEY", "sk-ant-fake")
    monkeypatch.setattr(client, "OPENAI_API_KEY", "sk-oa-fake")
    monkeypatch.setattr(client, "OLLAMA_MODEL", "")
    assert client.active_provider("openai", "gpt-4.1-mini") == {"provider": "openai", "model": "gpt-4.1-mini"}


def test_model_code_override_wins_over_selected_model(monkeypatch):
    monkeypatch.setattr(client, "OPENAI_API_KEY", "sk-oa-fake")
    assert client.active_provider("openai", "gpt-4o", "gpt-custom") == {"provider": "openai", "model": "gpt-custom"}


def test_provider_override_requires_credentials(monkeypatch):
    monkeypatch.setattr(client, "OPENAI_API_KEY", "")
    try:
        client.active_provider("openai", "gpt-4.1")
        assert False, "expected an HTTPException"
    except Exception as exc:
        assert "OPENAI_API_KEY" in str(exc)


def test_call_structured_raises_clear_error_when_unconfigured(monkeypatch):
    monkeypatch.setattr(client, "ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(client, "OPENAI_API_KEY", "")
    monkeypatch.setattr(client, "OLLAMA_MODEL", "")
    try:
        client.call_structured("system", "user", "tool", "desc", {"type": "object", "properties": {}})
        assert False, "expected an HTTPException"
    except Exception as exc:
        assert "No LLM is configured" in str(exc)
