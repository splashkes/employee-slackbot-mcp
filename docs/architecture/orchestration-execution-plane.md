# Orchestration + Execution Plane

Date: 2026-02-28
Status: Canonical
Source Context: `/Users/splash/vote26-fresh/AB_SKILL_AREAS_REFERENCE.md`

## 1) Goal

A Slack-native operations assistant that lets Art Battle employees ask questions in natural language and get answers backed by real data. The system uses an **orchestration plane** (Slack + AI routing) and a **single MCP gateway** that executes 46 tools across 5 operational domains, with direct SQL access to Supabase Postgres.

Employees do not need to know tool names or use slash commands — they describe their problem and the AI selects the right tools automatically.

## 2) Architecture Overview

```
Slack (employee) ──► Slackbot (orchestration-api)
                         │
                         ├─► OpenAI (smart skill selector)
                         │      ↕ tool calls
                         ├─► MCP Gateway (orchestration-supervisor)
                         │      ├─► Supabase Postgres (SQL queries)
                         │      ├─► Supabase Edge Functions (mutations)
                         │      └─► Local Git Clone (code review)
                         │
                         └─► esbmcp_ tables (audit + observability)
```

### Request Flow

1. Employee mentions `@bot` or uses `/ab` in Slack.
2. Slackbot validates identity, rate limits, resolves RBAC role.
3. OpenAI receives the prompt + available tool definitions, selects tools.
4. For each tool call, slackbot sends a signed request to the MCP gateway.
5. Gateway validates signature, role, arguments, then dispatches to the tool handler.
6. Tool handler runs SQL against Supabase Postgres (or calls an Edge Function for mutations).
7. Results flow back through OpenAI for synthesis into a natural-language response.
8. Response is redacted (PII masking) and posted to Slack.
9. Full session, tool executions, and audit events are written to `esbmcp_` Postgres tables.

## 3) Services

### Orchestration Plane

| Service | Code Path | Port | Role |
|---------|-----------|------|------|
| `orchestration-api` | `services/slackbot/` | 3000 | Slack ingress, identity, RBAC, rate limiting, OpenAI routing, session logging |
| `orchestration-supervisor` | `services/mcp-gateway/` | 8081 | Tool execution, argument validation, audit logging, DB/Edge clients |

### Execution Plane (Deferred)

Five runner deployments exist in k8s manifests at `replicas: 0`. All tool execution is handled by the MCP gateway directly. Runners are reserved for future async agent work.

| Runner | Status |
|--------|--------|
| `runner-data-read` | `replicas: 0` — tools served by gateway |
| `runner-profile-integrity` | `replicas: 0` — tools served by gateway |
| `runner-payments` | `replicas: 0` — tools served by gateway |
| `runner-growth-marketing` | `replicas: 0` — tools served by gateway |
| `runner-platform-db-edge` | `replicas: 0` — tools served by gateway |

## 4) Smart Skill Selection

The AI system prompt instructs OpenAI to act as a **skill selector**. Employees describe problems naturally:

- "Why can't people see AB4023?" → `debug_event_visibility`
- "How much did we make at the Toronto event?" → `lookup_event` + `get_auction_revenue`
- "Is AB4050 ready to go live?" → `get_event_readiness`
- "Who still needs to be paid for AB4001?" → `get_artists_owed`

Each tool in `config/allowed-tools.json` has a rich description telling the AI when to use it. The employee never needs to know tool names.

## 5) Tool Coverage (46 Tools, 80%+ of 50 Skill Areas)

### Domain: data-read (15 tools, all read-only SQL)

| # | Skill | Tool | Method |
|---|-------|------|--------|
| 1 | Event Lookup | `lookup_event` | SQL: events + cities + venues |
| 2 | Person/User Lookup | `lookup_person` | SQL: people |
| 3 | Artist Profile Lookup | `lookup_artist_profile` | SQL: artist_profiles + people |
| 4 | Artwork & Bid Lookup | `lookup_artwork_bids` | SQL: art + bids |
| 5 | Vote Data | `get_vote_data` | SQL: votes + vote_weights |
| 17 | Event Visibility Debug | `debug_event_visibility` | SQL: events flags + cache |
| 18 | Event Config | `get_event_config` | SQL: events full row |
| 19 | Event Health Check | `run_event_health_check` | SQL: event linter rules |
| 20 | Post-Event Summary | `get_event_summary` | SQL: art + bids + votes |
| 22 | Bid History | `get_bid_history` | SQL: bids + people |
| 23 | Auction Timing | `get_auction_timing` | SQL: art + rounds |
| 24 | Auction Revenue | `get_auction_revenue` | SQL: art final_price |
| 28 | Eventbrite Data | `get_eventbrite_data` | SQL: eventbrite_api_cache |
| 29 | Eventbrite Mapping | `get_eventbrite_mapping` | SQL: events.eventbrite_id |
| 30 | Eventbrite Fees | `get_eventbrite_fees` | SQL: eventbrite_api_cache fees |

