# Orchestration + Execution Runbook

Last Updated: 2026-03-01
Owner: Platform Engineering

## 1. Services

### Orchestration Plane

| Deployment | Image | Service | Port | Role |
|-----------|-------|---------|------|------|
| `orchestration-api` | `orchestration-api:latest` | Slackbot | 3000 | Slack ingress, OpenAI routing, thread context, session logging |
| `orchestration-supervisor` | `orchestration-supervisor:latest` | MCP Gateway | 8081 | Tool execution, RBAC, audit logging, DB queries |

**Important naming:** The deployment names don't match what they run:
- `orchestration-api` = **Slackbot** (built from `services/slackbot/Dockerfile`)
- `orchestration-supervisor` = **MCP Gateway** (built from `services/mcp-gateway/Dockerfile`)

| `rag-query` | `rag-query:latest` + `ollama-qwen3:latest` | RAG Query | 8082 | Slack knowledge search (semantic), Ollama embedding sidecar |

See [docs/rag-query-service.md](rag-query-service.md) for full RAG service documentation.

### Execution Plane (deferred — replicas: 0)

1. `runner-data-read`
2. `runner-profile-integrity`
3. `runner-payments`
4. `runner-growth-marketing`
5. `runner-platform-db-edge`

All 67 tools are served directly by the MCP gateway. Runners are reserved for future async agent work.

## 2. Infrastructure

### DigitalOcean

- **Cluster:** `esbmcp` in `tor1` (Toronto), Kubernetes 1.34
- **Registry:** `registry.digitalocean.com/esbmcp/` (free tier, 2-repo limit)
- **Namespace:** `artbattle-orchestration`
- **Node pool:** `esbmcp-default-pool`

### Initial Setup (one-time)

```bash
# Install doctl
brew install doctl

# Authenticate
doctl auth init

# Save kubeconfig
doctl kubernetes cluster kubeconfig save esbmcp

# Login to container registry
doctl registry login

# Verify
kubectl get nodes
doctl registry repo list-v2
```

### Registry Management

The registry is on the **Basic plan** ($5/mo, 5-repo limit). Four repos are in use:
- `orchestration-api` — Slackbot image
- `orchestration-supervisor` — MCP Gateway image
- `rag-query` — RAG query service image
- `ollama-qwen3` — Ollama embedding sidecar image

```bash
# List repos and tags
doctl registry repo list-v2

# Clean up old manifests (run periodically to free space)
doctl registry garbage-collection start --force

# Check GC status
doctl registry garbage-collection get-active
```

## 3. Build & Deploy

### Full Deploy (both services)

```bash
# From repo root — MUST use --platform linux/amd64 (Apple Silicon → DO droplets)

# Build
docker build --platform linux/amd64 --no-cache \
  -t registry.digitalocean.com/esbmcp/orchestration-api:latest \
  -f services/slackbot/Dockerfile .

docker build --platform linux/amd64 --no-cache \
  -t registry.digitalocean.com/esbmcp/orchestration-supervisor:latest \
  -f services/mcp-gateway/Dockerfile .

# Push
docker push registry.digitalocean.com/esbmcp/orchestration-api:latest
docker push registry.digitalocean.com/esbmcp/orchestration-supervisor:latest

# Roll out
kubectl rollout restart deployment/orchestration-api deployment/orchestration-supervisor \
  -n artbattle-orchestration

# Wait for completion
kubectl rollout status deployment/orchestration-api deployment/orchestration-supervisor \
  -n artbattle-orchestration --timeout=90s
```

### Deploy Slackbot Only

```bash
docker build --platform linux/amd64 --no-cache \
  -t registry.digitalocean.com/esbmcp/orchestration-api:latest \
  -f services/slackbot/Dockerfile .
docker push registry.digitalocean.com/esbmcp/orchestration-api:latest
kubectl rollout restart deployment/orchestration-api -n artbattle-orchestration
kubectl rollout status deployment/orchestration-api -n artbattle-orchestration --timeout=60s
```

