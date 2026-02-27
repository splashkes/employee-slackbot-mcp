import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repo_root = path.resolve(__dirname, "..", "..");
const manifest_path = path.join(repo_root, "config", "allowed-tools.json");

test("allowed tools manifest exists", () => {
  assert.equal(fs.existsSync(manifest_path), true);
});

test("allowed tools manifest has valid top-level shape", () => {
  const raw_text = fs.readFileSync(manifest_path, "utf8");
  const payload = JSON.parse(raw_text);

  assert.equal(typeof payload.version, "string");
  assert.equal(Array.isArray(payload.tools), true);
  assert.equal(payload.tools.length > 0, true);
});

test("every tool definition includes required fields", () => {
  const raw_text = fs.readFileSync(manifest_path, "utf8");
  const payload = JSON.parse(raw_text);

  for (const tool_definition of payload.tools) {
    assert.equal(typeof tool_definition.tool_name, "string");
    assert.equal(typeof tool_definition.description, "string");
    assert.equal(["low", "medium", "high"].includes(tool_definition.risk_level), true);
    assert.equal(Array.isArray(tool_definition.allowed_roles), true);
    assert.equal(typeof tool_definition.requires_confirmation, "boolean");
    assert.equal(typeof tool_definition.max_calls_per_request, "number");
    assert.equal(typeof tool_definition.parameters_schema, "object");
  }
});
