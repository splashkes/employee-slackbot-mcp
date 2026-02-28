import http from "node:http";
import crypto from "node:crypto";
import { service_config, assert_required_config } from "./config.js";
import { Logger } from "./logger.js";
import {
  build_tool_index,
  execute_tool_by_name,
  get_tool_definition_by_name,
  is_tool_allowed_for_role,
  load_allowed_tools_manifest,
  validate_tool_arguments
} from "./tools.js";
import { build_canonical_payload, compute_signature, hash_json_payload } from "@abcodex/shared/signing.js";
import { MCP_ERROR_CODES } from "@abcodex/shared/constants.js";
import { create_db_client, close_db_client } from "./db.js";
import { create_edge_client } from "./edge_client.js";
import { create_audit_writer } from "./audit_writer.js";
import { create_chart_scheduler } from "./chart_scheduler.js";
import { create_slack_poster } from "./slack_poster.js";

const logger = new Logger(service_config.app.log_level);

function send_json(response, status_code, payload) {
  const response_text = JSON.stringify(payload);

  response.writeHead(status_code, {
    "content-type": "application/json"
  });
  response.end(response_text);
}

function send_text(response, status_code, payload_text) {
  response.writeHead(status_code, {
    "content-type": "text/plain; charset=utf-8"
  });
  response.end(payload_text);
}

function is_authorized(request) {
  const auth_header = request.headers.authorization || "";
  return auth_header === `Bearer ${service_config.gateway.auth_token}`;
}

async function parse_json_body(request, max_body_bytes) {
  const chunks = [];
  let total_bytes = 0;

  for await (const chunk of request) {
    total_bytes += chunk.length;

    if (total_bytes > max_body_bytes) {
      throw new Error(MCP_ERROR_CODES.REQUEST_BODY_TOO_LARGE);
    }

    chunks.push(chunk);
  }

  const body_text = Buffer.concat(chunks).toString("utf8");
  if (!body_text) {
    return {
      body_payload: {},
      body_text: ""
    };
  }

  try {
    return {
      body_payload: JSON.parse(body_text),
      body_text
    };
  } catch (_error) {
    throw new Error(MCP_ERROR_CODES.INVALID_JSON_BODY);
  }
}

function compare_hex_signatures(expected_signature, actual_signature) {
  if (
    typeof expected_signature !== "string" ||
    typeof actual_signature !== "string" ||
    expected_signature.length !== actual_signature.length
  ) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected_signature, "hex"),
      Buffer.from(actual_signature, "hex")
    );
  } catch (_error) {
    return false;
  }
}

function validate_request_signature({ request, request_pathname, request_body_text }) {
  const timestamp_header = request.headers["x-mcp-timestamp"];
  const signature_header = request.headers["x-mcp-signature"];
  const signature_version = request.headers["x-mcp-signature-version"];

  if (
    typeof timestamp_header !== "string" ||
    typeof signature_header !== "string" ||
    signature_header.length !== 64
  ) {
    return {
      valid: false,
      reason: "missing_or_invalid_signature_headers"
    };
  }

  if (signature_version && signature_version !== "v1") {
    return {
      valid: false,
      reason: "unsupported_signature_version"
    };
  }

  const timestamp_sec = Number(timestamp_header);

  if (!Number.isInteger(timestamp_sec)) {
    return {
      valid: false,
      reason: "invalid_signature_timestamp"
    };
  }

  const now_sec = Math.floor(Date.now() / 1000);
  const age_sec = Math.abs(now_sec - timestamp_sec);

  if (age_sec > service_config.gateway.request_signature_max_age_sec) {
    return {
      valid: false,
      reason: "signature_expired"
    };
  }

  const canonical_payload = build_canonical_payload({
    timestamp_sec,
    method: request.method || "POST",
    pathname: request_pathname,
    body_text: request_body_text
  });
  const expected_signature = compute_signature(
    service_config.gateway.request_signing_secret,
    canonical_payload
  );

  if (!compare_hex_signatures(expected_signature, signature_header)) {
    return {
      valid: false,
      reason: "invalid_signature"
    };
  }

  return {
    valid: true,
    reason: "ok"
  };
}