### Domain: profile-integrity (10 tools, 4 write-gated)

| # | Skill | Tool | Method | Risk |
|---|-------|------|--------|------|
| 6 | Duplicate Profiles | `find_duplicate_profiles` | SQL: artist_profiles by phone/email/name | low |
| 7 | Artist Name Rename | `update_artist_name` | SQL: UPDATE artist_profiles.name | high |
| 8 | Artist Bio Edit | `update_artist_bio` | SQL: UPDATE artist_profiles.abhq_bio | medium |
| 9 | Artist Country Fix | `update_artist_country` | SQL: UPDATE artist_profiles.country | medium |
| 10 | Artist Invitations | `get_artist_invitations` | SQL: artist_invitations | low |
| 10 | Artist Invitations | `send_artist_invitation` | Edge: admin-send-invitation | high |
| 21 | Event Readiness | `get_event_readiness` | SQL: composite readiness check | low |
| 25 | Vote Weights | `get_vote_weights` | SQL: vote_weights detail | low |
| 25 | Vote Weights | `refresh_vote_weights` | SQL: manual_refresh_vote_weights() | high |
| 27 | QR Scan Status | `get_qr_scan_status` | SQL: qr_codes + people_qr_scans | low |

### Domain: payments (9 tools, 2 write-gated)

| # | Skill | Tool | Method | Risk |
|---|-------|------|--------|------|
| 11 | Stripe Status | `get_artist_stripe_status` | SQL: artist_stripe_accounts | low |
| 11 | Stripe Payment | `process_artist_payment` | Edge: auto-process-artist-payments | high |
| 12 | Exchange Rates | `get_exchange_rates` | SQL: exchange_rates | low |
| 13 | Manual Payments | `get_manual_payment_requests` | SQL: artist_manual_payment_requests | low |
| 14 | Payment Ledger | `get_artist_payment_ledger` | SQL: artist_payments + art | low |
| 14 | Artists Owed | `get_artists_owed` | SQL: sales vs payments | low |
| 15 | Payment Health | `get_payment_status_health` | SQL: art + payments cross-check | low |
| 16 | Payment Invitations | `get_payment_invitations` | SQL: payment_setup_invitations | low |
| 16 | Payment Reminders | `send_payment_reminder` | Edge: admin-send-payment-reminder | high |

### Domain: growth-marketing (7 tools, all read-only)

| # | Skill | Tool | Method |
|---|-------|------|--------|
| 31 | Meta Ads | `get_meta_ads_data` | SQL: meta_ads_cache_cron_log |
| 33 | SMS Campaigns | `get_sms_campaigns` | SQL: sms_marketing_campaigns |
| 33 | SMS Audience | `get_sms_audience_count` | SQL: audience count query |
| 34 | SMS Conversation | `get_sms_conversation` | SQL: sms_inbound + sms_outbound |
| 35 | Notifications | `get_notification_status` | SQL: sms_outbound + message_queue |
| 48 | Offers | `get_active_offers` | SQL: offers + redemptions |
| 49 | Sponsorships | `get_sponsorship_summary` | SQL: sponsorship_invites + purchases |

### Domain: platform-db-edge (5 tools, all read-only)

| # | Skill | Tool | Method |
|---|-------|------|--------|
| 36 | Slack Queue | `get_slack_queue_health` | SQL: slack_notifications |
| 37 | Email Stats | `get_email_queue_stats` | SQL: email_logs |
| 38 | Email Log | `get_email_log` | SQL: email_logs by recipient/event |
| 42 | RLS Policies | `check_rls_policies` | SQL: pg_policies catalog |
| 50 | Live Event Support | `live_event_diagnostic` | SQL: composite event diagnostic |

### Deferred Skills (10 of 50)

| # | Skill | Reason |
|---|-------|--------|
| 26 | Vote Weight Calc Analysis | Covered by #25 get_vote_weights |
| 32 | Meta Ads Token Mgmt | Requires token refresh — ops concern |
| 39 | Edge Function Development | Requires Deno runtime |
| 40 | Edge Function Debugging | Requires Deno + system_logs |
| 41 | Database Migration Execution | Too dangerous for a bot |
| 43 | PL/pgSQL Development | Code generation — out of scope |
| 44 | CDN Deploy & Cache Busting | Requires s3cmd + build pipeline |
| 45 | DO App Platform Mgmt | Requires doctl — ops concern |
| 46 | Git Secret Scrubbing | Security ops |
| 47 | Admin Component Development | Frontend dev |

