import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
except ImportError:
    pass

FUSEKI_URL = os.getenv("FUSEKI_URL", "http://localhost:3030/pipelines").rstrip("/")
FUSEKI_USER = os.getenv("FUSEKI_USER", "admin")
FUSEKI_PASSWORD = os.getenv("FUSEKI_PASSWORD", "admin")
FUSEKI_READ_TIMEOUT = int(os.getenv("FUSEKI_READ_TIMEOUT", "600"))
cors_env = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:5174")
CORS_ORIGINS = [x.strip() for x in cors_env.split(",") if x.strip()] or ["http://localhost:5173", "http://localhost:5174"]

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5")

# Fallback providers, tried in this order if ANTHROPIC_API_KEY isn't set - see
# app/ai/client.py. OPENAI_API_KEY uses the real OpenAI API; OLLAMA_MODEL points
# at a locally running Ollama instance's OpenAI-compatible endpoint (no key
# needed). Only one provider is used per call - there's no per-request mixing.
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "")

# Self-hosted OpenAI-compatible endpoint (e.g. vLLM/llama.cpp). If LLM_MODEL is
# set it takes precedence in the auto-provider order (see app/ai/client.py), so a
# local server "just works" without any cloud key. LLM_API_KEY can be any
# non-empty string for servers that don't validate it.
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "")
LLM_MODEL = os.getenv("LLM_MODEL", "")
LLM_API_KEY = os.getenv("LLM_API_KEY", "not-needed")
