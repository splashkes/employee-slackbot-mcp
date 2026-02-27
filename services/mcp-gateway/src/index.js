import http from "node:http";
import { URL } from "node:url";
import { service_config, assert_required_config } from "./config.js";
import { Logger } from "./logger.js";
import {
  execute_tool_by_name,
  get_tool_definition_by_name,
  is_tool_allowed_for_role,
  load_allowed_tools_manifest
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
    return {};
  }

  try {
    return JSON.parse(body_text);
  } catch (_error) {
    throw new Error("invalid_json_body");
  }
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
        const body_payload = await parse_json_body(
          request,
          service_config.app.request_max_body_bytes
        );

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
          request_context
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

        send_json(response, 500, {
          ok: false,
          error: error?.message || "internal_error"
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
