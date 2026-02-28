# RAG Query Service — Slack Knowledge Search

Last Updated: 2026-02-28
Owner: Platform Engineering

## Overview

The RAG query service (`rag-query`) provides semantic search over historical Slack conversations. It runs as a sidecar deployment in the `artbattle-orchestration` namespace, queried exclusively by the MCP gateway via two tools: `search_slack_knowledge` and `get_slack_knowledge_stats`.

**Architecture:**

```
Slack user → Slackbot → MCP Gateway → rag-query:8082 → Qdrant (embedded) + SQLite
                                            ↓
                                      Ollama sidecar (localhost:11434)
                                      (qwen3-embedding, 4096-dim)
```

The index is built offline by the [slack-archive-mcp](https://github.com/ABCodex/slack-archive-mcp) project, then encrypted and uploaded to a private DO Space. At startup, the rag-query pod downloads, decrypts, and extracts the index into an `emptyDir` volume.

## Components

### 1. RAG Index (Offline, Build Machine)

**Source:** `~/.ab-slack-librarian/` on the build machine (wherever `slack-archive-mcp` runs)

| Artifact | Purpose |
|----------|---------|
| `qdrant/` directory | Qdrant vector database (embedded mode, on-disk storage) |
| `state.db` | SQLite — tracks indexed files, channels, message counts |

**Embedding model:** `qwen3-embedding` (Ollama), 4096 dimensions, cosine similarity.

**Packaging script:** `scripts/rag-artifacts/package-and-upload.sh`

```bash
# Package, encrypt, and upload to DO Spaces
RAG_ARTIFACT_ENCRYPTION_KEY="..." \
DO_SPACES_ENDPOINT="https://tor1.digitaloceanspaces.com" \
DO_SPACES_BUCKET="esbmcp-rag-artifacts" \
  ./scripts/rag-artifacts/package-and-upload.sh
```

What the script does:
1. Tars `qdrant/` + `state.db` into `rag-index-v{YYYYMMDD-HHMMSS}.tar.gz`
2. Generates a manifest JSON with version, sha256, sizes, model info
3. Encrypts with `openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000`
4. Uploads `.tar.gz.enc` + manifest to the private DO Space
5. Updates `latest-manifest.json` pointer
6. Prunes old versions (keeps last 3)

**To rebuild the index:** Run the ingest pipeline in `slack-archive-mcp`, then re-run the packaging script. The rag-query pod picks up the new version on next restart.

### 2. rag-query Python Service

**Location:** `services/rag-query/`

| File | Purpose |
|------|---------|
| `src/main.py` | FastAPI app — `/healthz`, `/readyz`, `/query`, `/stats` |
| `src/config.py` | Env-driven config (all settings via env vars) |
| `src/artifact_loader.py` | Downloads/decrypts/extracts index from DO Spaces at startup |
| `src/query_engine.py` | Query-only fork of `slack_librarian_engine.py` (no ingest code) |
| `src/models.py` | Pydantic request/response schemas |
| `Dockerfile` | Python 3.12-slim, uvicorn on port 8082 |
| `Dockerfile.ollama` | Ollama with pre-baked qwen3-embedding model |

**Startup sequence:**
1. `artifact_loader.load_artifact()` — download, decrypt, extract, verify checksum
2. `query_engine.init_client()` — open persistent Qdrant connection
3. `query_engine.ensure_collection()` — verify collection exists
4. Readiness probe starts returning 200

**Startup time:** ~2-5 minutes depending on artifact size and download speed. The readiness probe has `failureThreshold: 30` with 10s intervals (5 min tolerance).

### 3. Ollama Sidecar

Pre-baked `ollama/ollama` image with `qwen3-embedding` pulled at build time. Runs on localhost:11434 within the pod — **never exposed** to the cluster network.

**Security layers:**
1. No `containerPort` in deployment spec — not advertised on pod network
2. No k8s Service — not discoverable via DNS
3. NetworkPolicy only whitelists TCP 8082 (not 11434)
4. `default-deny-all` blocks everything not explicitly allowed

### 4. MCP Gateway Integration

**Tool module:** `services/mcp-gateway/src/tools/slack_knowledge.js`

| Tool | Method | Timeout | Description |
|------|--------|---------|-------------|
| `search_slack_knowledge` | POST /query | 30s | Semantic search with filters |
| `get_slack_knowledge_stats` | GET /stats | 10s | Index metadata |

**Config:** `services/mcp-gateway/src/config.js` → `rag.query_url` (env: `RAG_QUERY_URL`)

**RBAC:** `search_slack_knowledge` is available to ops, event-producer, finance, marketing. `get_slack_knowledge_stats` is ops-only.

## Infrastructure

### DO Space

| Setting | Value |
|---------|-------|
| Name | `esbmcp-rag-artifacts` |
| Region | `tor1` |
| Visibility | Private |
| Access | Dedicated read-only Spaces key pair |

### Registry Images (4 of 5 Basic plan slots)

| Image | Dockerfile | Purpose |
|-------|-----------|---------|
| `orchestration-api` | `services/slackbot/Dockerfile` | Slackbot |
| `orchestration-supervisor` | `services/mcp-gateway/Dockerfile` | MCP Gateway |
| `rag-query` | `services/rag-query/Dockerfile` | RAG query service |
| `ollama-qwen3` | `services/rag-query/Dockerfile.ollama` | Embedding sidecar |

### K8s Resources

| Resource | File |
|----------|------|
| Deployment + ServiceAccount | `deploy/k8s/base/rag-query-deployment.yaml` |
| Service (port 8082) | `deploy/k8s/base/services.yaml` |
| NetworkPolicy (ingress + egress) | `deploy/k8s/base/networkpolicy.yaml` |
| Secrets | `deploy/k8s/base/secrets.template.yaml` → `rag-query-secrets` |

### Secrets (`rag-query-secrets`)

| Key | Purpose |
|-----|---------|
| `DO_SPACES_ENDPOINT` | `https://tor1.digitaloceanspaces.com` |
| `DO_SPACES_BUCKET` | `esbmcp-rag-artifacts` |
| `DO_SPACES_ACCESS_KEY` | Read-only Spaces access key |
| `DO_SPACES_SECRET_KEY` | Read-only Spaces secret key |
| `RAG_ARTIFACT_ENCRYPTION_KEY` | AES-256-CBC decryption key |

### Resource Requests/Limits

| Container | Memory Request | Memory Limit | CPU Request | CPU Limit |
|-----------|---------------|-------------|-------------|-----------|
| rag-query | 1Gi | 2Gi | 250m | 1 |
| ollama | 3Gi | 4Gi | 500m | 2 |
| **Pod total** | **4Gi** | **6Gi** | **750m** | **3** |

## Build & Deploy

### Build All 3 Images

```bash
# From repo root — MUST use --platform linux/amd64 --no-cache

# RAG query service
docker build --platform linux/amd64 --no-cache \
  -t registry.digitalocean.com/esbmcp/rag-query:latest \
  -f services/rag-query/Dockerfile .

# Ollama sidecar (takes a while — downloads model at build time)
docker build --platform linux/amd64 --no-cache \
  -t registry.digitalocean.com/esbmcp/ollama-qwen3:latest \
  -f services/rag-query/Dockerfile.ollama .

# MCP Gateway (needs rebuild for slack_knowledge tool)
docker build --platform linux/amd64 --no-cache \
  -t registry.digitalocean.com/esbmcp/orchestration-supervisor:latest \
  -f services/mcp-gateway/Dockerfile .

# Push all
docker push registry.digitalocean.com/esbmcp/rag-query:latest
docker push registry.digitalocean.com/esbmcp/ollama-qwen3:latest
docker push registry.digitalocean.com/esbmcp/orchestration-supervisor:latest
```

### First Deploy

```bash
# 1. Create DO Space + read-only keys (manual, via DO console)

# 2. Upload artifact
./scripts/rag-artifacts/package-and-upload.sh

# 3. Create rag-query-secrets (fill in real values)
kubectl apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: rag-query-secrets
  namespace: artbattle-orchestration
type: Opaque
stringData:
  DO_SPACES_ENDPOINT: "https://tor1.digitaloceanspaces.com"
  DO_SPACES_BUCKET: "esbmcp-rag-artifacts"
  DO_SPACES_ACCESS_KEY: "YOUR_KEY"
  DO_SPACES_SECRET_KEY: "YOUR_SECRET"
  RAG_ARTIFACT_ENCRYPTION_KEY: "YOUR_ENCRYPTION_KEY"
EOF

# 4. Apply manifests
kubectl apply -k deploy/k8s/base/

# 5. Restart gateway to pick up RAG_QUERY_URL
kubectl rollout restart deployment orchestration-supervisor -n artbattle-orchestration

# 6. Wait for rag-query readiness (up to 10 min)
kubectl rollout status deployment rag-query -n artbattle-orchestration --timeout=600s

# 7. Verify
kubectl get pods -n artbattle-orchestration
kubectl logs deployment/rag-query -n artbattle-orchestration -c rag-query --tail=10
kubectl logs deployment/rag-query -n artbattle-orchestration -c ollama --tail=5
```

### Subsequent Deploys (index update)

```bash
# 1. Re-run ingest in slack-archive-mcp
# 2. Re-package and upload
./scripts/rag-artifacts/package-and-upload.sh

# 3. Restart to pick up new artifact
kubectl rollout restart deployment rag-query -n artbattle-orchestration
kubectl rollout status deployment rag-query -n artbattle-orchestration --timeout=600s
```

## Health Checks

```bash
# Port-forward
kubectl port-forward svc/rag-query 8082:8082 -n artbattle-orchestration &

# Health
curl -sS http://localhost:8082/healthz

# Readiness (200 = index loaded, 503 = still loading)
curl -sS http://localhost:8082/readyz

# Stats
curl -sS http://localhost:8082/stats | python3 -m json.tool

# Test query
curl -sS -X POST http://localhost:8082/query \
  -H "Content-Type: application/json" \
  -d '{"query": "venue issues in Toronto", "limit": 3}' | python3 -m json.tool
```

## Security Model

| Layer | Protection |
|-------|-----------|
| Artifact at rest (DO Space) | Private bucket + AES-256-CBC client-side encryption |
| Artifact in pod | Decrypted to `emptyDir` (ephemeral, cleared on pod restart) |
| Network access | Only `orchestration-supervisor` can reach `rag-query:8082` |
| Ollama | Pod-internal only (localhost:11434) — no ingress, no Service, no containerPort |
| RBAC | MCP gateway enforces role check before tool execution |
| Audit | All queries logged to `esbmcp_tool_executions` (fire-and-forget) |
| PII | `mask_phone` + `mask_email` redaction rules on `search_slack_knowledge` |

## Verification Checklist

After deploy, verify:

- [ ] `kubectl get pods -n artbattle-orchestration` — rag-query pod shows `2/2 Running`
- [ ] `/readyz` returns 200 (index loaded)
- [ ] `/stats` returns correct channel count and message count
- [ ] `/query` returns relevant results for a known topic
- [ ] In Slack: `@bot what was discussed about [topic]?` returns cited results
- [ ] `esbmcp_tool_executions` shows `search_slack_knowledge` rows after test
- [ ] `kubectl exec deploy/orchestration-api -n artbattle-orchestration -- curl -sS http://rag-query:8082/healthz` returns connection refused (NetworkPolicy blocks it)

## Troubleshooting

### Pod stuck in init / not ready

Check artifact download logs:
```bash
kubectl logs deploy/rag-query -n artbattle-orchestration -c rag-query --tail=30
```

Common causes:
- Wrong Spaces credentials → "403 Forbidden"
- Wrong encryption key → "Decryption failed"
- Checksum mismatch → index was re-uploaded but manifest wasn't updated
- Not enough memory → OOMKilled (check `kubectl describe pod`)

### Ollama not responding

```bash
# Check Ollama logs
kubectl logs deploy/rag-query -n artbattle-orchestration -c ollama --tail=20

# Verify model is loaded (from inside the pod)
kubectl exec deploy/rag-query -n artbattle-orchestration -c ollama -- ollama list
```

### Gateway can't reach rag-query

```bash
# Check the service exists
kubectl get svc rag-query -n artbattle-orchestration

# Check gateway has RAG_QUERY_URL
kubectl exec deploy/orchestration-supervisor -n artbattle-orchestration -- env | grep RAG_QUERY

# Test from gateway pod
kubectl exec deploy/orchestration-supervisor -n artbattle-orchestration -- \
  curl -sS http://rag-query.artbattle-orchestration.svc.cluster.local:8082/healthz
```

## Relationship to slack-archive-mcp

This service is the **query-time consumer** of indexes built by `slack-archive-mcp`. The fork boundary:

| Responsibility | Owner |
|---------------|-------|
| Slack export download + parsing | slack-archive-mcp |
| Embedding generation (ingest) | slack-archive-mcp |
| Qdrant + SQLite index creation | slack-archive-mcp |
| Index packaging + encryption | This repo (`scripts/rag-artifacts/`) |
| Index download + decryption | This repo (`services/rag-query/`) |
| Query-time search + re-ranking | This repo (`services/rag-query/`) |
| MCP tool integration | This repo (`services/mcp-gateway/`) |

The `query_engine.py` file is a **query-only fork** of `slack_librarian_engine.py`. If the original engine's search logic changes (re-ranking weights, embedding model, collection schema), `query_engine.py` must be updated to match. The ingest functions were intentionally removed.
