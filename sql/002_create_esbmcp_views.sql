-- =============================================================================
-- Employee Slackbot MCP — Analytics Views & Retention
-- =============================================================================

-- ---------------------------------------------------------------------------
-- View: Tool usage stats (last 30 days)
-- "Which tools are used most, which fail most?"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW esbmcp_v_tool_usage_30d AS
SELECT
  tool_name,
  domain,
  COUNT(*)                                              AS total_calls,
  COUNT(*) FILTER (WHERE ok = true)                     AS success_count,
  COUNT(*) FILTER (WHERE ok = false)                    AS failure_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE ok = true) / NULLIF(COUNT(*), 0), 1) AS success_rate_pct,
  ROUND(AVG(duration_ms), 0)                            AS avg_duration_ms,
  ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms))::numeric, 0) AS p95_duration_ms,
  MAX(duration_ms)                                      AS max_duration_ms,
  COUNT(DISTINCT slack_user_id)                         AS unique_users,
  MIN(created_at)                                       AS first_call,
  MAX(created_at)                                       AS last_call
FROM esbmcp_tool_executions
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY tool_name, domain
ORDER BY total_calls DESC;


-- ---------------------------------------------------------------------------
-- View: User activity (last 30 days)
-- "Who's using the bot, how much, and what are they doing?"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW esbmcp_v_user_activity_30d AS
SELECT
  cs.slack_user_id,
  cs.slack_username,
  cs.user_role,
  COUNT(DISTINCT cs.id)                                 AS total_sessions,
  COUNT(DISTINCT te.id)                                 AS total_tool_calls,
  ROUND(AVG(cs.total_duration_ms), 0)                   AS avg_session_ms,
  COUNT(*) FILTER (WHERE cs.status = 'error')           AS error_sessions,
  COUNT(*) FILTER (WHERE cs.status = 'denied')          AS denied_sessions,
  array_agg(DISTINCT te.tool_name ORDER BY te.tool_name) FILTER (WHERE te.tool_name IS NOT NULL) AS tools_used,
  MIN(cs.created_at)                                    AS first_session,
  MAX(cs.created_at)                                    AS last_session
FROM esbmcp_chat_sessions cs
LEFT JOIN esbmcp_tool_executions te ON te.session_id = cs.id
WHERE cs.created_at > NOW() - INTERVAL '30 days'
GROUP BY cs.slack_user_id, cs.slack_username, cs.user_role
ORDER BY total_sessions DESC;


-- ---------------------------------------------------------------------------
-- View: Error digest (last 7 days)
-- "What's broken right now? Group recurring errors."
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW esbmcp_v_error_digest_7d AS
SELECT
  te.tool_name,
  te.domain,
  te.error_code,
  LEFT(te.error_message, 200)                           AS error_preview,
  COUNT(*)                                              AS occurrence_count,
  COUNT(DISTINCT te.slack_user_id)                      AS affected_users,
  MIN(te.created_at)                                    AS first_seen,
  MAX(te.created_at)                                    AS last_seen,
  COUNT(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM esbmcp_tool_errors err
      WHERE err.execution_id = te.id AND err.resolved = true
    )
  )                                                     AS resolved_count
FROM esbmcp_tool_executions te
WHERE te.ok = false
  AND te.created_at > NOW() - INTERVAL '7 days'
GROUP BY te.tool_name, te.domain, te.error_code, LEFT(te.error_message, 200)
ORDER BY occurrence_count DESC, last_seen DESC;


-- ---------------------------------------------------------------------------
-- View: Daily session volume
-- "How many interactions per day? Trend line."
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW esbmcp_v_daily_volume AS
SELECT
  DATE(created_at)                                      AS day,
  COUNT(*)                                              AS total_sessions,
  COUNT(*) FILTER (WHERE status = 'completed')          AS completed,
  COUNT(*) FILTER (WHERE status = 'error')              AS errors,
  COUNT(*) FILTER (WHERE status = 'denied')             AS denied,
  COUNT(*) FILTER (WHERE status = 'rate_limited')       AS rate_limited,
  COUNT(DISTINCT slack_user_id)                         AS unique_users,
  SUM(tool_call_count)                                  AS total_tool_calls,
  ROUND(AVG(total_duration_ms), 0)                      AS avg_duration_ms
FROM esbmcp_chat_sessions
WHERE created_at > NOW() - INTERVAL '90 days'
GROUP BY DATE(created_at)
ORDER BY day DESC;


