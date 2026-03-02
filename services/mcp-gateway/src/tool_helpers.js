// Gateway-specific tool helpers — depend on sql / service_config / edge

/**
 * Guard for write operations. Throws if mutating tools are disabled by policy.
 */
function require_mutating(service_config) {
  if (!service_config.gateway.enable_mutating_tools) {
    throw new Error("Mutating tools are disabled by policy");
  }
}

/**
 * Guard for edge function availability. Throws if edge client is not configured.
 */
function require_edge(edge) {
  if (!edge) throw new Error("Edge function client not configured");
}

/**
 * Validate that an event exists by EID. Returns { id, eid } or an error object.
 * Usage: `const ev = await require_event(eid, sql); if (ev.error) return ev;`
 */
async function require_event(eid, sql) {
  const rows = await sql`SELECT id, eid FROM events WHERE eid = ${eid} LIMIT 1`;
  if (rows.length === 0) return { error: `No event found for eid=${eid}` };
  return rows[0];
}

export { require_mutating, require_edge, require_event };
