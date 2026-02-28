/**
 * Post-processor that converts common Markdown patterns to Slack mrkdwn.
 * Acts as a safety net — the system prompt already asks for Slack formatting,
 * but LLMs sometimes fall back to standard Markdown.
 */

/**
 * Convert Markdown table block to a Slack-friendly code block.
 * Matches consecutive lines that start with | and contain |.
 */
function convert_tables(text) {
  // Match blocks of lines that look like markdown tables
  // A table is: header row, separator row (|---|), and data rows
  const table_block_re = /(?:^|\n)((?:\|[^\n]+\|\n?){2,})/g;

  return text.replace(table_block_re, (match, table_block) => {
    const lines = table_block.trim().split("\n");

    // Filter out separator rows (|---|---|)
    const content_lines = lines.filter(
      (line) => !/^\|[\s\-:|]+\|$/.test(line.trim())
    );

    if (content_lines.length === 0) return match;

    // Parse each row into cells
    const parsed_rows = content_lines.map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
    );

    // Calculate column widths
    const col_count = parsed_rows[0]?.length || 0;
    const col_widths = [];
    for (let c = 0; c < col_count; c++) {
      let max_width = 0;
      for (const row of parsed_rows) {
        const cell_len = (row[c] || "").length;
        if (cell_len > max_width) max_width = cell_len;
      }
      col_widths.push(max_width);
    }

    // Build padded rows
    const formatted_lines = parsed_rows.map((row) =>
      row.map((cell, i) => cell.padEnd(col_widths[i] || 0)).join("  ")
    );

    return "\n```\n" + formatted_lines.join("\n") + "\n```\n";
  });
}

/**
 * Convert **bold** → *bold*  (Markdown double-asterisk to Slack single-asterisk)
 * Must not touch already-single-asterisk bold.
 */
function convert_bold(text) {
  return text.replace(/\*\*([^*]+?)\*\*/g, "*$1*");
}

/**
 * Convert ### Header, ## Header, # Header → *HEADER*
 */
function convert_headers(text) {
  return text.replace(/^#{1,6}\s+(.+)$/gm, (_match, content) => {
    // Strip any bold markers that might be inside the header
    const clean = content.replace(/\*\*([^*]+?)\*\*/g, "$1").replace(/\*([^*]+?)\*/g, "$1");
    return `*${clean}*`;
  });
}

/**
 * Convert [text](url) → <url|text>
 */
function convert_links(text) {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
}

/**
 * Convert leading - or * list markers to •
 * Only applies when the line starts with - or * followed by a space (not bold markers)
 */
function convert_list_markers(text) {
  return text.replace(/^(\s*)[-*]\s+/gm, "$1• ");
}

/**
 * Main converter: apply all transformations in order.
 * Order matters — headers before bold, tables before everything.
 */
function markdown_to_slack_mrkdwn(text) {
  if (!text || typeof text !== "string") return text;

  let result = text;

  // 1. Tables first (before bold conversion mangles the pipes)
  result = convert_tables(result);

  // 2. Headers (before bold, since headers contain text that shouldn't be double-converted)
  result = convert_headers(result);

  // 3. Bold **text** → *text*
  result = convert_bold(result);

  // 4. Links [text](url) → <url|text>
  result = convert_links(result);

  // 5. List markers - → •
  result = convert_list_markers(result);

  return result;
}

export { markdown_to_slack_mrkdwn };