-- ---------------------------------------------------------------------------
-- View: Hourly heatmap (last 7 days)
-- "When are people using the bot?"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW esbmcp_v_hourly_heatmap_7d AS
SELECT
  EXTRACT(DOW FROM created_at)::int                     AS day_of_week,  -- 0=Sun
  EXTRACT(HOUR FROM created_at)::int                    AS hour_utc,
  COUNT(*)                                              AS session_count
FROM esbmcp_chat_sessions
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY day_of_week, hour_utc
ORDER BY day_of_week, hour_utc;


-- ---------------------------------------------------------------------------
-- View: Audit denials summary (last 7 days)
-- "Security events — who got denied and why?"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW esbmcp_v_audit_denials_7d AS
SELECT
  event_type,
  slack_user_id,
  slack_username,
  user_role,
  tool_name,
  COUNT(*)                                              AS denial_count,
  MIN(created_at)                                       AS first_denial,
  MAX(created_at)                                       AS last_denial,
  jsonb_agg(DISTINCT detail->'reason') FILTER (WHERE detail ? 'reason') AS reasons
FROM esbmcp_audit_log
WHERE event_type IN ('identity_denied', 'role_denied', 'rate_limit_exceeded', 'mutating_tool_blocked')
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY event_type, slack_user_id, slack_username, user_role, tool_name
ORDER BY denial_count DESC;


-- ---------------------------------------------------------------------------
-- View: Unresolved errors
-- "Feedback loop: what still needs fixing?"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW esbmcp_v_unresolved_errors AS
SELECT
  err.id,
  err.tool_name,
  err.domain,
  err.error_type,
  err.error_message,
  err.error_code,
  err.error_hint,
  err.sql_query_preview,
  err.arguments_preview,
  err.slack_user_id,
  err.created_at,
  cs.user_prompt AS triggering_prompt
FROM esbmcp_tool_errors err
LEFT JOIN esbmcp_chat_sessions cs ON cs.id = err.session_id
WHERE err.resolved = false
ORDER BY err.created_at DESC;


-- ---------------------------------------------------------------------------
-- View: Negative feedback with context
-- "What are users complaining about?"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW esbmcp_v_negative_feedback AS
SELECT
  fb.id AS feedback_id,
  fb.slack_user_id,
  fb.rating,
  fb.comment,
  fb.created_at AS feedback_at,
  cs.user_prompt,
  cs.ai_response,
  cs.tools_called,
  cs.status AS session_status,
  cs.error_message AS session_error
FROM esbmcp_feedback fb
JOIN esbmcp_chat_sessions cs ON cs.id = fb.session_id
WHERE fb.rating = -1
ORDER BY fb.created_at DESC;


-- ---------------------------------------------------------------------------
-- Retention: function to clean up old data
-- Call periodically (e.g. weekly cron or pg_cron)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION esbmcp_cleanup_old_data(
  retention_days int DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff timestamptz := NOW() - (retention_days || ' days')::interval;
  deleted_sessions int;
  deleted_executions int;
  deleted_audit int;
  deleted_errors int;
  deleted_feedback int;
BEGIN
  -- Errors resolved more than retention_days ago
  DELETE FROM esbmcp_tool_errors
  WHERE resolved = true AND resolved_at < cutoff;
  GET DIAGNOSTICS deleted_errors = ROW_COUNT;

  -- Feedback older than retention
  DELETE FROM esbmcp_feedback
  WHERE created_at < cutoff;
  GET DIAGNOSTICS deleted_feedback = ROW_COUNT;

  -- Tool executions older than retention (cascade from sessions handled by SET NULL)
  DELETE FROM esbmcp_tool_executions
  WHERE created_at < cutoff;
  GET DIAGNOSTICS deleted_executions = ROW_COUNT;

  -- Audit log older than retention
  DELETE FROM esbmcp_audit_log
  WHERE created_at < cutoff;
  GET DIAGNOSTICS deleted_audit = ROW_COUNT;

  -- Sessions older than retention
  DELETE FROM esbmcp_chat_sessions
  WHERE created_at < cutoff;
  GET DIAGNOSTICS deleted_sessions = ROW_COUNT;

  RETURN jsonb_build_object(
    'cutoff', cutoff,
    'deleted_sessions', deleted_sessions,
    'deleted_executions', deleted_executions,
    'deleted_audit', deleted_audit,
    'deleted_errors', deleted_errors,
    'deleted_feedback', deleted_feedback
  );
END;
$$;
