# Art Battle Employee Slackbot

An internal Slack assistant that lets Art Battle employees query operational data in natural language. Employees describe their problem — the AI selects the right tools automatically.

## Architecture

```
Slack ──▸ Slackbot (orchestration-api, :3000)
              │
              ├─▸ OpenAI (gpt-4o-mini) — tool selection + response
              │
              └─▸ MCP Gateway (orchestration-supervisor, :8081)
                       │
                       ├─▸ Supabase Postgres (direct SQL via postgres.js)
                       └─▸ Supabase Edge Functions (mutations only)
```

- **Slackbot** (`services/slackbot/`) — Slack ingress, OpenAI routing, thread context, session logging
- **MCP Gateway** (`services/mcp-gateway/`) — 48 tools across 5 domains, direct Supabase SQL
- **Observability** — `esbmcp_` tables for sessions, tool executions, audit, errors, feedback, bug reports

## Tool Coverage

48 tools covering 80%+ of 50 operational skill areas:

| Domain | Tools | Examples |
|--------|-------|---------|
| data-read | 15 | Event lookup, vote data, auction revenue, Eventbrite |
| profile-integrity | 10 | Duplicate detection, artist updates, invitations |
| payments | 9 | Stripe status, payment ledger, artists owed (production formula) |
| growth-marketing | 7 | Meta ads, SMS campaigns, offers, sponsorships |
| platform-ops | 7 | Email/Slack queue health, live diagnostics, bot introspection, bug reports |

## Key Features

- **Thread-aware** — replies thread under the user's message; follow-up questions in a thread carry full context
- **RBAC** — static user role map + open viewer channels for read-only access
- **Interactive confirmation** — Slack buttons for non-low-risk operations
- **Typing indicator** — hourglass reaction while processing
- **Slack mrkdwn formatting** — system prompt + post-processor ensure proper Slack rendering
- **Timezone awareness** — UTC times converted to event's local timezone
- **Token tracking** — OpenAI token usage and estimated cost per session
- **Bug reports** — employees can file bugs via the bot
- **UUID validation** — prevents SQL crashes from hallucinated IDs

## Infrastructure

### DigitalOcean Setup

- **Kubernetes cluster:** `esbmcp` in `tor1` (Toronto)
- **Container registry:** `registry.digitalocean.com/esbmcp/` (2-repo limit on free tier)
- **Namespace:** `artbattle-orchestration`
- **Image naming (important):**
  - `orchestration-api` image = **Slackbot** (built from `services/slackbot/Dockerfile`)
  - `orchestration-supervisor` image = **MCP Gateway** (built from `services/mcp-gateway/Dockerfile`)

### Quick Reference Commands

```bash
# --- doctl / registry ---
doctl auth init                              # authenticate (one-time)
doctl registry login                         # login to container registry
doctl kubernetes cluster kubeconfig save esbmcp  # configure kubectl (one-time)
doctl registry repo list-v2                  # list images in registry
doctl registry garbage-collection start --force  # clean up old image layers

# --- Build & push (from repo root, on Apple Silicon) ---
# Slackbot:
docker build --platform linux/amd64 --no-cache \
  -t registry.digitalocean.com/esbmcp/orchestration-api:latest \
  -f services/slackbot/Dockerfile .
docker push registry.digitalocean.com/esbmcp/orchestration-api:latest

# MCP Gateway:
docker build --platform linux/amd64 --no-cache \
  -t registry.digitalocean.com/esbmcp/orchestration-supervisor:latest \
  -f services/mcp-gateway/Dockerfile .
docker push registry.digitalocean.com/esbmcp/orchestration-supervisor:latest

# --- Deploy ---
kubectl rollout restart deployment/orchestration-api deployment/orchestration-supervisor \
  -n artbattle-orchestration
kubectl rollout status deployment/orchestration-api deployment/orchestration-supervisor \
  -n artbattle-orchestration --timeout=90s

# --- Logs ---
kubectl logs deployment/orchestration-api -n artbattle-orchestration --tail=50        # slackbot
kubectl logs deployment/orchestration-supervisor -n artbattle-orchestration --tail=50  # gateway

# --- Check status ---
kubectl get pods -n artbattle-orchestration
kubectl get deployments -n artbattle-orchestration
```

### Secrets

All secrets are in `orchestration-secrets` (Opaque), injected via `envFrom` to both deployments:

| Key | Used By | Purpose |
|-----|---------|---------|
| `SLACK_BOT_TOKEN` | slackbot | Bot User OAuth Token (xoxb-) |
| `SLACK_APP_TOKEN` | slackbot | App-Level Token for Socket Mode (xapp-) |
| `SLACK_SIGNING_SECRET` | slackbot | Request signature verification |
| `SLACK_APP_CLIENT_SECRET` | slackbot | OAuth client secret |
| `OPENAI_API_KEY` | slackbot | OpenAI API access |
| `MCP_GATEWAY_AUTH_TOKEN` | both | Bearer token for gateway auth |
| `MCP_REQUEST_SIGNING_SECRET` | both | HMAC request signing |
| `SUPABASE_DB_URL` | both | Postgres connection string (service_role) |
| `SUPABASE_URL` | gateway | Edge Function base URL |
| `SUPABASE_SERVICE_ROLE_KEY` | gateway | Edge Function auth |

Additional env vars set directly on deployments (not secrets):

| Var | Deployment | Value |
|-----|-----------|-------|
| `NODE_ENV` | both | `production` |
| `PORT` | api=`3000`, supervisor=`8081` | Service port |
| `SLACK_USE_SOCKET_MODE` | api | `true` |
| `MCP_GATEWAY_URL` | api | `http://orchestration-supervisor.artbattle-orchestration.svc.cluster.local:8081` |
| `ALLOWED_TOOLS_FILE` | api | `/app/config/allowed-tools.json` |
| `RBAC_MODE` | api | `static` |
| `RBAC_USER_MAP_JSON` | api | `{"U0337E73E":"ops"}` |
| `OPEN_VIEWER_CHANNELS` | api | `C0AHV5ZCJG4` (env or default) |

## Development

```bash
npm install
npm run dev:slackbot        # start slackbot with --watch
npm run dev:mcp-gateway     # start gateway with --watch
npm run check               # syntax check all files
npm test                    # run test suite
```

## Documentation

```
docs/architecture/orchestration-execution-plane.md  # canonical architecture
docs/runbook.md                                      # operations guide
docs/slack-app-setup.md                              # Slack app configuration
docs/bot-handoff/                                    # migration notes from vote-worker
plans/production-readiness.md                        # production checklist
sql/001_create_esbmcp_tables.sql                     # observability schema
sql/002_create_esbmcp_views.sql                      # analytics views
```
