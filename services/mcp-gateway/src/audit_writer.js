// Writes structured audit/telemetry data to esbmcp_ Postgres tables.
// All writes are fire-and-forget (non-blocking) so they never slow down
// the request path. Failures are logged to stdout but do not propagate.

import { Logger } from "./logger.js";

const logger = new Logger(process.env.LOG_LEVEL || "info");

function create_audit_writer(sql) {
  if (!sql) {
    // Return a no-op writer when DB is not configured
    return {
      log_tool_execution: () => {},
      log_tool_error: () => {},
      log_audit_event: () => {}
    };
  }

  function safe_write(label, fn) {
    fn().catch((err) => {
      logger.warn("audit_write_failed", { label, error: err?.message });
    });
  }

  /**
   * Log a tool execution (success or failure).
   * @param {object} params
   * @param {string} params.session_id - chat session UUID (if known)
   * @param {string} params.slack_user_id
   * @param {string} params.slack_team_id
   * @param {string} params.slack_channel_id
   * @param {string} params.user_role
   * @param {string} params.tool_name
   * @param {string} params.domain
   * @param {string} params.risk_level
   * @param {string} params.arguments_hash
   * @param {string[]} params.arguments_keys
   * @param {object} params.arguments_preview - sanitized subset (eid, round, etc.)
   * @param {boolean} params.ok
   * @param {string[]} params.result_keys
   * @param {number} params.result_row_count
   * @param {boolean} params.has_error_field
   * @param {number} params.duration_ms
   * @param {string} params.error_message
   * @param {string} params.error_code
   * @param {string} params.error_stack
   */
  function log_tool_execution(params) {
    safe_write("tool_execution", async () => {
      await sql`
        INSERT INTO esbmcp_tool_executions (
          session_id, slack_user_id, slack_team_id, slack_channel_id,
          user_role, tool_name, domain, risk_level,
          arguments_hash, arguments_keys, arguments_preview,
          ok, result_keys, result_row_count, has_error_field,
          duration_ms, error_message, error_code, error_stack
        ) VALUES (
          ${params.session_id || null},
          ${params.slack_user_id || null},
          ${params.slack_team_id || null},
          ${params.slack_channel_id || null},
          ${params.user_role || null},
          ${params.tool_name},
          ${params.domain || null},
          ${params.risk_level || null},
          ${params.arguments_hash || null},
          ${JSON.stringify(params.arguments_keys || [])},
          ${JSON.stringify(params.arguments_preview || {})},
          ${params.ok !== false},
          ${JSON.stringify(params.result_keys || [])},
          ${params.result_row_count ?? null},
          ${params.has_error_field || false},
          ${params.duration_ms ?? null},
          ${params.error_message || null},
          ${params.error_code || null},
          ${params.ok === false && process.env.NODE_ENV === "development" ? (params.error_stack || null) : null}
        )
      `;
    });
  }

  /**
   * Log a detailed tool error for the feedback loop.
   */
  function log_tool_error(params) {
    safe_write("tool_error", async () => {
      await sql`
        INSERT INTO esbmcp_tool_errors (
          execution_id, session_id, slack_user_id, user_role,
          tool_name, domain, arguments_hash, arguments_preview,
          error_type, error_message, error_code, error_detail,
          error_hint, error_position, error_stack, sql_query_preview
        ) VALUES (
          ${params.execution_id || null},
          ${params.session_id || null},
          ${params.slack_user_id || null},
          ${params.user_role || null},
          ${params.tool_name},
          ${params.domain || null},
          ${params.arguments_hash || null},
          ${JSON.stringify(params.arguments_preview || {})},
          ${params.error_type || "unknown"},
          ${params.error_message},
          ${params.error_code || null},
          ${params.error_detail || null},
          ${params.error_hint || null},
          ${params.error_position || null},
          ${process.env.NODE_ENV === "development" ? (params.error_stack || null) : null},
          ${params.sql_query_preview ? params.sql_query_preview.slice(0, 500) : null}
        )
      `;
    });
  }

  /**
   * Log an audit event (policy decision, security event, etc.)
   */
  function log_audit_event(params) {
    safe_write("audit_event", async () => {
      await sql`
        INSERT INTO esbmcp_audit_log (
          session_id, slack_user_id, slack_team_id, slack_channel_id,
          slack_username, user_role, ip_address,
          event_type, tool_name, target_entity, detail,
          request_id, gateway_version
        ) VALUES (
          ${params.session_id || null},
          ${params.slack_user_id || null},
          ${params.slack_team_id || null},
          ${params.slack_channel_id || null},
          ${params.slack_username || null},
          ${params.user_role || null},
          ${params.ip_address || null},
          ${params.event_type},
          ${params.tool_name || null},
          ${params.target_entity || null},
          ${JSON.stringify(params.detail || {})},
          ${params.request_id || null},
          ${params.gateway_version || null}
        )
      `;
    });
  }

  return { log_tool_execution, log_tool_error, log_audit_event };
}

export { create_audit_writer };