## 6) Data Access

### Direct SQL (Primary)

Tools query Supabase Postgres via the `postgres` npm package (postgres.js). Connection configured via `SUPABASE_DB_URL` env var.

- **Connection pool**: max 5 connections, 30s idle timeout, 10s connect timeout
- **Read-only recommended**: Use a read-only connection string for safety
- **Parameterized queries**: All queries use tagged template literals (no SQL injection)

### Edge Functions (Mutations)

Write operations route through Supabase Edge Functions via HTTP, using `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`:

- `admin-send-invitation` — artist event invitations
- `auto-process-artist-payments` — Stripe payment processing
- `admin-send-payment-reminder` — payment setup reminders

### Local Git Clone (Code Review)

The `repo_browser.js` module maintains a shallow clone of the main codebase for tools that need to inspect source code. Configured via `CODEBASE_REPO_URL` env var.

## 7) Observability & Audit

All telemetry is written to Supabase Postgres tables with the `esbmcp_` prefix. Writes are fire-and-forget (non-blocking) so they never slow down request handling.

### Tables

| Table | Purpose | Writer |
|-------|---------|--------|
| `esbmcp_chat_sessions` | Full conversation per Slack interaction: user prompt, AI response, tools called, timing, status | Slackbot |
| `esbmcp_tool_executions` | Per-tool call: tool name, domain, duration, success/fail, arguments hash, result shape | MCP Gateway |
| `esbmcp_audit_log` | Every policy decision: identity checks, role denials, rate limits, confirmations, tool executions | Both |
| `esbmcp_tool_errors` | Detailed errors with Postgres error codes, hints, query previews, resolution tracking | MCP Gateway |
| `esbmcp_feedback` | Employee ratings (thumbs up/down + comment) per session | Slackbot |

### Origin Metadata (on every record)

- `slack_user_id`, `slack_team_id`, `slack_channel_id`, `slack_username`
- `user_role` (resolved RBAC role)
- `session_id` (links tool executions back to the chat session)
- `request_id`, `gateway_version`

### Analytics Views

| View | What it shows |
|------|---------------|
| `esbmcp_v_tool_usage_30d` | Tool call counts, success rates, p95 latency, unique users |
| `esbmcp_v_user_activity_30d` | Per-user session counts, tools used, error rates |
| `esbmcp_v_error_digest_7d` | Grouped recurring errors with occurrence counts |
| `esbmcp_v_daily_volume` | Sessions per day with status breakdown |
| `esbmcp_v_hourly_heatmap_7d` | Usage by hour and day of week |
| `esbmcp_v_audit_denials_7d` | Security events: who got denied and why |
| `esbmcp_v_unresolved_errors` | Feedback loop: errors that still need fixing |
| `esbmcp_v_negative_feedback` | Bad ratings with full conversation context |

### Feedback Loop

1. **Errors auto-captured**: Every SQL error, Edge Function failure, or timeout is written to `esbmcp_tool_errors` with the Postgres error code, hint, and query preview.
2. **Resolution tracking**: Each error has `resolved`, `resolved_at`, `resolved_by`, `resolution_note` fields.
3. **Unresolved errors view**: `esbmcp_v_unresolved_errors` shows what still needs fixing, with the triggering user prompt for context.
4. **Employee feedback**: Users can rate responses. Negative feedback is joined with full session data in `esbmcp_v_negative_feedback`.

### Retention

`esbmcp_cleanup_old_data(retention_days)` function deletes data older than N days (default 90). Call via pg_cron or manual schedule.

### SQL Migration Files

```
sql/001_create_esbmcp_tables.sql  — tables, indexes, RLS
sql/002_create_esbmcp_views.sql   — analytics views, retention function
```

Run against the Supabase Postgres instance. All tables have RLS enabled with no policies (service_role only).

## 8) Security Model

### Authentication & Signing

- Slackbot ↔ Gateway: Bearer token + HMAC SHA-256 request signing with timestamp validation (5-minute window)
- Gateway ↔ Supabase: `SUPABASE_DB_URL` (connection string) or `SUPABASE_SERVICE_ROLE_KEY` (Edge Functions)

### RBAC

- Roles: `ops`, `event-producer`, `finance`, `marketing`
- Each tool specifies `allowed_roles` in `config/allowed-tools.json`
- Role resolution: static map (`RBAC_USER_MAP_JSON`) or directory API
- Role cache with configurable TTL

### Mutating Tool Gates

- All write operations require `enable_mutating_tools=true` (env var)
- High-risk tools require explicit confirmation (user must include "CONFIRM" in prompt)
- `requires_confirmation: true` in tool definition triggers a 409 response without confirmation

### PII Redaction

