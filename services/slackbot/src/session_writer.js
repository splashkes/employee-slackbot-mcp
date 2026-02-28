// Writes chat sessions and audit events to esbmcp_ Postgres tables.
// All writes are fire-and-forget — failures log to stdout but never block Slack responses.

import crypto from "node:crypto";
import { Logger } from "./logger.js";

const logger = new Logger(process.env.LOG_LEVEL || "info");

function create_session_writer(sql) {
  if (!sql) {
    return {
      create_session_id: () => crypto.randomUUID(),
      write_session: () => {},
      write_audit_event: () => {},
      close: async () => {}
    };
  }

  function safe_write(label, fn) {
    fn().catch((err) => {
      logger.warn("session_write_failed", { label, error: err?.message });
    });
  }

  function create_session_id() {
    return crypto.randomUUID();
  }

  /**
   * Write a completed chat session.
   */
  function write_session(params) {
    safe_write("chat_session", async () => {
      // Hash system prompt to track prompt version changes
      const prompt_hash = params.system_prompt
        ? crypto.createHash("sha256").update(params.system_prompt).digest("hex").slice(0, 16)
        : null;

      await sql`
        INSERT INTO esbmcp_chat_sessions (
          id, slack_user_id, slack_team_id, slack_channel_id,
          slack_username, user_role, interaction_type,
          user_prompt, ai_model, ai_system_prompt_hash,
          ai_response, tools_called, tool_call_count,
          status, error_message, error_id,
          total_duration_ms, ai_first_call_ms, ai_followup_ms,
          prompt_tokens, completion_tokens, total_tokens, api_rounds,
          redaction_rules_applied, request_id, gateway_version
        ) VALUES (
          ${params.session_id},
          ${params.slack_user_id || null},
          ${params.slack_team_id || null},
          ${params.slack_channel_id || null},
          ${params.slack_username || null},
          ${params.user_role || null},
          ${params.interaction_type || "app_mention"},
          ${params.user_prompt},
          ${params.ai_model || null},
          ${prompt_hash},
          ${params.ai_response || null},
          ${JSON.stringify(params.tools_called || [])},
          ${params.tool_call_count || 0},
          ${params.status || "completed"},
          ${params.error_message || null},
          ${params.error_id || null},
          ${params.total_duration_ms ?? null},
          ${params.ai_first_call_ms ?? null},
          ${params.ai_followup_ms ?? null},
          ${params.prompt_tokens || 0},
          ${params.completion_tokens || 0},
          ${params.total_tokens || 0},
          ${params.api_rounds || 0},
          ${JSON.stringify(params.redaction_rules_applied || [])},
          ${params.request_id || null},
          ${params.gateway_version || "0.1.0"}
        )
      `;
    });
  }

  /**
   * Write an audit event from the slackbot side.
   */
  function write_audit_event(params) {
    safe_write("audit_event", async () => {
      await sql`
        INSERT INTO esbmcp_audit_log (
          session_id, slack_user_id, slack_team_id, slack_channel_id,
          slack_username, user_role,
          event_type, tool_name, target_entity, detail,
          request_id, gateway_version
        ) VALUES (
          ${params.session_id || null},
          ${params.slack_user_id || null},
          ${params.slack_team_id || null},
          ${params.slack_channel_id || null},
          ${params.slack_username || null},
          ${params.user_role || null},
          ${params.event_type},
          ${params.tool_name || null},
          ${params.target_entity || null},
          ${JSON.stringify(params.detail || {})},
          ${params.request_id || null},
          ${params.gateway_version || "0.1.0"}
        )
      `;
    });
  }

  async function close() {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      // ignore
    }
  }

  return { create_session_id, write_session, write_audit_event, close };
}

export { create_session_writer };