function get_path_segments(url_pathname) {
  return url_pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function start_service() {
  assert_required_config();
  const allowed_tools_manifest = load_allowed_tools_manifest(
    service_config.gateway.allowed_tools_file
  );
  const tool_index = build_tool_index(allowed_tools_manifest);

  // Initialize database client
  const sql = create_db_client(service_config.db.url);
  if (sql) {
    logger.info("db_connected", { has_db: true });
  } else {
    logger.warn("db_not_configured", { message: "Tools requiring DB will fail. Set SUPABASE_DB_URL." });
  }

  // Initialize edge function client
  const edge = create_edge_client({
    supabase_url: service_config.edge.supabase_url,
    service_role_key: service_config.edge.service_role_key
  });
  if (edge) {
    logger.info("edge_client_connected", { has_edge: true });
  } else {
    logger.warn("edge_client_not_configured", { message: "Tools requiring Edge Functions will fail. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY." });
  }

  // Initialize audit writer (writes to esbmcp_ tables, fire-and-forget)
  const audit = create_audit_writer(sql);

  const server = http.createServer(async (request, response) => {
    const raw_url = request.url || "/";

    // Fast path for health probes — avoid URL parsing overhead
    if (request.method === "GET") {
      if (raw_url === "/healthz") {
        send_text(response, 200, "ok");
        return;
      }
      if (raw_url === "/readyz") {
        send_text(response, 200, "ready");
        return;
      }
    }

    const request_url = new URL(raw_url, `http://${request.headers.host || "localhost"}`);
    const path_segments = get_path_segments(request_url.pathname);

    if (!is_authorized(request)) {
      send_json(response, 401, {
        ok: false,
        error: MCP_ERROR_CODES.UNAUTHORIZED
      });
      return;
    }

    if (request.method === "GET" && request_url.pathname === "/v1/tools") {
      send_json(response, 200, {
        ok: true,
        tools: allowed_tools_manifest.tools.map((tool_definition) => ({
          tool_name: tool_definition.tool_name,
          description: tool_definition.description,
          risk_level: tool_definition.risk_level,
          allowed_roles: tool_definition.allowed_roles,
          domain: tool_definition.domain
        }))
      });
      return;
    }

    if (
      request.method === "POST" &&
      path_segments.length === 3 &&
      path_segments[0] === "v1" &&
      path_segments[1] === "tools"
    ) {
      const tool_name = decodeURIComponent(path_segments[2]);
      const request_start_ms = Date.now();
      const safe_preview_keys = ["eid", "round", "group_by", "search_by", "status", "hours_back", "audience_filter", "table_name", "limit", "title", "description", "priority", "related_eid", "force", "cadence", "action", "include_comparators", "slack_channel_id", "force_rescore"];

      let parsed_request = null;
      let tool_definition = null;
      try {
        parsed_request = await parse_json_body(
          request,
          service_config.app.request_max_body_bytes
        );
        const signature_result = validate_request_signature({
          request,
          request_pathname: request_url.pathname,
          request_body_text: parsed_request.body_text
        });

        if (!signature_result.valid) {
          logger.warn("tool_request_signature_denied", {
            tool_name,
            reason: signature_result.reason
          });

          send_json(response, 401, {
            ok: false,
            error: MCP_ERROR_CODES.INVALID_REQUEST_SIGNATURE
          });
          return;
        }

        const body_payload = parsed_request.body_payload;

        const arguments_payload = body_payload.arguments || {};
        const request_context = body_payload.request_context || {};
        const role_name = request_context.role || "";
        const confirmed = request_context.confirmed === true;
        const session_id = request_context.session_id || null;

        // Build origin context (reused across all audit calls)
        const origin = {
          session_id,
          slack_user_id: request_context.user_id || null,
          slack_team_id: request_context.team_id || null,
          slack_channel_id: request_context.channel_id || null,
          slack_username: request_context.username || null,
          user_role: role_name,
          ip_address: request.headers["x-forwarded-for"] || request.socket?.remoteAddress || null,
          request_id: request.headers["x-request-id"] || null,
          gateway_version: service_config.app.version || "0.1.0"
        };

        // Build a PII-safe preview of arguments (only safe keys)
        const arguments_preview = {};
        for (const key of safe_preview_keys) {
          if (key in arguments_payload) arguments_preview[key] = arguments_payload[key];
        }

        tool_definition = get_tool_definition_by_name(tool_index, tool_name);
        if (!tool_definition) {
          audit.log_audit_event({ ...origin, event_type: "tool_not_found", tool_name });
          send_json(response, 404, {
            ok: false,
            error: MCP_ERROR_CODES.TOOL_NOT_FOUND
          });
          return;
        }

        if (!role_name) {
          audit.log_audit_event({ ...origin, event_type: "missing_role", tool_name });
          send_json(response, 400, {
            ok: false,
            error: MCP_ERROR_CODES.MISSING_ROLE
          });
          return;
        }

        const validation_result = validate_tool_arguments(tool_definition, arguments_payload);
        if (!validation_result.valid) {
          audit.log_audit_event({
            ...origin, event_type: "invalid_arguments", tool_name,
            detail: { errors: validation_result.errors }
          });
          send_json(response, 400, {
            ok: false,
            error: MCP_ERROR_CODES.INVALID_ARGUMENTS,
            details: validation_result.errors
          });
          return;
        }

        const role_allowed = is_tool_allowed_for_role(
          tool_definition,
          role_name,
          service_config.gateway.enable_mutating_tools
        );

        if (!role_allowed) {
          const is_mutating_block = tool_definition.risk_level === "high" && !service_config.gateway.enable_mutating_tools;
          audit.log_audit_event({
            ...origin,
            event_type: is_mutating_block ? "mutating_tool_blocked" : "role_denied",
            tool_name,
            detail: { role: role_name, risk_level: tool_definition.risk_level }
          });
          send_json(response, 403, {
            ok: false,
            error: MCP_ERROR_CODES.TOOL_NOT_ALLOWED_FOR_ROLE
          });
          return;
        }

        audit.log_audit_event({ ...origin, event_type: "role_allowed", tool_name });

        if (tool_definition.requires_confirmation && !confirmed) {
          audit.log_audit_event({ ...origin, event_type: "confirmation_required", tool_name });
          send_json(response, 409, {
            ok: false,
            error: MCP_ERROR_CODES.CONFIRMATION_REQUIRED
          });
          return;
        }

        if (tool_definition.requires_confirmation && confirmed) {
          audit.log_audit_event({ ...origin, event_type: "confirmation_satisfied", tool_name });
        }

        const tool_result = await execute_tool_by_name(
          tool_name,
          arguments_payload,
          service_config,
          { sql, edge },
          request_context
        );

        const duration_ms = Date.now() - request_start_ms;
        const args_hash = hash_json_payload(arguments_payload);
        const result_keys = tool_result ? Object.keys(tool_result) : [];
        const has_error_field = !!tool_result?.error;

        // Estimate result row count from common array fields
        let result_row_count = null;
        for (const key of result_keys) {
          if (Array.isArray(tool_result[key])) {
            result_row_count = (result_row_count || 0) + tool_result[key].length;
          }
        }

        logger.info("tool_executed", {
          tool_name, role_name,
          domain: tool_definition.domain || null,
          duration_ms,
          requester_user_id: origin.slack_user_id,
          arguments_preview,
          result_keys, has_error: has_error_field
        });

        // Write to esbmcp_tool_executions
        audit.log_tool_execution({
          ...origin,
          tool_name,
          domain: tool_definition.domain || null,
          risk_level: tool_definition.risk_level || null,
          arguments_hash: args_hash,
          arguments_keys: Object.keys(arguments_payload),
          arguments_preview,
          ok: true,
          result_keys,
          result_row_count,
          has_error_field,
          duration_ms
        });

        audit.log_audit_event({
          ...origin, event_type: "tool_executed", tool_name,
          target_entity: arguments_preview.eid ? `event:${arguments_preview.eid}` : null,
          detail: { duration_ms, has_error_field }
        });

        send_json(response, 200, {
          ok: true,
          tool: tool_name,
          result: tool_result
        });
        return;
      } catch (error) {
        const duration_ms = Date.now() - request_start_ms;

        // Extract postgres-specific error fields
        const pg_code = error?.code;
        const pg_detail = error?.detail;
        const pg_hint = error?.hint;
        const pg_position = error?.position;
        const is_sql_error = typeof pg_code === "string" && pg_code.length === 5;
        const error_type = is_sql_error ? "sql_error"
          : error?.status ? "edge_function_error"
          : error?.message?.includes("timeout") ? "timeout"
          : "unknown";

        logger.error("tool_execution_failed", {
          tool_name, duration_ms,
          error_type,
          error_message: error?.message,
          error_code: pg_code,
          stack: error?.stack
        });

        // Try to extract origin from the body we already parsed
        const fallback_context = parsed_request?.body_payload?.request_context || {};
        const fail_origin = {
          session_id: fallback_context.session_id || null,
          slack_user_id: fallback_context.user_id || null,
          slack_team_id: fallback_context.team_id || null,
          slack_channel_id: fallback_context.channel_id || null,
          user_role: fallback_context.role || null,
          request_id: request.headers["x-request-id"] || null
        };

        // Build safe arguments preview (must match safe_preview_keys above)
        const fail_args = parsed_request?.body_payload?.arguments || {};
        const fail_preview = {};
        for (const k of safe_preview_keys) {
          if (k in fail_args) fail_preview[k] = fail_args[k];
        }

        // Write to esbmcp_tool_executions (failure)
        audit.log_tool_execution({
          ...fail_origin,
          tool_name,
          domain: tool_definition?.domain || null,
          risk_level: tool_definition?.risk_level || null,
          arguments_hash: hash_json_payload(fail_args),
          arguments_keys: Object.keys(fail_args),
          arguments_preview: fail_preview,
          ok: false,
          duration_ms,
          error_message: error?.message,
          error_code: pg_code || null,
          error_stack: error?.stack
        });

        // Write detailed error to esbmcp_tool_errors
        audit.log_tool_error({
          ...fail_origin,
          tool_name,
          domain: tool_definition?.domain || null,
          arguments_hash: hash_json_payload(fail_args),
          arguments_preview: fail_preview,
          error_type,
          error_message: error?.message || "Unknown error",
          error_code: pg_code || (error?.status ? String(error.status) : null),
          error_detail: pg_detail || null,
          error_hint: pg_hint || null,
          error_position: pg_position || null,
          error_stack: error?.stack,
          sql_query_preview: error?.query || null
        });

        audit.log_audit_event({
          ...fail_origin, event_type: "tool_failed", tool_name,
          detail: { error_type, error_message: error?.message, duration_ms }
        });

        if (error?.message === MCP_ERROR_CODES.REQUEST_BODY_TOO_LARGE) {
          send_json(response, 413, {
            ok: false,
            error: MCP_ERROR_CODES.REQUEST_BODY_TOO_LARGE
          });
          return;
        }

        if (error?.message === MCP_ERROR_CODES.INVALID_JSON_BODY) {
          send_json(response, 400, {
            ok: false,
            error: MCP_ERROR_CODES.INVALID_JSON_BODY
          });
          return;
        }

        // Return structured error for tool failures (SQL errors, edge function errors)
        send_json(response, 500, {
          ok: false,
          error: MCP_ERROR_CODES.INTERNAL_ERROR,
          detail: service_config.app.node_env === "development" ? error?.message : undefined
        });
        return;
      }
    }

    send_json(response, 404, {
      ok: false,
      error: MCP_ERROR_CODES.ROUTE_NOT_FOUND
    });
  });

  // Initialize chart scheduler
  const slack_poster = create_slack_poster(service_config.slack.bot_token);
  const chart_scheduler = create_chart_scheduler({
    sql,
    config: service_config,
    slack_poster,
    edge
  });

  server.listen(service_config.app.port, () => {
    logger.info("mcp_gateway_started", {
      port: service_config.app.port,
      allowed_tools_count: allowed_tools_manifest.tools.length,
      has_db: !!sql,
      has_edge: !!edge,
      has_chart_scheduler: !!slack_poster
    });

    // Start chart scheduler after server is listening
    chart_scheduler.start();
  });

  const SHUTDOWN_TIMEOUT_MS = 10_000;

  const shutdown = async () => {
    logger.info("shutdown_initiated", { signal: "SIGTERM" });

    chart_scheduler.stop();

    server.close(() => {
      logger.info("http_server_closed");
    });

    try {
      await close_db_client();
    } catch (error) {
      logger.warn("db_close_error", { error_message: error?.message });
    }

    logger.info("shutdown_complete");
    process.exit(0);
  };

  const force_shutdown = () => {
    setTimeout(() => {
      logger.warn("shutdown_timeout", { timeout_ms: SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  };

  process.on("SIGTERM", () => { force_shutdown(); shutdown(); });
  process.on("SIGINT", () => { force_shutdown(); shutdown(); });
}

start_service().catch((error) => {
  logger.error("service_start_failed", {
    error_message: error?.message,
    stack: error?.stack
  });

  process.exit(1);
});