### Deploy Gateway Only

```bash
docker build --platform linux/amd64 --no-cache \
  -t registry.digitalocean.com/esbmcp/orchestration-supervisor:latest \
  -f services/mcp-gateway/Dockerfile .
docker push registry.digitalocean.com/esbmcp/orchestration-supervisor:latest
kubectl rollout restart deployment/orchestration-supervisor -n artbattle-orchestration
kubectl rollout status deployment/orchestration-supervisor -n artbattle-orchestration --timeout=60s
```

### Verify After Deploy

```bash
# Check pods are running
kubectl get pods -n artbattle-orchestration

# Slackbot should log: slackbot_started, socket_mode: true
kubectl logs deployment/orchestration-api -n artbattle-orchestration --tail=5

# Gateway should log: mcp_gateway_started, has_db: true, has_edge: true
kubectl logs deployment/orchestration-supervisor -n artbattle-orchestration --tail=5
```

## 4. Health Checks

```bash
# From local (port-forward first)
kubectl port-forward -n artbattle-orchestration svc/orchestration-api 3000:3000 &
curl -sS http://localhost:3000/healthz
curl -sS http://localhost:3000/readyz   # checks OpenAI key + gateway reachability

kubectl port-forward -n artbattle-orchestration svc/orchestration-supervisor 8081:8081 &
curl -sS http://localhost:8081/healthz
curl -sS http://localhost:8081/readyz
```

## 5. Secrets Management

All secrets live in `orchestration-secrets` (Opaque), injected via `envFrom`:

```bash
# List secret keys
kubectl get secret orchestration-secrets -n artbattle-orchestration \
  -o jsonpath='{.data}' | python3 -c "import sys,json; print('\n'.join(sorted(json.load(sys.stdin).keys())))"

# View a specific secret value
kubectl get secret orchestration-secrets -n artbattle-orchestration \
  -o jsonpath='{.data.OPENAI_API_KEY}' | base64 -d

# Update a secret (edit base64 values)
kubectl edit secret orchestration-secrets -n artbattle-orchestration

# After updating, restart to pick up changes
kubectl rollout restart deployment/orchestration-api deployment/orchestration-supervisor \
  -n artbattle-orchestration
```

| Key | Purpose |
|-----|---------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (xoxb-) |
| `SLACK_APP_TOKEN` | Socket Mode App-Level Token (xapp-) |
| `SLACK_SIGNING_SECRET` | Request signature verification |
| `SLACK_APP_CLIENT_SECRET` | OAuth client secret |
| `OPENAI_API_KEY` | OpenAI API access |
| `MCP_GATEWAY_AUTH_TOKEN` | Bearer token: slackbot → gateway |
| `MCP_REQUEST_SIGNING_SECRET` | HMAC signing: slackbot → gateway |
| `SUPABASE_DB_URL` | Postgres connection string |
| `SUPABASE_URL` | Edge Function base URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Function auth |

## 6. Tool Domains

| Domain | Tools | Module | Notes |
|--------|-------|--------|-------|
| data-read | 15 | `src/tools/data_read.js` | All read-only |
| profile-integrity | 10 | `src/tools/profile_integrity.js` | 4 write-gated |
| payments | 9 | `src/tools/payments.js` | 2 write-gated; uses production balance formula |
| growth-marketing | 7 | `src/tools/growth_marketing.js` | All read-only |
| platform-db-edge | 7 | `src/tools/platform_ops.js` | Includes bot introspection + bug reports |
| eventbrite-charts | 10 | `src/tools/eventbrite_charts.js` | Ticket pace charts + autopost scheduler |
| memory | 4 | `src/tools/memory.js` | Per-channel/tool memory with versioning |
| slack-knowledge | 2 | `src/tools/slack_knowledge.js` | Semantic search over Slack archive (via rag-query sidecar) |

## 7. RBAC

### Static Role Map

