import http from "node:http";
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

import crypto from "node:crypto";

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
          risk_level: tool_definition.risk_level,
          allowed_roles: tool_definition.allowed_roles
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

      try {
        const parsed_request = await parse_json_body(
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

        const tool_definition = get_tool_definition_by_name(tool_index, tool_name);
        if (!tool_definition) {
          send_json(response, 404, {
            ok: false,
            error: MCP_ERROR_CODES.TOOL_NOT_FOUND
          });
          return;
        }

        if (!role_name) {
          send_json(response, 400, {
            ok: false,
            error: MCP_ERROR_CODES.MISSING_ROLE
          });
          return;
        }

        const validation_result = validate_tool_arguments(tool_definition, arguments_payload);
        if (!validation_result.valid) {
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
          send_json(response, 403, {
            ok: false,
            error: MCP_ERROR_CODES.TOOL_NOT_ALLOWED_FOR_ROLE
          });
          return;
        }

        if (tool_definition.requires_confirmation && !confirmed) {
          send_json(response, 409, {
            ok: false,
            error: MCP_ERROR_CODES.CONFIRMATION_REQUIRED
          });
          return;
        }

        const tool_result = await execute_tool_by_name(
          tool_name,
          arguments_payload,
          service_config
        );

        logger.info("tool_executed", {
          tool_name,
          role_name,
          requester_user_id: request_context.user_id || null,
          requester_team_id: request_context.team_id || null,
          requester_channel_id: request_context.channel_id || null,
          arguments_hash: hash_json_payload(arguments_payload)
        });

        send_json(response, 200, {
          ok: true,
          tool: tool_name,
          result: tool_result
        });
        return;
      } catch (error) {
        logger.error("tool_execution_failed", {
          tool_name,
          error_message: error?.message,
          stack: error?.stack
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

        send_json(response, 500, {
          ok: false,
          error: MCP_ERROR_CODES.INTERNAL_ERROR
        });
        return;
      }
    }

    send_json(response, 404, {
      ok: false,
      error: MCP_ERROR_CODES.ROUTE_NOT_FOUND
    });
  });

  server.listen(service_config.app.port, () => {
    logger.info("mcp_gateway_started", {
      port: service_config.app.port,
      allowed_tools_count: allowed_tools_manifest.tools.length
    });
  });

  const SHUTDOWN_TIMEOUT_MS = 10_000;

  const shutdown = () => {
    logger.info("shutdown_initiated", { signal: "SIGTERM" });

    server.close(() => {
      logger.info("shutdown_complete");
      process.exit(0);
    });

    setTimeout(() => {
      logger.warn("shutdown_timeout", { timeout_ms: SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start_service().catch((error) => {
  logger.error("service_start_failed", {
    error_message: error?.message,
    stack: error?.stack
  });

  process.exit(1);
});
