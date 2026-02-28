# Eventbrite Data Architecture & Known Issues

Last Updated: 2026-02-28

## Overview

The slackbot generates ticket sales pace charts by reading cached Eventbrite data from the database. There are **two independent systems** that populate this cache, and their data shapes differ. This doc explains the full picture.

## Data Sources

### 1. `fetch-eventbrite-data` Edge Function (admin app)

- **Location:** `~/vote26-fresh/supabase/functions/fetch-eventbrite-data/index.ts`
- **Deployed on:** Supabase Edge Functions
- **Triggered by:** Admin app (manual or scheduled)
- **Writes to:** `eventbrite_api_cache`
- **API used:** Eventbrite Sales Report API (`/organizations/{org_id}/reports/sales/`)
- **Token env var:** `EVENTBRITE_ACCESS_TOKEN` (set in Supabase dashboard)
- **Data stored:** Aggregated totals only — `total_tickets_sold`, `gross_revenue`, `net_deposit`, `total_fees`, `ticket_classes`
- **Does NOT store:** Individual attendee/order data (`orders_summary.attendees` is always empty)
- **Cache rows:** 5,060+ rows across 124 events (as of 2026-02-28)

### 2. `fetch-eventbrite-orders` Edge Function (admin app)

- **Location:** `~/vote26-fresh/supabase/functions/fetch-eventbrite-orders/index.ts`
- **NOT DEPLOYED** as of 2026-02-28 — exists in code but returns 404
- **Writes to:** `eventbrite_orders_cache`
- **API used:** Eventbrite Orders API (`/events/{id}/orders/`)
- **Data stored:** Individual orders with `order_created`, `attendee_count`, `gross`, `order_status`
- **Cache rows:** Only 2 rows for 1 event (barely used)
- **Purpose:** Permanent archive of order data before Eventbrite's 12-month retention expires

### 3. `refresh_eventbrite_data` MCP tool (slackbot)

- **Location:** `services/mcp-gateway/src/tools/eventbrite_charts.js`
- **Before 2026-02-28:** Called EB API directly (`/events/{id}/attendees/`) with `EB_PRIVATE_TOKEN`, stored slim attendees in `eventbrite_api_cache.orders_summary`
- **After 2026-02-28:** Delegates to Edge Function for totals, still calls EB attendees API directly for order-level timeline data, writes to `eventbrite_orders_cache`

## Database Tables

### `eventbrite_api_cache`

- **Schema:** `sql` dir in `~/vote26-fresh/migrations/20251002_eventbrite_api_cache.sql`
- **Key columns:** `eid`, `eventbrite_id`, `total_tickets_sold`, `gross_revenue`, `orders_summary` (JSONB), `fetched_at`
- **Append-only** — multiple rows per event for history, query with `ORDER BY fetched_at DESC LIMIT 1`
- **6-hour TTL** — `expires_at` column set on insert
- **Important:** ALL existing rows were written by the Edge Function and have `orders_summary` = null (no attendee data). The `orders_summary.attendees` array was only populated by the old `refresh_eventbrite_data` code, which was replaced on 2026-02-28.

### `eventbrite_orders_cache`

- **Schema:** `~/vote26-fresh/supabase/migrations/20251218_create_eventbrite_orders_cache.sql`
- **Key columns:** `eid`, `eventbrite_event_id`, `order_id` (UNIQUE), `order_created`, `attendee_count`, `gross`, `order_status`
- **Permanent** — no TTL, orders are immutable
- **Has summary view:** `eventbrite_orders_summary` (aggregated per-event stats)
- **`ON CONFLICT (order_id) DO NOTHING`** — safe to re-fetch without duplicates

### `events` table (main app)

- **Column:** `eventbrite_id VARCHAR(255)` — direct mapping from EID to Eventbrite event ID
- **This is the source of truth** for which events are linked to Eventbrite
- **Not all events have EB IDs** — future events may not have Eventbrite pages created yet

## Chart Data Flow

```
User requests chart for AB4007
    |
    v
events table: AB4007 -> eventbrite_id "1981909401371"
    |
    v
Check eventbrite_api_cache staleness (> 6h?)
    |
    +--> If stale:
    |      1. Call fetch-eventbrite-data Edge Function (refreshes totals)
    |      2. Call EB API /attendees/ directly (populates eventbrite_orders_cache)
    |
    v
load_event_attendees():
    1. Try eventbrite_api_cache.orders_summary.attendees  (currently always empty)
    2. Fallback: eventbrite_orders_cache (order_created, attendee_count, gross)
    3. expand_orders_to_attendees() -> timeline-ready data
    |
    v
build_cumulative_timeline() -> render_chart() -> Slack
```

## Known Issues & TODOs

### 1. `fetch-eventbrite-orders` Edge Function not deployed

The Edge Function exists in the vote26-fresh codebase but is not deployed to Supabase. Currently the slackbot's `refresh_eventbrite_data` fetches attendees directly via the EB API as a workaround. Once this Edge Function is deployed:

- Remove the direct EB API attendee fetch from `refresh_eventbrite_data`
- Call `_edge.invoke("fetch-eventbrite-orders", { eid })` instead
- The `eventbrite_orders_cache` will be populated by the Edge Function

**To deploy:** From `~/vote26-fresh`:
```bash
supabase functions deploy fetch-eventbrite-orders
```

### 2. `orders_summary.attendees` never populated by Edge Function

The `fetch-eventbrite-data` Edge Function uses the Sales Report API which returns aggregated totals, not individual attendees. The `eventbrite_api_cache.orders_summary` column is effectively unused. Chart timelines rely entirely on the `eventbrite_orders_cache` fallback path.

**Implication:** First chart request for any event is slower because it must fetch all attendees from the EB API to populate `eventbrite_orders_cache`. Subsequent requests are fast (orders are permanent).

