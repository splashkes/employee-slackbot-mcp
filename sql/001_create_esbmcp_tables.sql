-- =============================================================================
-- Employee Slackbot MCP — Observability & Audit Tables
-- Prefix: esbmcp_
-- Run against: Supabase Postgres (same project as the main AB database)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. esbmcp_chat_sessions
--    One row per Slack interaction (app_mention or /ab command).
--    Captures the full roundtrip: user prompt → AI reasoning → tool calls → response.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS esbmcp_chat_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Origin: who, where, when
  slack_user_id   text        NOT NULL,
  slack_team_id   text,
  slack_channel_id text,
  slack_username  text,                        -- display name at time of request
  user_role       text,                        -- resolved RBAC role (ops, finance, etc.)
  interaction_type text       NOT NULL DEFAULT 'app_mention',  -- app_mention | slash_command

  -- The conversation
  user_prompt     text        NOT NULL,
  ai_model        text,                        -- e.g. gpt-4o-mini
  ai_system_prompt_hash text,                  -- sha256 of system prompt (track prompt changes)
  ai_response     text,
  tools_called    jsonb       DEFAULT '[]',    -- [{tool_name, arguments_hash, duration_ms, ok}]
  tool_call_count int         DEFAULT 0,

  -- Outcome
  status          text        NOT NULL DEFAULT 'completed',  -- completed | error | rate_limited | denied
  error_message   text,
  error_id        text,                        -- correlates to error IDs shown to user

  -- Timing
  total_duration_ms int,
  ai_first_call_ms  int,                       -- time for first OpenAI response
  ai_followup_ms    int,                       -- time for followup response (after tool results)

  -- Token usage (accumulated across all API rounds)
  prompt_tokens     int         DEFAULT 0,
  completion_tokens int         DEFAULT 0,
  total_tokens      int         DEFAULT 0,
  api_rounds        int         DEFAULT 0,     -- number of OpenAI API calls made

  -- Redaction applied
  redaction_rules_applied jsonb DEFAULT '[]',

  -- Metadata
  request_id      text,                        -- x-request-id header if present
  gateway_version text,                        -- software version for tracking deploys
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_esbmcp_chat_sessions_user
  ON esbmcp_chat_sessions (slack_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_esbmcp_chat_sessions_created
  ON esbmcp_chat_sessions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_esbmcp_chat_sessions_status
  ON esbmcp_chat_sessions (status)
  WHERE status != 'completed';


-- ---------------------------------------------------------------------------
-- 2. esbmcp_tool_executions
--    One row per tool invocation. A single chat session may produce multiple.
--    Foreign-keyed to the session for easy joins.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS esbmcp_tool_executions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid,                        -- correlates to esbmcp_chat_sessions (no FK — session written after tools)

  -- Origin (denormalized for fast querying without joins)
  slack_user_id   text,
  slack_team_id   text,
  slack_channel_id text,
  user_role       text,

  -- Tool identity
  tool_name       text        NOT NULL,
  domain          text,                        -- data-read, payments, profile-integrity, etc.
  risk_level      text,                        -- low, medium, high

  -- Invocation
  arguments_hash  text,                        -- sha256 of arguments (no PII in logs)
  arguments_keys  jsonb       DEFAULT '[]',    -- list of argument key names
  arguments_preview jsonb,                     -- sanitized subset (eid, round — never PII)

  -- Result
  ok              boolean     NOT NULL DEFAULT true,
  result_keys     jsonb       DEFAULT '[]',    -- top-level keys in result object
  result_row_count int,                        -- count of primary result array if applicable
  has_error_field boolean     DEFAULT false,   -- result contained an {error: ...} field

  -- Timing
  duration_ms     int,
  queued_at       timestamptz,                 -- when request hit gateway
  started_at      timestamptz,                 -- when handler began
  completed_at    timestamptz NOT NULL DEFAULT now(),

  -- Error details (null on success)
  error_message   text,
  error_code      text,
  error_stack     text,                        -- only in dev, stripped in prod

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_esbmcp_tool_executions_tool
  ON esbmcp_tool_executions (tool_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_esbmcp_tool_executions_session
  ON esbmcp_tool_executions (session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_esbmcp_tool_executions_user
  ON esbmcp_tool_executions (slack_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_esbmcp_tool_executions_errors
  ON esbmcp_tool_executions (created_at DESC)
  WHERE ok = false;

CREATE INDEX IF NOT EXISTS idx_esbmcp_tool_executions_domain
  ON esbmcp_tool_executions (domain, created_at DESC);


-- ---------------------------------------------------------------------------
-- 3. esbmcp_audit_log
--    Immutable append-only log of every security/policy decision.
--    Covers: identity checks, rate-limit hits, role denials, confirmation
--    gates, mutating tool usage, and administrative actions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS esbmcp_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid,                        -- correlates to esbmcp_chat_sessions (no FK — session written after tools)

  -- Origin
  slack_user_id   text,
  slack_team_id   text,
  slack_channel_id text,
  slack_username  text,
  user_role       text,
  ip_address      text,                        -- if available from proxy headers

  -- What happened
  event_type      text        NOT NULL,
  -- Enumerated types:
  --   identity_allowed, identity_denied
  --   rate_limit_ok, rate_limit_exceeded
  --   role_allowed, role_denied
  --   tool_executed, tool_failed
  --   confirmation_required, confirmation_satisfied
  --   mutating_tool_blocked, mutating_tool_executed
  --   session_started, session_completed, session_error

  -- Context
  tool_name       text,
  target_entity   text,                        -- e.g. "event:AB4001", "artist:uuid"
  detail          jsonb       DEFAULT '{}',    -- event-specific payload

  -- Metadata
  request_id      text,
  gateway_version text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_esbmcp_audit_log_user
  ON esbmcp_audit_log (slack_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_esbmcp_audit_log_event_type
  ON esbmcp_audit_log (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_esbmcp_audit_log_created
  ON esbmcp_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_esbmcp_audit_log_denials
  ON esbmcp_audit_log (created_at DESC)
  WHERE event_type IN ('identity_denied', 'role_denied', 'rate_limit_exceeded', 'mutating_tool_blocked');


-- ---------------------------------------------------------------------------
-- 4. esbmcp_tool_errors
--    Detailed error log for the feedback loop. Every SQL error, edge function
--    failure, or unexpected exception is captured with enough context to
--    diagnose and fix the tool without needing to reproduce.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS esbmcp_tool_errors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id    uuid,                        -- correlates to esbmcp_tool_executions (no FK)
  session_id      uuid,                        -- correlates to esbmcp_chat_sessions (no FK)

  -- Origin
  slack_user_id   text,
  user_role       text,

  -- Tool context
  tool_name       text        NOT NULL,
  domain          text,
  arguments_hash  text,
  arguments_preview jsonb,                     -- sanitized (eid, round only)

  -- Error detail
  error_type      text        NOT NULL,        -- sql_error, edge_function_error, validation_error, timeout, unknown
  error_message   text        NOT NULL,
  error_code      text,                        -- postgres error code (e.g. 42P01) or HTTP status
  error_detail    text,                        -- pg DETAIL field
  error_hint      text,                        -- pg HINT field
  error_position  text,                        -- character position in query
  error_stack     text,

  -- SQL context (for sql_error type)
  sql_query_preview text,                      -- first 500 chars of the query that failed (no params)

  -- Resolution tracking
  resolved        boolean     DEFAULT false,
  resolved_at     timestamptz,
  resolved_by     text,                        -- who fixed it
  resolution_note text,                        -- what was done

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_esbmcp_tool_errors_tool
  ON esbmcp_tool_errors (tool_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_esbmcp_tool_errors_unresolved
  ON esbmcp_tool_errors (created_at DESC)
  WHERE resolved = false;

CREATE INDEX IF NOT EXISTS idx_esbmcp_tool_errors_type
  ON esbmcp_tool_errors (error_type, created_at DESC);


-- ---------------------------------------------------------------------------
-- 5. esbmcp_feedback
--    Optional: employees can flag bad responses. Lightweight thumbs-up/down
--    plus optional comment. Linked to the session that produced the response.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS esbmcp_feedback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid        NOT NULL REFERENCES esbmcp_chat_sessions(id) ON DELETE CASCADE,

  slack_user_id   text        NOT NULL,
  rating          smallint    NOT NULL CHECK (rating IN (-1, 0, 1)),  -- -1 bad, 0 neutral, 1 good
  comment         text,

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_esbmcp_feedback_session
  ON esbmcp_feedback (session_id);

CREATE INDEX IF NOT EXISTS idx_esbmcp_feedback_negative
  ON esbmcp_feedback (created_at DESC)
  WHERE rating = -1;


-- ---------------------------------------------------------------------------
-- RLS: service-role only. These tables should NOT be readable by anon/users.
-- ---------------------------------------------------------------------------
ALTER TABLE esbmcp_chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE esbmcp_tool_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE esbmcp_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE esbmcp_tool_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE esbmcp_feedback ENABLE ROW LEVEL SECURITY;

-- No policies = deny all for anon/authenticated.
-- service_role bypasses RLS automatically.
