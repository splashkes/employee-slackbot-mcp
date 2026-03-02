// Shared validation helpers used across MCP gateway tool modules

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a value is a proper UUID. Returns an error object if invalid, null if valid.
 * Callers should `if (err) return err;` on the result.
 */
function require_uuid(value, field_name) {
  if (!value || !UUID_RE.test(value)) {
    return { error: `${field_name} must be a valid UUID. Use lookup_artist_profile or lookup_person first to get the real ID.` };
  }
  return null;
}

export { UUID_RE, require_uuid };
