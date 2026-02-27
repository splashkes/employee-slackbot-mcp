import fs from "node:fs";

function load_allowed_tools_manifest(file_path) {
  const raw_text = fs.readFileSync(file_path, "utf8");
  const manifest = JSON.parse(raw_text);

  if (!Array.isArray(manifest.tools)) {
    throw new Error("Invalid allowed tools manifest: expected tools array");
  }

  return manifest;
}

function get_tool_definition_by_name(manifest, tool_name) {
  return manifest.tools.find((tool_definition) => tool_definition.tool_name === tool_name);
}

function is_tool_allowed_for_role(tool_definition, role_name, enable_mutating_tools) {
  if (!tool_definition) {
    return false;
  }

  const role_allowed = (tool_definition.allowed_roles || []).includes(role_name);
  if (!role_allowed) {
    return false;
  }

  if (tool_definition.risk_level === "high" && !enable_mutating_tools) {
    return false;
  }

  return true;
}

async function execute_tool_by_name(tool_name, arguments_payload, service_config) {
  if (tool_name === "get_event_details") {
    return {
      eid: arguments_payload.eid,
      name: `Event ${arguments_payload.eid}`,
      event_start_datetime: "2026-03-14T19:00:00Z",
      venue: "TBD",
      currency: "USD",
      source: "stub"
    };
  }

  if (tool_name === "get_live_voting_status") {
    return {
      eid: arguments_payload.eid,
      round: arguments_payload.round || 1,
      raw_vote_count: 0,
      weighted_vote_total: 0,
      source: "stub"
    };
  }

  if (tool_name === "get_auction_status") {
    return {
      eid: arguments_payload.eid,
      total_artworks: 0,
      active_auctions: 0,
      closed_auctions: 0,
      source: "stub"
    };
  }

  if (tool_name === "get_payment_summary") {
    return {
      eid: arguments_payload.eid,
      payments_pending: 0,
      payments_processing: 0,
      payments_paid: 0,
      source: "stub"
    };
  }

  if (tool_name === "process_artist_payment") {
    if (!service_config.gateway.enable_mutating_tools) {
      throw new Error("Mutating tools are disabled by policy");
    }

    return {
      eid: arguments_payload.eid,
      artist_profile_id: arguments_payload.artist_profile_id,
      amount: arguments_payload.amount,
      currency: arguments_payload.currency,
      status: "queued",
      source: "stub"
    };
  }

  throw new Error(`Unknown tool: ${tool_name}`);
}

export {
  execute_tool_by_name,
  get_tool_definition_by_name,
  is_tool_allowed_for_role,
  load_allowed_tools_manifest
};
