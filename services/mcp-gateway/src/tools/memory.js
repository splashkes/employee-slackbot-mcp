// memory domain — 4 tools for per-channel and per-tool contextual memory
// Versioned storage with rollback support.

const CHANNEL_TEMPLATE = `## Topics

## Problems & Solutions

## People & Names

## Open Items
`;

const TOOL_TEMPLATE = `## Common Patterns

## Known Issues

## Parameter Hints
`;

const MEMORY_UPDATE_INSTRUCTIONS_CHANNEL = [
  "<!-- MEMORY INSTRUCTIONS (do not remove):",
  "  Keep total under {TOKEN_BUDGET} characters.",
  "  Only store durable facts — not one-off questions or transient data.",
  "  Prefer updating existing entries over creating duplicates.",
  "  Keep names with role and context.",
  "  Keep unresolved issues explicit under Open Items.",
  "  Each entry: one concise line with (Mon YYYY) date suffix.",
  "  Drop entries not referenced in 30+ days when space is needed.",
  "-->"
].join("\n");

const MEMORY_UPDATE_INSTRUCTIONS_TOOL = [
  "<!-- MEMORY INSTRUCTIONS (do not remove):",
  "  Keep total under {TOKEN_BUDGET} characters.",
  "  Only store patterns that recur or errors that have workarounds.",
  "  Do NOT store: normal successful calls, one-off errors, transient state.",
  "  Each entry: one concise line with (Mon YYYY) date suffix.",
  "-->"
].join("\n");

function build_empty_memory(scope_type, token_budget) {
  const instructions = scope_type === "tool"
    ? MEMORY_UPDATE_INSTRUCTIONS_TOOL.replace("{TOKEN_BUDGET}", token_budget)
    : MEMORY_UPDATE_INSTRUCTIONS_CHANNEL.replace("{TOKEN_BUDGET}", token_budget);
  const template = scope_type === "tool" ? TOOL_TEMPLATE : CHANNEL_TEMPLATE;
  return `${instructions}\n\n${template}`;
}

