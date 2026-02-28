import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const envTemplatePath = path.join(repoRoot, ".env.example");

const requiredKeys = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "OPENAI_API_KEY",
  "MCP_GATEWAY_URL",
  "MCP_GATEWAY_AUTH_TOKEN",
  "MCP_REQUEST_SIGNING_SECRET",
  "ALLOWED_TOOLS_FILE",
  "RBAC_MODE",
  "AUDIT_ENABLED",
];

test(".env.example exists", () => {
  assert.equal(fs.existsSync(envTemplatePath), true);
});

test(".env.example contains required key placeholders", () => {
  const text = fs.readFileSync(envTemplatePath, "utf8");

  for (const key of requiredKeys) {
    assert.match(
      text,
      new RegExp(`^${key}=`, "m"),
      `Missing required key in .env.example: ${key}`
    );
  }
});
