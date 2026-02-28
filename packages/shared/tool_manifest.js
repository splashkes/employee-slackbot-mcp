import fs from "node:fs";
import { RISK_LEVELS } from "./constants.js";

function load_allowed_tools_manifest(file_path) {
  const raw_text = fs.readFileSync(file_path, "utf8");
  const manifest = JSON.parse(raw_text);

  if (!Array.isArray(manifest.tools)) {
    throw new Error("Invalid allowed tools manifest: expected tools array");
  }

  return manifest;
}

function build_tool_index(manifest) {
  const index = new Map();
  for (const tool_definition of manifest.tools) {
    index.set(tool_definition.tool_name, tool_definition);
  }
  return index;
}

function get_tool_definition_by_name(tool_index, tool_name) {
  return tool_index.get(tool_name) || null;
}

function is_tool_allowed_for_role(tool_definition, role_name, enable_mutating_tools) {
  if (!tool_definition) {
    return false;
  }

  const role_allowed = (tool_definition.allowed_roles || []).includes(role_name);
  if (!role_allowed) {
    return false;
  }

  if (tool_definition.risk_level === RISK_LEVELS.HIGH && !enable_mutating_tools) {
    return false;
  }

  return true;
}

function get_allowed_tools_for_role(manifest, role_name, enable_mutating_tools) {
  return manifest.tools.filter((tool_definition) =>
    is_tool_allowed_for_role(tool_definition, role_name, enable_mutating_tools)
  );
}

export {
  build_tool_index,
  get_allowed_tools_for_role,
  get_tool_definition_by_name,
  is_tool_allowed_for_role,
  load_allowed_tools_manifest
};