Applied to AI responses before posting to Slack:
- `mask_email`: `j***@example.com`
- `mask_phone`: `***42`
- `mask_card_data`: `**** **** **** 1234`

### Rate Limiting

- Per-user: configurable window and max (default: 20/minute)
- Per-channel: configurable window and max (default: 80/minute)

## 9) Kubernetes Structure

### Namespaces

1. `artbattle-orchestration` — Slack ingress, AI routing, policy
2. `artbattle-execution` — runner deployments (replicas: 0 for now)
3. `shared` — Redis and shared infrastructure (deferred)

### Deployments

| Deployment | Namespace | Image | Replicas |
|------------|-----------|-------|----------|
| `orchestration-api` | orchestration | `ghcr.io/splashkes/orchestration-api` | 1 |
| `orchestration-supervisor` | orchestration | `ghcr.io/splashkes/orchestration-supervisor` | 1 |
| `runner-data-read` | execution | `ghcr.io/splashkes/runner-data-read` | 0 |
| `runner-profile-integrity` | execution | `ghcr.io/splashkes/runner-profile-integrity` | 0 |
| `runner-payments` | execution | `ghcr.io/splashkes/runner-payments` | 0 |
| `runner-growth-marketing` | execution | `ghcr.io/splashkes/runner-growth-marketing` | 0 |
| `runner-platform-db-edge` | execution | `ghcr.io/splashkes/runner-platform-db-edge` | 0 |

### Network Policies

- Default deny-all ingress+egress on both namespaces
- `orchestration-api`: inbound port 3000 (external/ingress)
- `orchestration-supervisor`: inbound port 8081 (intra-namespace only)
- Orchestration egress: HTTPS (443), DNS (53), managed Redis (25061)
- Execution egress: HTTPS (443), DNS (53), Postgres (5432), managed Redis (25061)

### Secrets

| Secret | Namespace | Keys |
|--------|-----------|------|
| `orchestration-secrets` | orchestration | Slack tokens, OpenAI key, gateway signing secrets, `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `shared-infra-secrets` | execution | `REDIS_URL` |
| `runner-data-read-secrets` | execution | `SUPABASE_DB_URL_READONLY`, `SUPABASE_ANON_KEY` |
| `runner-profile-integrity-secrets` | execution | `SUPABASE_SERVICE_ROLE_KEY` |
| `runner-payments-secrets` | execution | `SUPABASE_SERVICE_ROLE_KEY`, Stripe keys |
| `runner-growth-marketing-secrets` | execution | Eventbrite, Meta, Twilio, AWS keys |
| `runner-platform-db-edge-secrets` | execution | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL_ADMIN` |

## 10) Key File Paths

```
config/allowed-tools.json                          — 46 tool definitions with AI descriptions
services/mcp-gateway/src/tools.js                  — tool registry and dispatcher
services/mcp-gateway/src/tools/data_read.js        — 15 data-read tools
services/mcp-gateway/src/tools/profile_integrity.js — 10 profile tools
services/mcp-gateway/src/tools/payments.js         — 9 payment tools
services/mcp-gateway/src/tools/growth_marketing.js — 7 marketing tools
services/mcp-gateway/src/tools/platform_ops.js     — 5 platform tools
services/mcp-gateway/src/db.js                     — Postgres connection pool
services/mcp-gateway/src/edge_client.js            — Edge Function HTTP client
services/mcp-gateway/src/repo_browser.js           — Local git repo for code review
services/mcp-gateway/src/audit_writer.js           — Audit/telemetry writer
services/slackbot/src/session_writer.js            — Chat session persistence
services/slackbot/src/openai_router.js             — AI routing with skill selector prompt
sql/001_create_esbmcp_tables.sql                   — Observability tables
sql/002_create_esbmcp_views.sql                    — Analytics views
```

## 11) Rollout Order

```
Phase 1 — Build fixes                              ✅ DONE
Phase 2 — Operational basics                        ✅ DONE
Phase 3 — Connect Slack                             ⚠️  MANUAL (secrets + deploy)
Phase 4 — Real tool backends                        ✅ DONE (46 tools implemented)
Phase 5 — Observability tables                      ⚠️  Run sql/001 + sql/002 on Supabase
Phase 6 — Future: Async agents, event creation, code review tools
```

## 12) Acceptance Criteria

1. Employees describe problems in natural language — AI selects tools automatically.
2. 46 tools execute real SQL queries against Supabase Postgres.
3. All write operations are gated behind `enable_mutating_tools` + confirmation.
4. Every tool call, policy decision, and conversation is logged to `esbmcp_` tables.
5. Errors are captured with enough detail (Postgres error codes, query previews) to diagnose and fix without reproduction.
6. PII is redacted from responses before reaching Slack.
7. 19/19 tests pass.