Set via `RBAC_USER_MAP_JSON` env var on orchestration-api:
```json
{"U0337E73E": "ops"}
```

### Open Viewer Channels

Set via `OPEN_VIEWER_CHANNELS` env var (default: `C0AHV5ZCJG4`).
Any user in these channels gets the `viewer` role automatically (read-only tools only).

### Adding a New User

```bash
# Get current value
kubectl get deployment orchestration-api -n artbattle-orchestration \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="RBAC_USER_MAP_JSON")].value}'

# Patch with updated map
kubectl set env deployment/orchestration-api -n artbattle-orchestration \
  'RBAC_USER_MAP_JSON={"U0337E73E":"ops","UNEWUSERID":"viewer"}'
```

## 8. Common Incidents

### 8.1 Tool SQL errors

**Check first:** `esbmcp_v_unresolved_errors` view in Supabase, or ask the bot: `@Arthur Bot show me recent errors`

```sql
SELECT tool_name, error_type, error_code, error_message, error_hint,
       sql_query_preview, created_at
FROM esbmcp_v_unresolved_errors
ORDER BY created_at DESC LIMIT 10;
```

Common causes:
- Table or column name mismatch (schema evolved since tool was written)
- Invalid UUID passed by model (should be caught by validation now)
- Missing index causing timeout on large tables
- Permission denied (wrong connection string — needs service_role for writes)

### 8.2 High error rate on a specific tool

```sql
SELECT * FROM esbmcp_v_error_digest_7d
WHERE tool_name = 'lookup_event';
```

### 8.3 Employee reports bad/wrong answer

Check the full conversation:
```sql
SELECT user_prompt, ai_response, tools_called, status, error_message
FROM esbmcp_chat_sessions
WHERE slack_user_id = 'U...'
ORDER BY created_at DESC LIMIT 5;
```

### 8.4 Gateway not connecting to database

Verify `SUPABASE_DB_URL` is set in `orchestration-secrets`. Check gateway logs:
```bash
kubectl logs -n artbattle-orchestration deploy/orchestration-supervisor --tail=10 | grep db_
```

Look for `db_not_configured` (env var missing) or `db_connected` (success).

### 8.5 Gateway returning 404 for tools

This means the gateway is running the **wrong image** (likely the slackbot image). Verify:
```bash
kubectl logs deploy/orchestration-supervisor -n artbattle-orchestration --tail=5
```
If it says `slackbot_started` instead of `mcp_gateway_started`, rebuild and push the correct image:
```bash
docker build --platform linux/amd64 --no-cache \
  -t registry.digitalocean.com/esbmcp/orchestration-supervisor:latest \
  -f services/mcp-gateway/Dockerfile .
docker push registry.digitalocean.com/esbmcp/orchestration-supervisor:latest
kubectl rollout restart deployment/orchestration-supervisor -n artbattle-orchestration
```

### 8.6 Registry push denied (repo limit)

The free DOCR tier has a 2-repo limit. If you see `denied: registry contains 2 repositories, limit is 1`:
```bash
# Run garbage collection first
doctl registry garbage-collection start --force

# Check existing repos
doctl registry repo list-v2
```
You can only push to existing repo names (`orchestration-api`, `orchestration-supervisor`).

### 8.7 Thread context not working

The bot needs `channels:history` scope. Check logs for:
```bash
kubectl logs deploy/orchestration-api -n artbattle-orchestration --tail=20 | grep thread_context
```
If `missing_scope`, add `channels:history` in the Slack app's OAuth & Permissions → Bot Token Scopes, then reinstall.

## 9. Slack App Scopes

Required bot token scopes (set at api.slack.com/apps):

