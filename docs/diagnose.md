# Diagnostics Guide

Last Updated: 2026-02-28

Quick-reference for diagnosing issues with the employee slackbot system.

## 1. Local Environment Setup

Load credentials from the k8s secrets file so all commands below work without hardcoding tokens:

```bash
# Source env vars from secrets.yaml (requires yq)
eval $(yq '.stringData | to_entries | .[] | "export " + .key + "=\"" + (.value | tostring) + "\""' deploy/k8s/base/secrets.yaml)

# Verify key vars are set
echo "DB: ${SUPABASE_DB_URL:0:30}..."
echo "EB Token: ${EB_PRIVATE_TOKEN:0:8}..."
echo "EB Org: $EB_ORG_ID"
```

If you don't have `yq`, install it:
```bash
brew install yq
```

Alternatively, pull from the live cluster:
```bash
eval $(kubectl get secret orchestration-secrets -n artbattle-orchestration \
  -o json | python3 -c "
import sys, json, base64
data = json.load(sys.stdin)['data']
for k,v in data.items():
    print(f'export {k}=\"{base64.b64decode(v).decode()}\"')
")
```

## 2. Database Queries

All queries below assume `$SUPABASE_DB_URL` is set (see section 1).

### Check open bug reports

```bash
psql "$SUPABASE_DB_URL" -c "
  SELECT id, slack_username, title, status, priority, related_eid,
         created_at::date as reported, LEFT(description, 120) as description
  FROM esbmcp_bug_reports
  WHERE status IN ('open', 'in_progress')
  ORDER BY
    CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
    created_at DESC;
"
```

### Check recent tool errors

```bash
psql "$SUPABASE_DB_URL" -c "
  SELECT tool_name, error_message, created_at
  FROM esbmcp_tool_errors
  ORDER BY created_at DESC LIMIT 10;
"
```

### Unresolved errors (view)

```bash
psql "$SUPABASE_DB_URL" -c "
  SELECT tool_name, error_type, error_code, error_message, error_hint,
         sql_query_preview, created_at
  FROM esbmcp_v_unresolved_errors
  ORDER BY created_at DESC LIMIT 10;
"
```

### Check tool execution history (failures only)

```bash
psql "$SUPABASE_DB_URL" -c "
  SELECT tool_name, ok, has_error_field, error_message, arguments_preview,
         duration_ms, created_at
  FROM esbmcp_tool_executions
  WHERE ok = false OR has_error_field = true
  ORDER BY created_at DESC LIMIT 20;
"
```

### Check tool execution for a specific tool

```bash
TOOL_NAME=generate_chart
psql "$SUPABASE_DB_URL" -c "
  SELECT tool_name, ok, has_error_field, error_message, arguments_preview,
         result_keys, duration_ms, created_at
  FROM esbmcp_tool_executions
  WHERE tool_name = '$TOOL_NAME'
  ORDER BY created_at DESC LIMIT 10;
"
```

### Recent chat sessions

```bash
psql "$SUPABASE_DB_URL" -c "
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'esbmcp_chat_sessions' ORDER BY ordinal_position;
"
```

### Daily volume and user activity

```bash
psql "$SUPABASE_DB_URL" -c "SELECT * FROM esbmcp_v_daily_volume ORDER BY day DESC LIMIT 7;"
psql "$SUPABASE_DB_URL" -c "SELECT * FROM esbmcp_v_user_activity_30d ORDER BY total_sessions DESC LIMIT 10;"
```

## 3. Eventbrite API Diagnostics

### Verify token validity

```bash
curl -s -o /dev/null -w "HTTP %{http_code}" \
  -H "Authorization: Bearer $EB_PRIVATE_TOKEN" \
  "https://www.eventbriteapi.com/v3/users/me/"
```

### Verify org access

```bash
curl -s -H "Authorization: Bearer $EB_PRIVATE_TOKEN" \
  "https://www.eventbriteapi.com/v3/organizations/$EB_ORG_ID/" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Org: {d.get(\"name\",\"ERROR\")}, ID: {d.get(\"id\",\"MISSING\")}')"
```

### Test a specific event by Eventbrite ID

```bash
EB_EVENT_ID=1981909401371  # change as needed

# Event details
curl -s -w "\nHTTP %{http_code}" \
  -H "Authorization: Bearer $EB_PRIVATE_TOKEN" \
  "https://www.eventbriteapi.com/v3/events/$EB_EVENT_ID/" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Event: {d.get(\"name\",{}).get(\"text\",\"?\")}, Status: {d.get(\"status\",\"?\")}, Org: {d.get(\"organization_id\",\"?\")}')"

# Attendees
curl -s -w "\nHTTP %{http_code}" \
  -H "Authorization: Bearer $EB_PRIVATE_TOKEN" \
  "https://www.eventbriteapi.com/v3/events/$EB_EVENT_ID/attendees/?page=1" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); p=d.get('pagination',{}); print(f'Attendees: {p.get(\"object_count\",0)}, Pages: {p.get(\"page_count\",0)}')"

# Ticket classes
curl -s \
  -H "Authorization: Bearer $EB_PRIVATE_TOKEN" \
  "https://www.eventbriteapi.com/v3/events/$EB_EVENT_ID/ticket_classes/" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); tcs=d.get('ticket_classes',[]); [print(f'  {tc[\"name\"]}: {tc.get(\"quantity_sold\",0)}/{tc.get(\"quantity_total\",0)}') for tc in tcs]"
```

### Look up Eventbrite ID for an event EID

