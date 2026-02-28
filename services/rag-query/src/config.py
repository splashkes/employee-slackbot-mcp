"""Environment-driven configuration for rag-query service."""

import os
from pathlib import Path


RAG_INDEX_DIR = Path(os.getenv("RAG_INDEX_DIR", "/data/rag-index"))

# Qdrant (local embedded mode — reads from disk)
QDRANT_PATH = RAG_INDEX_DIR / "qdrant"
STATE_DB_PATH = RAG_INDEX_DIR / "state.db"
COLLECTION_NAME = "slack_messages"

# Embedding model (Ollama sidecar)
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
EMBEDDING_MODEL = os.getenv("SLACK_LIBRARIAN_EMBED_MODEL", "qwen3-embedding")
EMBEDDING_DIM = int(os.getenv("SLACK_LIBRARIAN_EMBED_DIM", "4096"))
MAX_EMBED_CHARS = int(os.getenv("SLACK_LIBRARIAN_MAX_EMBED_CHARS", "16000"))

# DO Spaces (artifact download)
DO_SPACES_ENDPOINT = os.getenv("DO_SPACES_ENDPOINT", "https://tor1.digitaloceanspaces.com")
DO_SPACES_BUCKET = os.getenv("DO_SPACES_BUCKET", "esbmcp-rag-artifacts")
DO_SPACES_ACCESS_KEY = os.getenv("DO_SPACES_ACCESS_KEY", "")
DO_SPACES_SECRET_KEY = os.getenv("DO_SPACES_SECRET_KEY", "")
DO_SPACES_REGION = os.getenv("DO_SPACES_REGION", "tor1")

# Artifact version (default: latest)
RAG_ARTIFACT_VERSION = os.getenv("RAG_ARTIFACT_VERSION", "latest")
RAG_ARTIFACT_ENCRYPTION_KEY = os.getenv("RAG_ARTIFACT_ENCRYPTION_KEY", "")

# Service
SERVICE_PORT = int(os.getenv("PORT", "8082"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "info")