| Scope | Status | Purpose |
|-------|--------|---------|
| `app_mentions:read` | Active | Listen for @mentions in channels |
| `chat:write` | Active | Send messages and thread replies |
| `commands` | Active | Register /ab slash command |
| `channels:history` | Active | Read thread context for follow-up questions |
| `reactions:write` | Active | Add hourglass typing indicator |
| `im:history` | Active | Read DM thread context |
| `im:read` | Active | View DM channel metadata |
| `im:write` | Active | Send DM messages |
| `mpim:history` | Active | Read group DM thread context |
| `mpim:read` | Active | View group DM metadata |
| `mpim:write` | Active | Send group DM messages |
| `assistant:write` | Active | Slack Assistant framework (top-bar icon, split pane, suggested prompts) |
| `reactions:read` | Active | Read emoji reactions for quality feedback |

See [docs/slack-app-setup.md](slack-app-setup.md) for full setup guide including event subscriptions and App Home config.

### 9.1 Interaction Modes

| Mode | Trigger | Handler | Interaction Type |
|------|---------|---------|-----------------|
| Channel @mention | `@Arthur Bot ...` in a channel | `app_mention` event | `app_mention` |
| Slash command | `/ab ...` | `command` handler | `slash_command` |
| Direct message | Message in DM with bot | `message` event (`channel_type: im`) | `direct_message` |
| Group DM | Message in group DM with bot | `message` event (`channel_type: mpim`) | `group_dm` |
| Assistant panel | Click bot icon in Slack top bar | `Assistant` framework | `assistant` |
| Reaction feedback | React with emoji on bot message | `reaction_added` event | passive |

All modes except reaction feedback go through the same `handle_prompt` → `run_openai_tool_routing` pipeline with full RBAC, rate limiting, and session logging.

## 10. Emergency Read-Only Mode

1. Set `ENABLE_MUTATING_TOOLS=false` on the gateway (default).
2. All 6 write-gated tools will return "Mutating tools are disabled by policy".
3. 42 read-only tools continue working normally.

## 11. Observability Queries

### Daily usage summary
```sql
SELECT * FROM esbmcp_v_daily_volume ORDER BY day DESC LIMIT 7;
```

### Top users
```sql
SELECT * FROM esbmcp_v_user_activity_30d ORDER BY total_sessions DESC LIMIT 10;
```

### Tool popularity
```sql
SELECT * FROM esbmcp_v_tool_usage_30d ORDER BY total_calls DESC;
```

### Token usage and cost
```sql
SELECT ai_model, COUNT(*) AS sessions,
       SUM(prompt_tokens) AS total_prompt,
       SUM(completion_tokens) AS total_completion,
       SUM(total_tokens) AS total_tokens,
       AVG(api_rounds)::numeric(10,1) AS avg_rounds
FROM esbmcp_chat_sessions
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY ai_model;
```

### Bug reports
```sql
SELECT * FROM esbmcp_bug_reports
WHERE status IN ('open', 'in_progress')
ORDER BY created_at DESC;
```

### Reaction feedback (Tier 3)
```sql
-- Sentiment breakdown (last 7 days)
SELECT sentiment, COUNT(*) AS count
FROM esbmcp_reaction_feedback
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY sentiment ORDER BY count DESC;

-- Recent negative/bug reactions
SELECT slack_channel_id, message_ts, slack_user_id, reaction, sentiment, created_at
FROM esbmcp_reaction_feedback
WHERE sentiment IN ('negative', 'bug')
ORDER BY created_at DESC LIMIT 10;
```

### Interaction mode breakdown
```sql
SELECT interaction_type, COUNT(*) AS sessions
FROM esbmcp_chat_sessions
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY interaction_type ORDER BY sessions DESC;
```

### Data retention cleanup (run weekly)
```sql
SELECT esbmcp_cleanup_old_data(90);
```

## 12. Run SQL on Live DB

For quick one-off queries, exec into a pod:
```bash
kubectl exec deployment/orchestration-supervisor -n artbattle-orchestration -- node -e "
const postgres = require('postgres');
const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: 'require' });
(async () => {
  const rows = await sql\`SELECT COUNT(*) FROM esbmcp_chat_sessions\`;
  console.log(rows);
  await sql.end();
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
