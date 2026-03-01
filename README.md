# Arthur Bot — AI Operations Assistant

An AI-powered internal operations assistant for Art Battle, deployed as a Slack bot. Employees ask questions in natural language and the bot routes through OpenAI with access to 67 tools across 8 operational domains. Built and deployed in ~26 hours.

## What It Does

Employees interact with Arthur Bot through 5 Slack interaction modes — channel @mentions, `/ab` slash commands, direct messages, group DMs, and a dedicated Assistant panel with split-pane UI. The bot understands natural language, selects the right tools, chains multiple API calls when needed, and responds with formatted Slack messages.

### Tool Domains (67 tools)

| Domain | Tools | Description |
|--------|-------|-------------|
| Data Read | 15 | Event lookups, auction stats, bid history, contestant details, artwork info, venue data |
| Profile Integrity | 10 | Artist profiles, name changes, invitations, duplicate detection (4 write-gated) |
| Payments | 9 | Artist payment balances, transaction history, payout calculations (2 write-gated) |
| Growth Marketing | 7 | Registration analytics, audience segmentation, campaign data |
| Platform Ops | 7 | Bot introspection, bug reports, error diagnostics, system health |
| Eventbrite Charts | 10 | Ticket sales pace charts with comparator events, scheduled autopost to channels |
| Memory | 4 | Per-channel and per-tool contextual memory with versioning and rollback |
| Slack Knowledge | 2 | Semantic search over historical Slack conversations via RAG |

### Interaction Modes

| Mode | How | Description |
|------|-----|-------------|
| Channel @mention | `@Arthur Bot ...` | Responds in a thread, visible to channel |
| Slash command | `/ab ...` | Private ephemeral response |
| Direct message | Open DM with bot | Private conversation, inline replies |
| Group DM | Add bot to group DM | Multi-person private conversation |
| Assistant panel | Click bot icon in Slack top bar | Split-pane UI with suggested prompts and per-tool loading states |
| Reaction feedback | React with emoji on bot message | Passive quality tracking (thumbsup/thumbsdown/bug) |

## Architecture

```
Slack (Socket Mode)
  |
  v
Slackbot (Node.js, @slack/bolt)
  |-- OpenAI (gpt-4o, multi-round tool chaining, up to 5 rounds)
  |-- Assistant framework (split-pane UI, suggested prompts, loading states)
  |
  v
MCP Gateway (Node.js, Express)
  |-- Supabase Postgres (direct SQL for reads)
  |-- Supabase Edge Functions (HTTP for writes)
  |-- rag-query (Python, FastAPI)
        |-- Qdrant (embedded vector DB, 4096-dim cosine similarity)
        |-- Ollama sidecar (qwen3-embedding, pod-internal only)
```

### Services

| Service | Image | Built From | Port |
|---------|-------|-----------|------|
| Slackbot | `orchestration-api` | `services/slackbot/Dockerfile` | 3000 |
| MCP Gateway | `orchestration-supervisor` | `services/mcp-gateway/Dockerfile` | 8081 |
| RAG Query | `rag-query` | `services/rag-query/Dockerfile` | 8082 |
| Ollama Sidecar | `ollama-qwen3` | `services/rag-query/Dockerfile.ollama` | 11434 (pod-internal) |

**Important naming:** The deployment names don't match what they run:
- `orchestration-api` = **Slackbot**
- `orchestration-supervisor` = **MCP Gateway**

## Security

| Layer | Implementation |
|-------|---------------|
| Authentication | HMAC request signing (slackbot to gateway) |
| Authorization | RBAC with static role map + per-channel open-viewer fallback |
| Rate limiting | Per-user and per-channel fixed windows |
| Write protection | Interactive Confirm/Cancel buttons for medium/high risk tools |
| Network isolation | K8s NetworkPolicies: default-deny-all, explicit whitelists per service |
| Ollama lockdown | No containerPort, no Service, no ingress — localhost only |
| Data at rest | RAG index encrypted with AES-256-CBC, decrypted to ephemeral volumes |
| PII redaction | `mask_phone` + `mask_email` rules on search results |
| Row-level security | All observability tables RLS-enabled, service_role only |
| Audit trail | Every request, tool call, policy decision, and error logged to Postgres |

## Observability

All interactions are logged to `esbmcp_` prefixed tables in Supabase Postgres:

| Table | Purpose |
|-------|---------|
| `esbmcp_chat_sessions` | Full AI conversation per interaction (prompt, response, tools, tokens, timing) |
| `esbmcp_tool_executions` | Per-tool call with timing, arguments hash, result metadata |
| `esbmcp_audit_log` | Every policy decision (identity, role, rate limit, confirmation) |
| `esbmcp_tool_errors` | Detailed errors with resolution tracking |
| `esbmcp_reaction_feedback` | Implicit quality signals from emoji reactions |
| `esbmcp_bug_reports` | Bug reports filed via the bot |
| `esbmcp_scheduled_chart_jobs` | Chart autopost schedules with cadence config |
| `esbmcp_chart_posts_log` | Chart render log with idempotency |

Pre-built views for daily volume, user activity, tool usage, error digests, and unresolved errors.

### Feedback-Driven Development

Emoji reactions and bug reports create a continuous improvement loop:

1. **Reactions** — employees react to bot responses with emoji. The bot classifies sentiment (positive/negative/bug/neutral from ~70 emoji), reacts back to acknowledge, and logs to `esbmcp_reaction_feedback`.
2. **Bug reports** — employees tell the bot to file a bug (`@Arthur Bot file a bug report about...`). Logged to `esbmcp_bug_reports` with priority and status tracking.
3. **Investigation** — query sessions, tool executions, and errors around the flagged interaction to classify the root cause (tool bug, AI routing error, data gap, etc.).
4. **Fix** — apply the fix (SQL query, tool description, system prompt) and redeploy.