```bash
EID=AB4007
psql "$SUPABASE_DB_URL" -c "
  SELECT eid, name, eventbrite_id, event_start_datetime::date as event_date
  FROM events WHERE eid = '$EID';
"
```

### Find events missing Eventbrite IDs (future events)

```bash
psql "$SUPABASE_DB_URL" -c "
  SELECT eid, name, event_start_datetime::date as event_date
  FROM events
  WHERE event_start_datetime > NOW()
    AND (eventbrite_id IS NULL OR eventbrite_id = '')
  ORDER BY event_start_datetime LIMIT 20;
"
```

### Check Eventbrite cache freshness

```bash
psql "$SUPABASE_DB_URL" -c "
  SELECT eid, eventbrite_id, total_tickets_sold, gross_revenue,
         fetched_at, NOW() - fetched_at::timestamptz as age
  FROM eventbrite_api_cache
  WHERE eid = 'AB4007'
  ORDER BY fetched_at DESC LIMIT 3;
"
```

### Common Eventbrite issues

| Symptom | Likely Cause | Check |
|---------|-------------|-------|
| 403 on all endpoints | Token expired/revoked | Test `/users/me/` (see above) |
| 403 on specific event | Event belongs to different org | Compare `organization_id` in event response vs `$EB_ORG_ID` |
| `No Eventbrite ID linked` | Future event not yet created on Eventbrite | Query events table for `eventbrite_id` |
| `column X does not exist` | Code/schema mismatch — needs redeploy | Check `eventbrite_api_cache` columns vs code queries |
| Empty attendee data | Cache stale or event has no sales | Check cache freshness, call `refresh_eventbrite_data` with `force=true` |

## 4. Kubernetes / Pod Diagnostics

### Check pod status and recent restarts

```bash
kubectl get pods -n artbattle-orchestration -o wide
```

### Check logs for errors

```bash
# MCP Gateway (orchestration-supervisor)
kubectl logs deployment/orchestration-supervisor -n artbattle-orchestration --tail=100 \
  | grep -i -E "error|fail|403|crash" | tail -20

# Slackbot (orchestration-api)
kubectl logs deployment/orchestration-api -n artbattle-orchestration --tail=100 \
  | grep -i -E "error|fail|crash" | tail -20
```

### Check specific tool executions in logs

```bash
TOOL=generate_chart
kubectl logs deployment/orchestration-supervisor -n artbattle-orchestration --tail=500 \
  | grep "\"tool_name\":\"$TOOL\"" | tail -10
```

### Verify deployed image matches latest push

```bash
# Image running in cluster
kubectl get deployment orchestration-supervisor -n artbattle-orchestration \
  -o jsonpath='{.spec.template.spec.containers[0].image}'

# Latest image in registry
doctl registry repository list-tags orchestration-supervisor --format Tag,UpdatedAt | head -3
```

### Check if deployed code is stale

If a fix has been committed but errors persist, the image may not have been rebuilt:

```bash
# Last commit touching a file
git log --oneline -1 -- services/mcp-gateway/src/tools/eventbrite_charts.js

# Last image push
doctl registry repository list-tags orchestration-supervisor --format UpdatedAt | head -2
```

If the commit is newer than the push, rebuild and redeploy (see runbook section 3).

## 5. Chart Scheduler Diagnostics

### Check scheduled jobs

```bash
psql "$SUPABASE_DB_URL" -c "
  SELECT id, eid, slack_channel_id, cadence, is_active,
         last_run_at, next_run_at, last_status, fail_count
  FROM esbmcp_scheduled_chart_jobs
  ORDER BY next_run_at;
"
```

### Check chart post history

```bash
psql "$SUPABASE_DB_URL" -c "
  SELECT eid, ticket_count, revenue, pace_per_day, days_until_event,
         render_duration_ms, created_at
  FROM esbmcp_chart_posts_log
  ORDER BY created_at DESC LIMIT 10;
"
```

### Check scheduler logs

```bash
kubectl logs deployment/orchestration-supervisor -n artbattle-orchestration --tail=200 \
  | grep -E "chart_scheduler|chart_job" | tail -20
```

## 6. Resolve a Bug Report

After diagnosing and fixing an issue:

```bash
BUG_ID="c0e1f88f-..."  # UUID from bug_reports table
psql "$SUPABASE_DB_URL" -c "
  UPDATE esbmcp_bug_reports
  SET status = 'resolved',
      resolved_at = NOW(),
      resolved_by = 'your-name',
      resolution_note = 'Description of fix'
  WHERE id = '$BUG_ID';
"
```

## 7. Quick Health Checks (all-in-one)

```bash
echo "=== Pods ==="
kubectl get pods -n artbattle-orchestration

echo "=== EB Token ==="
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $EB_PRIVATE_TOKEN" \
  "https://www.eventbriteapi.com/v3/users/me/"

echo "=== DB Connection ==="
psql "$SUPABASE_DB_URL" -c "SELECT 1 AS db_ok;" 2>&1 | tail -1

echo "=== Open Bug Reports ==="
psql "$SUPABASE_DB_URL" -c "SELECT COUNT(*) AS open_bugs FROM esbmcp_bug_reports WHERE status = 'open';"

echo "=== Recent Errors (24h) ==="
psql "$SUPABASE_DB_URL" -c "
  SELECT COUNT(*) AS errors_24h FROM esbmcp_tool_executions
  WHERE (ok = false OR has_error_field = true)
    AND created_at > NOW() - INTERVAL '24 hours';
"
```