### 3. SUPABASE_URL was wrong (.com vs .co)

The k8s secret `SUPABASE_URL` was set to `https://xsqdkubgyqwpyvfltnrf.supabase.com` (wrong) instead of `https://xsqdkubgyqwpyvfltnrf.supabase.co` (correct). This meant the Edge Function client was silently failing DNS resolution. Fixed on 2026-02-28 in both the live k8s secret and `deploy/k8s/base/secrets.yaml`.

**Impact:** Any tool that used `_edge.invoke()` (payments, invitations, profile integrity) was broken until this fix. The `edge_client.js` throws on non-200 responses but a DNS failure would cause a timeout/connection error instead.

### 4. Events missing Eventbrite IDs

As of 2026-02-28, 13 upcoming events (through June 2026) have no `eventbrite_id` because their Eventbrite pages haven't been created yet. Only 1 event was actually missing a mapping:

- **AB4045** (Art Battle Bangkok, March 28) — fixed, set to `1981292102012`

The rest (AB4018, AB4022, AB4035, AB4039, AB4042, AB4046, etc.) are far-future events with no Eventbrite pages. When pages are created, the `eventbrite_id` must be set manually in the `events` table or via an admin tool.

**Audit script:** `~/vote26-fresh/scripts/audit-eventbrite-linkage.sql` — cross-references DB events with cached EB data to detect mismatches.

### 5. EB tokens: two different env var names

| System | Env Var | Value |
|--------|---------|-------|
| Supabase Edge Functions | `EVENTBRITE_ACCESS_TOKEN` | `7LME6RSW6TFLEFBDS6DU` |
| MCP Gateway (k8s) | `EB_PRIVATE_TOKEN` | `7LME6RSW6TFLEFBDS6DU` |

Same token, different names. If the token is rotated, both must be updated:
- k8s: `kubectl edit secret orchestration-secrets -n artbattle-orchestration`
- Supabase: Dashboard > Edge Functions > Secrets

### 6. Risk level adjustments

`generate_chart` and `refresh_eventbrite_data` were changed from `medium` to `low` risk. Both are read-only operations (generate_chart renders a chart and logs to `esbmcp_chart_posts_log`; refresh_eventbrite_data updates cache). The `medium` risk was causing unnecessary Confirm/Cancel buttons in Slack, especially when the AI generated charts for multiple events at once (each got its own confirmation dialog).

## Eventbrite API Endpoints Used

| Endpoint | Used By | Purpose |
|----------|---------|---------|
| `/users/me/` | `verify_eventbrite_config` | Token validation |
| `/organizations/{org_id}/` | `verify_eventbrite_config` | Org access check |
| `/organizations/{org_id}/reports/sales/` | Edge Function `fetch-eventbrite-data` | Aggregated financial totals |
| `/events/{id}/` | `verify_eventbrite_config` | Event reachability check |
| `/events/{id}/ticket_classes/` | Edge Function `fetch-eventbrite-data` | Capacity breakdown |
| `/events/{id}/attendees/` | `refresh_eventbrite_data` (paginated, up to 20 pages) | Individual attendee data for chart timelines |
| `/events/{id}/orders/` | Edge Function `fetch-eventbrite-orders` (NOT DEPLOYED) | Individual orders with cost breakdown |

## Matching Events to Eventbrite

To find which DB events are missing EB IDs but have live Eventbrite pages:

```bash
# List all live events on Eventbrite
curl -s -H "Authorization: Bearer $EB_PRIVATE_TOKEN" \
  "https://www.eventbriteapi.com/v3/organizations/$EB_ORG_ID/events/?status=live&order_by=start_asc&page_size=100" \
  | python3 -c "
import sys, json
for e in json.load(sys.stdin).get('events', []):
    print(f'{e[\"id\"]:>15}  {e[\"start\"][\"local\"][:10]}  {e[\"name\"][\"text\"]}')"

# List DB events missing EB IDs
psql "\$SUPABASE_DB_URL" -c "
  SELECT eid, name, event_start_datetime::date
  FROM events
  WHERE event_start_datetime > NOW()
    AND (eventbrite_id IS NULL OR eventbrite_id = '')
  ORDER BY event_start_datetime;"

# Set a missing EB ID
psql "\$SUPABASE_DB_URL" -c "
  UPDATE events SET eventbrite_id = 'EVENTBRITE_ID_HERE'
  WHERE eid = 'AB1234';"
```

## Files Reference

| File | Purpose |
|------|---------|
| `services/mcp-gateway/src/tools/eventbrite_charts.js` | 10 EB chart tools (generate, refresh, schedule, comparators, verify) |
| `services/mcp-gateway/src/chart_scheduler.js` | 60s polling scheduler for chart autopost |
| `services/mcp-gateway/src/edge_client.js` | HTTP client for Supabase Edge Functions |
| `services/mcp-gateway/src/index.js` | Wires edge client into scheduler |
| `config/allowed-tools.json` | Tool manifest with risk levels and descriptions |
| `deploy/k8s/base/secrets.yaml` | K8s secrets (SUPABASE_URL, EB tokens, etc.) |
| `~/vote26-fresh/supabase/functions/fetch-eventbrite-data/index.ts` | Edge Function: totals + cache |
| `~/vote26-fresh/supabase/functions/fetch-eventbrite-orders/index.ts` | Edge Function: orders (NOT DEPLOYED) |
| `~/vote26-fresh/migrations/20251002_eventbrite_api_cache.sql` | Cache table schema |
| `~/vote26-fresh/supabase/migrations/20251218_create_eventbrite_orders_cache.sql` | Orders cache schema |
| `~/vote26-fresh/scripts/audit-eventbrite-linkage.sql` | Audit script for EB ID mismatches |
