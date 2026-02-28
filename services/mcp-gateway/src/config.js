import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { parse_boolean, parse_number } from "@abcodex/shared/env_parsers.js";

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
    port: parse_number(process.env.PORT, 8081),
    log_level: process.env.LOG_LEVEL || "info",
    request_max_body_bytes: parse_number(process.env.REQUEST_MAX_BODY_BYTES, 131072)
  },
  gateway: {
    auth_token: process.env.MCP_GATEWAY_AUTH_TOKEN || "",
    request_signing_secret: process.env.MCP_REQUEST_SIGNING_SECRET || "",
    request_signature_max_age_sec: parse_number(
      process.env.MCP_REQUEST_SIGNATURE_MAX_AGE_SEC,
      300
    ),
    allowed_tools_file: process.env.ALLOWED_TOOLS_FILE || default_allowed_tools_file,
    enable_mutating_tools: parse_boolean(process.env.ENABLE_MUTATING_TOOLS, false)
  }
};

function assert_required_config() {
  const missing_fields = [];

  if (!service_config.gateway.auth_token) {
    missing_fields.push("MCP_GATEWAY_AUTH_TOKEN");
  }

  if (!service_config.gateway.request_signing_secret) {
    missing_fields.push("MCP_REQUEST_SIGNING_SECRET");
  }

  if (missing_fields.length > 0) {
    throw new Error(`Missing required environment variables: ${missing_fields.join(", ")}`);
  }
}

export { service_config, assert_required_config };
