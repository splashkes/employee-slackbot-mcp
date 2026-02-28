import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  parse_boolean,
  parse_number,
  parse_list,
  parse_json_object
} from "@abcodex/shared/env_parsers.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const default_allowed_tools_file = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "config",
  "allowed-tools.json"
);

const service_config = {
  app: {
    node_env: process.env.NODE_ENV || "development",
    port: parse_number(process.env.PORT, 3000),
    log_level: process.env.LOG_LEVEL || "info"
  },
  slack: {
    bot_token: process.env.SLACK_BOT_TOKEN || "",
    signing_secret: process.env.SLACK_SIGNING_SECRET || "",
    use_socket_mode: parse_boolean(process.env.SLACK_USE_SOCKET_MODE, false),
    app_token: process.env.SLACK_APP_TOKEN || "",
    allowed_team_ids: parse_list(process.env.SLACK_ALLOWED_TEAM_IDS),
    allowed_channel_ids: parse_list(process.env.SLACK_ALLOWED_CHANNEL_IDS),
    allowed_user_ids: parse_list(process.env.SLACK_ALLOWED_USER_IDS),
    command_prefix: process.env.SLACK_COMMAND_PREFIX || "/ab",
    response_timeout_ms: parse_number(process.env.SLACK_RESPONSE_TIMEOUT_MS, 2500)
  },
  openai: {
    api_key: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    max_output_tokens: parse_number(process.env.OPENAI_MAX_OUTPUT_TOKENS, 1200),
    timeout_ms: parse_number(process.env.OPENAI_TIMEOUT_MS, 30000)
  },
  mcp: {
    gateway_url: process.env.MCP_GATEWAY_URL || "http://127.0.0.1:8081",
    gateway_auth_token: process.env.MCP_GATEWAY_AUTH_TOKEN || "",
    request_signing_secret: process.env.MCP_REQUEST_SIGNING_SECRET || "",
    timeout_ms: parse_number(process.env.MCP_TIMEOUT_MS, 20000),
    max_tool_calls_per_request: parse_number(process.env.MCP_MAX_TOOL_CALLS_PER_REQUEST, 4)
  },
  policy: {
    allowed_tools_file: process.env.ALLOWED_TOOLS_FILE || default_allowed_tools_file,
    require_confirmation_for_high_risk: parse_boolean(
      process.env.REQUIRE_CONFIRMATION_FOR_HIGH_RISK,
      true
    ),
    enable_mutating_tools: parse_boolean(process.env.ENABLE_MUTATING_TOOLS, false)
  },
  rbac: {
    mode: process.env.RBAC_MODE || "static",
    user_role_map: parse_json_object(process.env.RBAC_USER_MAP_JSON, {}),
    directory_api_base_url: process.env.DIRECTORY_API_BASE_URL || "",
    directory_api_token: process.env.DIRECTORY_API_TOKEN || "",
    directory_cache_ttl_sec: parse_number(process.env.DIRECTORY_CACHE_TTL_SEC, 300)
  },
  limits: {
    request_max_chars: parse_number(process.env.REQUEST_MAX_CHARS, 4000),
    response_max_chars: parse_number(process.env.RESPONSE_MAX_CHARS, 3500)
  },
  rate_limit: {
    user_window_sec: parse_number(process.env.RATE_LIMIT_USER_WINDOW_SEC, 60),
    user_max: parse_number(process.env.RATE_LIMIT_USER_MAX, 20),
    channel_window_sec: parse_number(process.env.RATE_LIMIT_CHANNEL_WINDOW_SEC, 60),
    channel_max: parse_number(process.env.RATE_LIMIT_CHANNEL_MAX, 80)
  },
  audit: {
    enabled: parse_boolean(process.env.AUDIT_ENABLED, true),
    destination: process.env.AUDIT_DESTINATION || "stdout",
    request_id_header: process.env.REQUEST_ID_HEADER || "x-request-id"
  }
};

function assert_required_config() {
  const missing_fields = [];

  if (!service_config.slack.bot_token) {
    missing_fields.push("SLACK_BOT_TOKEN");
  }

  if (!service_config.slack.signing_secret && !service_config.slack.use_socket_mode) {
    missing_fields.push("SLACK_SIGNING_SECRET");
  }

  if (service_config.slack.use_socket_mode && !service_config.slack.app_token) {
    missing_fields.push("SLACK_APP_TOKEN");
  }

  if (!service_config.openai.api_key) {
    missing_fields.push("OPENAI_API_KEY");
  }

  if (!service_config.mcp.gateway_auth_token) {
    missing_fields.push("MCP_GATEWAY_AUTH_TOKEN");
  }

  if (!service_config.mcp.request_signing_secret) {
    missing_fields.push("MCP_REQUEST_SIGNING_SECRET");
  }

  if (missing_fields.length > 0) {
    throw new Error(`Missing required environment variables: ${missing_fields.join(", ")}`);
  }
}

export { service_config, assert_required_config };