function parse_memory_sections(content_md) {
  const sections = {};
  let current_section = null;
  for (const line of content_md.split("\n")) {
    const heading_match = line.match(/^##\s+(.+)/);
    if (heading_match) {
      current_section = heading_match[1].trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
      sections[current_section] = [];
      continue;
    }
    if (current_section && line.trim()) {
      // Skip HTML comments (instructions)
      if (line.trim().startsWith("<!--") || line.trim().startsWith("-->") || line.trim().startsWith("  ")) {
        if (line.includes("<!--") || line.includes("-->")) continue;
      }
      const item = line.replace(/^[\s•\-*]+/, "").trim();
      if (item && !item.startsWith("<!--")) {
        sections[current_section].push(item);
      }
    }
  }
  return sections;
}


// ─── Tool Functions ──────────────────────────────────────────────────────────

async function get_memory({ scope_type, scope_id }, sql) {
  if (!scope_type || !scope_id) {
    return { error: "scope_type and scope_id are required" };
  }

  // Get head
  const heads = await sql`
    SELECT * FROM esbmcp_memory_heads
    WHERE scope_type = ${scope_type} AND scope_id = ${scope_id}
    LIMIT 1
  `;

  if (heads.length === 0 || heads[0].current_version === 0) {
    const budget = scope_type === "tool" ? 500 : 2200;
    return {
      scope_type, scope_id,
      version: 0,
      content_md: build_empty_memory(scope_type, budget),
      content_json: {},
      is_empty: true,
      token_budget: budget
    };
  }

  const head = heads[0];

  const versions = await sql`
    SELECT content_md, content_json, version_no, change_summary, created_at
    FROM esbmcp_memory_versions
    WHERE scope_type = ${scope_type}
      AND scope_id = ${scope_id}
      AND version_no = ${head.current_version}
    LIMIT 1
  `;

  if (versions.length === 0) {
    return {
      scope_type, scope_id,
      version: head.current_version,
      content_md: build_empty_memory(scope_type, head.token_budget),
      content_json: {},
      is_empty: true,
      token_budget: head.token_budget,
      error: "Version record missing — memory may need reset"
    };
  }

  const v = versions[0];
  return {
    scope_type, scope_id,
    version: v.version_no,
    content_md: v.content_md,
    content_json: v.content_json || parse_memory_sections(v.content_md),
    is_empty: false,
    token_budget: head.token_budget,
    last_updated: v.created_at,
    change_summary: v.change_summary
  };
}

async function update_memory({ scope_type, scope_id, content_md, change_summary }, sql, _edge, _config, request_context) {
  if (!scope_type || !scope_id || !content_md) {
    return { error: "scope_type, scope_id, and content_md are required" };
  }

  const default_budget = scope_type === "tool" ? 500 : 2200;

  // Hard cap enforcement
  if (content_md.length > 4000) {
    return { error: `Memory content too large (${content_md.length} chars). Hard cap is 4000.` };
  }

  // Upsert head
  const heads = await sql`
    INSERT INTO esbmcp_memory_heads (scope_type, scope_id, current_version, token_budget, total_versions)
    VALUES (${scope_type}, ${scope_id}, 0, ${default_budget}, 0)
    ON CONFLICT (scope_type, scope_id) DO UPDATE SET updated_at = NOW()
    RETURNING *
  `;
  const head = heads[0];
  const new_version = head.current_version + 1;

  // Get parent version id
  let parent_version_id = null;
  if (head.current_version > 0) {
    const parent = await sql`
      SELECT id FROM esbmcp_memory_versions
      WHERE scope_type = ${scope_type} AND scope_id = ${scope_id}
        AND version_no = ${head.current_version}
      LIMIT 1
    `;
    parent_version_id = parent[0]?.id || null;
  }

  // Parse sections for content_json
  const content_json = parse_memory_sections(content_md);

  // Insert new version
  const inserted = await sql`
    INSERT INTO esbmcp_memory_versions (
      scope_type, scope_id, version_no, parent_version_id,
      content_md, content_json, content_chars,
      change_summary, session_id, created_by
    ) VALUES (
      ${scope_type}, ${scope_id}, ${new_version}, ${parent_version_id},
      ${content_md}, ${JSON.stringify(content_json)}, ${content_md.length},
      ${change_summary || null},
      ${request_context?.session_id || null},
      ${request_context?.user_id || "system"}
    )
    RETURNING id, version_no, content_chars
  `;

  // Update head to point to new version
  await sql`
    UPDATE esbmcp_memory_heads
    SET current_version = ${new_version},
        total_versions = total_versions + 1,
        updated_at = NOW()
    WHERE scope_type = ${scope_type} AND scope_id = ${scope_id}
  `;

  return {
    scope_type, scope_id,
    version: new_version,
    content_chars: inserted[0].content_chars,
    change_summary,
    message: `Memory updated to version ${new_version} (${inserted[0].content_chars} chars)`
  };
}

async function rollback_memory({ scope_type, scope_id, target_version }, sql, _edge, _config, request_context) {
  if (!scope_type || !scope_id) {
    return { error: "scope_type and scope_id are required" };
  }

  // Get head
  const heads = await sql`
    SELECT * FROM esbmcp_memory_heads
    WHERE scope_type = ${scope_type} AND scope_id = ${scope_id}
    LIMIT 1
  `;
  if (heads.length === 0) return { error: "No memory found for this scope" };
  const head = heads[0];

  // Determine target
  const rollback_to = target_version || Math.max(head.current_version - 1, 0);
  if (rollback_to <= 0) {
    return { error: "Cannot rollback — no previous versions exist" };
  }
  if (rollback_to === head.current_version) {
    return { error: `Already at version ${rollback_to}` };
  }

  // Get the target version content
  const target = await sql`
    SELECT id, content_md, content_json, version_no
    FROM esbmcp_memory_versions
    WHERE scope_type = ${scope_type} AND scope_id = ${scope_id}
      AND version_no = ${rollback_to}
    LIMIT 1
  `;
  if (target.length === 0) return { error: `Version ${rollback_to} not found` };

  // Create a new version with the old content (never mutate history)
  const new_version = head.current_version + 1;
  await sql`
    INSERT INTO esbmcp_memory_versions (
      scope_type, scope_id, version_no, parent_version_id,
      rollback_from_version_id,
      content_md, content_json, content_chars,
      change_summary, created_by
    ) VALUES (
      ${scope_type}, ${scope_id}, ${new_version}, ${target[0].id},
      ${target[0].id},
      ${target[0].content_md}, ${JSON.stringify(target[0].content_json || {})},
      ${target[0].content_md.length},
      ${"Rollback from v" + head.current_version + " to v" + rollback_to},
      ${request_context?.user_id || "system"}
    )
  `;

  await sql`
    UPDATE esbmcp_memory_heads
    SET current_version = ${new_version},
        total_versions = total_versions + 1,
        updated_at = NOW()
    WHERE scope_type = ${scope_type} AND scope_id = ${scope_id}
  `;

  return {
    scope_type, scope_id,
    rolled_back_from: head.current_version,
    rolled_back_to_content_of: rollback_to,
    new_version,
    message: `Rolled back to content of version ${rollback_to} (now version ${new_version})`
  };
}

async function get_memory_versions({ scope_type, scope_id, limit }, sql) {
  if (!scope_type || !scope_id) {
    return { error: "scope_type and scope_id are required" };
  }

  const max_rows = Math.min(limit || 10, 25);

  const versions = await sql`
    SELECT id, version_no, content_chars, change_summary,
           rollback_from_version_id IS NOT NULL AS is_rollback,
           created_by, created_at
    FROM esbmcp_memory_versions
    WHERE scope_type = ${scope_type} AND scope_id = ${scope_id}
    ORDER BY version_no DESC
    LIMIT ${max_rows}
  `;

  const head = await sql`
    SELECT current_version, token_budget, total_versions
    FROM esbmcp_memory_heads
    WHERE scope_type = ${scope_type} AND scope_id = ${scope_id}
    LIMIT 1
  `;

  return {
    scope_type, scope_id,
    current_version: head[0]?.current_version || 0,
    token_budget: head[0]?.token_budget || (scope_type === "tool" ? 500 : 2200),
    total_versions: head[0]?.total_versions || 0,
    versions,
    count: versions.length
  };
}


// ─── Exports ─────────────────────────────────────────────────────────────────

const memory_tools = {
  get_memory,
  update_memory,
  rollback_memory,
  get_memory_versions
};

export {
  memory_tools,
  build_empty_memory,
  parse_memory_sections,
  CHANNEL_TEMPLATE,
  TOOL_TEMPLATE,
  MEMORY_UPDATE_INSTRUCTIONS_CHANNEL,
  MEMORY_UPDATE_INSTRUCTIONS_TOOL
};