See [docs/runbook.md § 12](docs/runbook.md) for the full investigation workflow and common fix patterns.

## Infrastructure

| Component | Provider | Details |
|-----------|----------|---------|
| Kubernetes | DigitalOcean | `esbmcp` cluster in `tor1` (Toronto) |
| Container Registry | DigitalOcean | Basic plan ($5/mo), 4 of 5 repo slots used |
| Object Storage | DO Spaces | Private bucket for encrypted RAG artifacts |
| Database | Supabase | Postgres with Edge Functions |
| AI | OpenAI | gpt-4o for tool routing, gpt-4o-mini for memory updates |
| Embeddings | Ollama | qwen3-embedding (4096-dim), self-hosted sidecar |
| Vector DB | Qdrant | Embedded mode, on-disk storage |
| Messaging | Slack | Socket Mode, 18 bot token scopes |

### Secrets

All secrets are in `orchestration-secrets` (Opaque), injected via `envFrom`:

| Key | Purpose |
|-----|---------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (xoxb-) |
| `SLACK_APP_TOKEN` | Socket Mode App-Level Token (xapp-) |
| `SLACK_SIGNING_SECRET` | Request signature verification |
| `OPENAI_API_KEY` | OpenAI API access |
| `MCP_GATEWAY_AUTH_TOKEN` | Bearer token: slackbot to gateway |
| `MCP_REQUEST_SIGNING_SECRET` | HMAC signing: slackbot to gateway |
| `SUPABASE_DB_URL` | Postgres connection string |
| `SUPABASE_URL` | Edge Function base URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Function auth |

RAG-specific secrets in `rag-query-secrets`: DO Spaces credentials + artifact encryption key.

## Repository Structure

```
services/
  slackbot/              Slack ingress, OpenAI routing, session logging
    src/
      index.js           Event handlers (app_mention, message, reaction_added)
      assistant.js        Slack Assistant framework handler
      openai_router.js   Multi-round tool chaining with status callbacks
      session_writer.js  Fire-and-forget Postgres logging
      slack_format.js    Markdown to Slack mrkdwn post-processor
      policy.js          RBAC, rate limiting, redaction, tool index
      config.js          Environment-driven configuration
      mcp_client.js      Gateway HTTP client with HMAC signing

  mcp-gateway/           Tool execution, RBAC enforcement, audit logging
    src/
      tools/             8 domain modules (67 tools)
      index.js           Express server, tool dispatch, audit writer
      chart_scheduler.js Scheduled chart autopost (60s poll)
      slack_poster.js    Minimal Slack Web API client for chart posting

  rag-query/             Semantic search over Slack archive
    src/
      main.py            FastAPI app (/healthz, /readyz, /query, /stats)
      query_engine.py    Qdrant + Ollama semantic search with hybrid re-ranking
      artifact_loader.py Download, decrypt, extract RAG index from DO Spaces

packages/shared/         Constants, HMAC signing, shared utilities
config/allowed-tools.json  Tool manifest (67 tools with descriptions, schemas, RBAC)
deploy/k8s/base/         Kubernetes manifests (deployments, services, network policies)
scripts/rag-artifacts/   Artifact packaging, encryption, upload pipeline
sql/                     Database migrations (001 through 005)
docs/                    Runbook, Slack app setup, RAG service docs, diagnostics
plans/                   Implementation plans
```

## Quick Start

### Deploy

```bash
# Build (from repo root — Apple Silicon requires --platform flag)
docker build --platform linux/amd64 --no-cache \
  -t registry.digitalocean.com/esbmcp/orchestration-api:latest \
  -f services/slackbot/Dockerfile .
docker push registry.digitalocean.com/esbmcp/orchestration-api:latest

# Roll out
kubectl rollout restart deployment/orchestration-api -n artbattle-orchestration
kubectl rollout status deployment/orchestration-api -n artbattle-orchestration --timeout=90s
```

### Verify

```bash
kubectl logs deployment/orchestration-api -n artbattle-orchestration --tail=5
# Should show: slackbot_started, socket_mode: true, allowed_tools_count: 67
```

### Development

```bash
npm install
npm run dev:slackbot        # start slackbot with --watch
npm run dev:mcp-gateway     # start gateway with --watch
npm run check               # syntax check all files
npm test                    # run test suite
```

## Project Stats

- **27 commits** across ~26 hours of development
- **93 tracked files**, ~15,700 lines of code
- **67 tools** across 8 operational domains
- **5 interaction modes** (channel, slash, DM, group DM, assistant)
- **3 services** + 1 sidecar, deployed on Kubernetes
- **Full observability**: 8 tables, pre-built views, error tracking with resolution workflow

## Documentation

| Document | Description |
|----------|-------------|
| [docs/runbook.md](docs/runbook.md) | Operations runbook: deploy, health checks, secrets, troubleshooting |
| [docs/slack-app-setup.md](docs/slack-app-setup.md) | Complete Slack app configuration (scopes, events, App Home) |
| [docs/rag-query-service.md](docs/rag-query-service.md) | RAG query service: architecture, build, deploy, security |
| [docs/eventbrite-data-architecture.md](docs/eventbrite-data-architecture.md) | Eventbrite data pipeline and chart generation |
| [docs/diagnose.md](docs/diagnose.md) | Diagnostic queries and error investigation |
| [plans/slack-scopes-activation-plan.md](plans/slack-scopes-activation-plan.md) | Slack scope activation plan (Tiers 1-4) |
