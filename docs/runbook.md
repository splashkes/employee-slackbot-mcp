# Orchestration + Execution Runbook

Last Updated: 2026-02-28
Owner: Platform Engineering

## 1. Services

### Orchestration Plane

1. `orchestration-api` (slackbot, port `3000`) — Slack ingress, AI routing, session logging
2. `orchestration-supervisor` (MCP gateway, port `8081`) — tool execution, audit logging

### Execution Plane (deferred — replicas: 0)

1. `runner-data-read`
2. `runner-profile-integrity`
3. `runner-payments`
4. `runner-growth-marketing`
5. `runner-platform-db-edge`

All 46 tools are served directly by the MCP gateway. Runners are reserved for future async agent work.

## 2. Health Checks

### Orchestration API (Slackbot)

```bash
curl -sS http://localhost:3000/healthz
curl -sS http://localhost:3000/readyz   # checks OpenAI key + gateway reachability
```

### Orchestration Supervisor (MCP Gateway)

```bash
curl -sS http://localhost:8081/healthz
curl -sS http://localhost:8081/readyz
```

## 3. Deployment

```bash
# 1. Run observability migrations on Supabase (one-time)
psql "$SUPABASE_DB_URL" -f sql/001_create_esbmcp_tables.sql
psql "$SUPABASE_DB_URL" -f sql/002_create_esbmcp_views.sql

# 2. Apply secrets and k8s manifests
kubectl apply -f deploy/k8s/base/secrets.template.yaml
kubectl apply -k deploy/k8s/base
```

## 4. Tool Domains and Counts

| Domain | Tools | Module | Risk |
|--------|-------|--------|------|
| data-read | 15 | `src/tools/data_read.js` | All read-only |
| profile-integrity | 10 | `src/tools/profile_integrity.js` | 4 write-gated |
| payments | 9 | `src/tools/payments.js` | 2 write-gated |
| growth-marketing | 7 | `src/tools/growth_marketing.js` | All read-only |
| platform-db-edge | 5 | `src/tools/platform_ops.js` | All read-only |

## 5. Common Incidents

### 5.1 Tool SQL errors

**Check first:** `esbmcp_v_unresolved_errors` view in Supabase.

```sql
SELECT tool_name, error_type, error_code, error_message, error_hint,
       sql_query_preview, created_at
FROM esbmcp_v_unresolved_errors
ORDER BY created_at DESC LIMIT 10;
```

Common causes:
- Table or column name mismatch (schema evolved since tool was written)
- Missing index causing timeout on large tables
- Permission denied (wrong connection string — needs service_role for writes)

### 5.2 High error rate on a specific tool

```sql
SELECT * FROM esbmcp_v_error_digest_7d
WHERE tool_name = 'lookup_event';
```

### 5.3 Employee reports bad/wrong answer

Check the full conversation:
```sql
SELECT user_prompt, ai_response, tools_called, status, error_message
FROM esbmcp_chat_sessions
WHERE slack_user_id = 'U...'
ORDER BY created_at DESC LIMIT 5;
```

Check if the employee left feedback:
```sql
SELECT * FROM esbmcp_v_negative_feedback
ORDER BY feedback_at DESC LIMIT 10;
```

### 5.4 Gateway not connecting to database

Verify `SUPABASE_DB_URL` is set in `orchestration-secrets`. Check gateway logs:
```bash
kubectl logs -n artbattle-orchestration deploy/orchestration-supervisor | grep db_
```

Look for `db_client_skipped` (env var missing) or `db_client_created` (connected).

### 5.5 Rate limit complaints

```sql
SELECT * FROM esbmcp_v_audit_denials_7d
WHERE event_type = 'rate_limit_exceeded';
```

Adjust via `RATE_LIMIT_USER_MAX` and `RATE_LIMIT_CHANNEL_MAX` env vars.

## 6. Secret Rotation

1. Rotate orchestration secrets in `artbattle-orchestration` namespace.
2. Rotate runner-domain secrets in `artbattle-execution` namespace (when runners are active).
3. Restart impacted deployments and verify tool execution.

Key secrets for the gateway:
- `SUPABASE_DB_URL` — Postgres connection string
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — Edge Function access
- `MCP_GATEWAY_AUTH_TOKEN` + `MCP_REQUEST_SIGNING_SECRET` — inter-service auth

## 7. Emergency Read-Only Mode

1. Set `ENABLE_MUTATING_TOOLS=false` on the gateway (default).
2. All 6 write-gated tools will return "Mutating tools are disabled by policy".
3. 40 read-only tools continue working normally.

## 8. Observability Queries

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

### Data retention cleanup (run weekly)
```sql
SELECT esbmcp_cleanup_old_data(90);
```
