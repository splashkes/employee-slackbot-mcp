import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { service_config, assert_required_config } from "./config.js";
import { Logger } from "./logger.js";
import {
  execute_tool_by_name,
  get_tool_definition_by_name,
  is_tool_allowed_for_role,
  load_allowed_tools_manifest,
  validate_tool_arguments
} from "./tools.js";

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
      throw new Error("request_body_too_large");
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
    throw new Error("invalid_json_body");
  }
}

function hash_arguments_payload(arguments_payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(arguments_payload || {}))
    .digest("hex");
}

function build_signature_payload({ timestamp_sec, method_name, path_name, body_text }) {
  return [String(timestamp_sec), method_name.toUpperCase(), path_name, body_text].join("\n");
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

function validate_request_signature({ request, request_url, request_body_text }) {
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

  const expected_signature = crypto
    .createHmac("sha256", service_config.gateway.request_signing_secret)
    .update(
      build_signature_payload({
        timestamp_sec,
        method_name: request.method || "POST",
        path_name: request_url.pathname,
        body_text: request_body_text
      })
    )
    .digest("hex");

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

  const server = http.createServer(async (request, response) => {
    const request_url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const path_segments = get_path_segments(request_url.pathname);

    if (request.method === "GET" && request_url.pathname === "/healthz") {
      send_text(response, 200, "ok");
      return;
    }

    if (request.method === "GET" && request_url.pathname === "/readyz") {
      send_text(response, 200, "ready");
      return;
    }

    if (!is_authorized(request)) {
      send_json(response, 401, {
        ok: false,
        error: "unauthorized"
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
          request_url,
          request_body_text: parsed_request.body_text
        });

        if (!signature_result.valid) {
          logger.warn("tool_request_signature_denied", {
            tool_name,
            reason: signature_result.reason
          });

          send_json(response, 401, {
            ok: false,
            error: "invalid_request_signature"
          });
          return;
        }

        const body_payload = parsed_request.body_payload;

        const arguments_payload = body_payload.arguments || {};
        const request_context = body_payload.request_context || {};
        const role_name = request_context.role || "";
        const confirmed = request_context.confirmed === true;

        const tool_definition = get_tool_definition_by_name(allowed_tools_manifest, tool_name);
        if (!tool_definition) {
          send_json(response, 404, {
            ok: false,
            error: "tool_not_found"
          });
          return;
        }

        if (!role_name) {
          send_json(response, 400, {
            ok: false,
            error: "missing_role"
          });
          return;
        }

        const validation_result = validate_tool_arguments(tool_definition, arguments_payload);
        if (!validation_result.valid) {
          send_json(response, 400, {
            ok: false,
            error: "invalid_arguments",
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
            error: "tool_not_allowed_for_role"
          });
          return;
        }

        if (tool_definition.requires_confirmation && !confirmed) {
          send_json(response, 409, {
            ok: false,
            error: "confirmation_required"
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
          arguments_hash: hash_arguments_payload(arguments_payload)
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

        if (error?.message === "request_body_too_large") {
          send_json(response, 413, {
            ok: false,
            error: "request_body_too_large"
          });
          return;
        }

        if (error?.message === "invalid_json_body") {
          send_json(response, 400, {
            ok: false,
            error: "invalid_json_body"
          });
          return;
        }

        send_json(response, 500, {
          ok: false,
          error: "internal_error"
        });
        return;
      }
    }

    send_json(response, 404, {
      ok: false,
      error: "route_not_found"
    });
  });

  server.listen(service_config.app.port, () => {
    logger.info("mcp_gateway_started", {
      port: service_config.app.port,
      allowed_tools_count: allowed_tools_manifest.tools.length
    });
  });
}

start_service().catch((error) => {
  logger.error("service_start_failed", {
    error_message: error?.message,
    stack: error?.stack
  });

  process.exit(1);
});
