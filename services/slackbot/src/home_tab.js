// ---------------------------------------------------------------------------
// App Home tab builder — generates Block Kit blocks from allowed-tools.json
//
// Published via views.publish when a user opens the App Home tab.
// Automatically stays in sync with the tool manifest — no manual updates.
//
// Requires: Subscribe to app_home_opened event in Slack app settings.
// ---------------------------------------------------------------------------

const DOMAIN_LABELS = {
  "data-read": { emoji: ":mag:", title: "Data & Events" },
  "profile-integrity": { emoji: ":bust_in_silhouette:", title: "Profile & Artists" },
  "payments": { emoji: ":moneybag:", title: "Payments" },
  "growth-marketing": { emoji: ":chart_with_upwards_trend:", title: "Growth & Marketing" },
  "platform-db-edge": { emoji: ":gear:", title: "Platform Ops" },
  "eventbrite-charts": { emoji: ":bar_chart:", title: "Eventbrite Charts" },
  "memory": { emoji: ":brain:", title: "Memory" },
  "slack-knowledge": { emoji: ":speech_balloon:", title: "Slack Knowledge" }
};

const DOMAIN_ORDER = [
  "data-read", "profile-integrity", "payments", "growth-marketing",
  "platform-db-edge", "eventbrite-charts", "memory", "slack-knowledge"
];

function truncate(text, max_len) {
  if (!text || text.length <= max_len) return text || "";
  return text.slice(0, max_len - 1) + "…";
}

export function build_home_blocks(allowed_tools_manifest) {
  const tools = allowed_tools_manifest?.tools || [];

  // Group by domain
  const by_domain = {};
  for (const tool of tools) {
    const domain = tool.domain || "other";
    if (!by_domain[domain]) by_domain[domain] = [];
    by_domain[domain].push(tool);
  }

  const blocks = [];

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "Arthur Bot — Tool Reference", emoji: true }
  });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${tools.length} tools* across ${Object.keys(by_domain).length} domains. Ask me anything in natural language — I'll pick the right tools automatically.\n\n_Try: "Show me upcoming events in Toronto" or "What's the payment balance for artist Jane Smith?"_`
    }
  });

  blocks.push({ type: "divider" });

  // Quick start
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*:rocket: Quick Start*\n• `@Arthur Bot` in any channel\n• `/ab` slash command (private response)\n• DM me directly\n• Click my icon in the top bar for the Assistant panel"
    }
  });

  blocks.push({ type: "divider" });

  // Domain sections — use compact format to stay within 100-block limit
  for (const domain of DOMAIN_ORDER) {
    const domain_tools = by_domain[domain];
    if (!domain_tools || domain_tools.length === 0) continue;

    const label = DOMAIN_LABELS[domain] || { emoji: ":wrench:", title: domain };

    blocks.push({
      type: "header",
      text: { type: "plain_text", text: `${label.emoji}  ${label.title}  (${domain_tools.length})`, emoji: true }
    });

    // Build a compact list — each tool as a single mrkdwn line
    // Batch tools into sections of ~5 to stay within text limits
    const batch_size = 5;
    for (let i = 0; i < domain_tools.length; i += batch_size) {
      const batch = domain_tools.slice(i, i + batch_size);
      const lines = batch.map((t) => {
        const risk_badge = t.risk_level === "low" ? "" : ` :warning: _${t.risk_level} risk_`;
        const desc = truncate(t.description, 200);
        return `*\`${t.tool_name}\`*${risk_badge}\n${desc}`;
      });

      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n\n") }
      });
    }

    blocks.push({ type: "divider" });
  }

  // Handle any domains not in DOMAIN_ORDER
  for (const [domain, domain_tools] of Object.entries(by_domain)) {
    if (DOMAIN_ORDER.includes(domain)) continue;
    const label = DOMAIN_LABELS[domain] || { emoji: ":wrench:", title: domain };

    blocks.push({
      type: "header",
      text: { type: "plain_text", text: `${label.emoji}  ${label.title}  (${domain_tools.length})`, emoji: true }
    });

    const lines = domain_tools.map((t) => {
      const desc = truncate(t.description, 200);
      return `*\`${t.tool_name}\`*\n${desc}`;
    });

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n\n") }
    });

    blocks.push({ type: "divider" });
  }

  // Emoji feedback section
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*:sparkles: Emoji Feedback*\nReact to any of my messages to give feedback:\n• :thumbsup: :heart: :fire: :tada: — positive\n• :thumbsdown: :x: :confused: — negative\n• :bug: :wrench: — report a bug\n• Any other emoji — I'll react back with a :thinking_face:"
    }
  });

  // Enforce Slack's 100-block limit
  if (blocks.length > 100) {
    blocks.length = 99;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_...and more. Ask me to list tools in any domain for details._" }
    });
  }

  return blocks;
}
