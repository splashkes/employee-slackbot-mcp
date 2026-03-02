/**
 * Passthrough formatter — converts raw tool JSON into Slack mrkdwn
 * so we can skip GPT's final summarisation call for read-only lookups.
 */

function format_currency(value, currency) {
  if (value == null) return "N/A";
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  const symbol = currency ? `${currency} ` : "$";
  return `${symbol}${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function format_value(value) {
  if (value === null || value === undefined) return "_N/A_";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (typeof value === "string" && value.length === 0) return "_empty_";
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "_empty_";
    return entries.map(([k, v]) => `${humanize_key(k)}: ${format_value(v)}`).join(", ");
  }
  return String(value);
}

function humanize_key(key) {
  return key
    .replace(/_/g, " ")
    .replace(/\bid\b/gi, "ID")
    .replace(/\beid\b/gi, "EID")
    .replace(/\buuid\b/gi, "UUID")
    .replace(/\burl\b/gi, "URL")
    .replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());
}

function format_flat_object(obj, indent = 0) {
  const prefix = indent > 0 ? "  ".repeat(indent) : "";
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${prefix}*${humanize_key(key)}:*`);
      lines.push(format_flat_object(value, indent + 1));
    } else if (Array.isArray(value)) {
      lines.push(`${prefix}*${humanize_key(key)}:* ${value.length} items`);
    } else {
      lines.push(`${prefix}*${humanize_key(key)}:* ${format_value(value)}`);
    }
  }
  return lines.join("\n");
}

function format_array_item(item, index) {
  if (typeof item !== "object" || item === null) {
    return `${index + 1}. ${format_value(item)}`;
  }
  // Use a recognisable label if the object has common identifier keys
  const label_key = ["name", "eid", "title", "display_name", "artist_name", "tool_name", "email"]
    .find((k) => item[k]);
  const label = label_key ? String(item[label_key]) : `#${index + 1}`;

  const detail_entries = Object.entries(item)
    .filter(([k]) => k !== label_key);

  if (detail_entries.length === 0) {
    return `*${label}*`;
  }

  const detail_lines = detail_entries.map(([k, v]) => {
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      return `  *${humanize_key(k)}:*\n${format_flat_object(v, 2)}`;
    }
    if (Array.isArray(v)) {
      return `  *${humanize_key(k)}:* ${v.length} items`;
    }
    return `  *${humanize_key(k)}:* ${format_value(v)}`;
  });

  return `*${label}*\n${detail_lines.join("\n")}`;
}

/**
 * Format a raw tool result into Slack mrkdwn.
 *
 * @param {string} tool_name – the tool that produced this result
 * @param {object} raw_result – the JSON object returned by the MCP gateway
 * @returns {string} Slack mrkdwn text
 */
function format_passthrough_result(tool_name, raw_result) {
  if (!raw_result || typeof raw_result !== "object") {
    return `*${humanize_key(tool_name)}* — no data returned.`;
  }

  // Error responses
  if (raw_result.error) {
    return `*${humanize_key(tool_name)}* — error: ${raw_result.error}`;
  }

  // Unwrap: many tools return { result: <payload> }
  const payload = raw_result.result !== undefined ? raw_result.result : raw_result;

  // Find the primary array key (events, artists, payments, bids, etc.)
  const array_key = Object.keys(payload).find((k) => Array.isArray(payload[k]));

  if (array_key && Array.isArray(payload[array_key])) {
    const items = payload[array_key];
    const header = humanize_key(tool_name);

    // Build metadata line from non-array top-level keys
    const meta_entries = Object.entries(payload)
      .filter(([k]) => k !== array_key && !Array.isArray(payload[k]));
    const meta_line = meta_entries.length > 0
      ? meta_entries.map(([k, v]) => `${humanize_key(k)}: ${format_value(v)}`).join(" · ")
      : null;

    if (items.length === 0) {
      return meta_line
        ? `*${header}* — ${meta_line}\nNo ${array_key} found.`
        : `*${header}* — no ${array_key} found.`;
    }

    const formatted_items = items.slice(0, 25).map((item, i) => format_array_item(item, i));
    const truncation_note = items.length > 25
      ? `\n_… and ${items.length - 25} more (${items.length} total)_`
      : "";

    const parts = [`*${header}*`];
    if (meta_line) parts.push(meta_line);
    parts.push("");
    parts.push(formatted_items.join("\n\n"));
    if (truncation_note) parts.push(truncation_note);

    return parts.join("\n");
  }

  // Single flat object (single event, single person, etc.)
  if (typeof payload === "object" && !Array.isArray(payload)) {
    const header = humanize_key(tool_name);
    return `*${header}*\n${format_flat_object(payload)}`;
  }

  // Fallback: just stringify
  return `*${humanize_key(tool_name)}*\n\`\`\`${JSON.stringify(payload, null, 2).slice(0, 2800)}\`\`\``;
}

export { format_passthrough_result, format_currency, format_value, humanize_key };
