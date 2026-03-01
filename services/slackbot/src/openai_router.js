import OpenAI from "openai";
import { hash_json_payload } from "@abcodex/shared/signing.js";

function create_openai_client(api_key) {
  return new OpenAI({ apiKey: api_key });
}

function build_openai_tools(tool_definitions) {
  return tool_definitions.map((tool_definition) => ({
    type: "function",
    function: {
      name: tool_definition.tool_name,
      description: tool_definition.description || tool_definition.tool_name,
      parameters: tool_definition.parameters_schema || {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  }));
}

function parse_tool_arguments(arguments_text) {
  if (!arguments_text) {
    return {};
  }

  try {
    return JSON.parse(arguments_text);
  } catch (_error) {
    return {};
  }
}

function extract_text_from_message(message_content) {
  if (!message_content) {
    return "";
  }

  if (typeof message_content === "string") {
    return message_content;
  }

  if (Array.isArray(message_content)) {
    return message_content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item?.type === "text") {
          return item.text || "";
        }

        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

const SAFE_LOG_KEYS = ["eid", "round", "group_by", "search_by", "status", "hours_back", "audience_filter", "table_name", "limit", "title", "description", "priority", "related_eid", "city", "force", "cadence", "action", "include_comparators", "slack_channel_id", "force_rescore"];

// Tool-specific loading labels for the Slack Assistant status indicator
const TOOL_STATUS_LABELS = {
  lookup_event: "Looking up event...",
  get_auction_revenue: "Checking revenue...",
  generate_chart: "Generating chart...",
  search_slack_knowledge: "Searching Slack archive...",
  get_payment_balance: "Checking payment balance...",
  refresh_eventbrite_data: "Refreshing Eventbrite data...",
  get_eventbrite_data: "Loading Eventbrite data..."
};

function summarize_arguments_payload(arguments_payload) {
  const normalized_payload =
    arguments_payload && typeof arguments_payload === "object" ? arguments_payload : {};

  const preview = {};
  for (const k of SAFE_LOG_KEYS) {
    if (k in normalized_payload) preview[k] = normalized_payload[k];
  }

  return {
    arguments_hash: hash_json_payload(normalized_payload),
    argument_keys: Object.keys(normalized_payload).sort(),
    arguments_preview: Object.keys(preview).length > 0 ? preview : undefined
  };
}

async function run_openai_tool_routing({
  openai_client,
  model_name,
  user_prompt_text,
  tool_definitions,
  max_tool_calls,
  max_output_tokens,
  tool_executor,
  logger,
  channel_context,
  set_status
}) {
  // System prompt ordered for prompt caching: static content at the top (cached
  // across all calls), then semi-static domain guidance, then per-channel memory
  // at the bottom (changes least frequently → most frequently, top → bottom).
  const static_prompt = [
    // ── STATIC BLOCK (identical across every call — always cached) ─────────
    "You are Art Battle's internal operations assistant. Employees ask you questions in plain language — your job is to understand what they need and use the right tools to get them answers.",
    "",
    "PII HANDLING: This is an authorized internal system used by employees who need access to contact information (emails, phone numbers, addresses) as part of their job. When tool results include PII, you MUST display it exactly as returned — do NOT mask, redact, abbreviate, or obscure any data (no a***@, no ***95, no partial masking). The system applies its own redaction policies downstream when needed.",
    "",
    "SKILL SELECTION: The employee does NOT need to know which tools exist. They describe their problem naturally (e.g. 'why can't people see AB4023?' or 'how much did we make at the Toronto event?') and you select the appropriate tool(s).",
    "",
    "Guidelines:",
    "• Use tools proactively when a query clearly requires data. Do not ask the employee to rephrase.",
    "• Combine multiple tools when needed (e.g. lookup_event + get_auction_revenue for a revenue question).",
    "• Event IDs look like AB followed by digits (AB4001, AB3982). If the employee mentions a city or date instead, use lookup_event with what you have.",
    "• For write operations (name changes, invitations, payments), clearly state what you will do and ask for confirmation before proceeding.",
    "• Do not fabricate data. If a tool returns an error, report it honestly.",
    "• If you are unsure which tool to use, pick the most likely one — a fast wrong guess that returns useful data is better than asking the employee to clarify.",
    "",
    "FORMATTING — you are posting to Slack, so use Slack mrkdwn syntax, NOT standard Markdown:",
    "• Bold: *text* (single asterisk, NOT double **)",
    "• Italic: _text_ (underscores)",
    "• Strikethrough: ~text~",
    "• Code inline: `code`",
    "• Code block: ```code```",
    "• Bullet lists: use • or plain text lines, NOT dashes -",
    "• Links: <https://url|link text> (NOT [text](url))",
    "• Headers: use *BOLD TEXT* on its own line (NOT # or ## or ###)",
    "• NEVER use Markdown tables (| col | col |). Instead, present tabular data as a structured list:",
    "  For each row, use *bold label* followed by values on separate lines, or use a code block for alignment.",
    "  Example — instead of a table, write:",
    "  *AB4003-1-1* — Pongsit Suksomboonpong",
    "  Bids: 15 · Max: $1,890 · Closes: 3:14 PM",
    "",
    "  Or for dense data, use a code block:",
    "  ```",
    "  Art Code     Artist                  Bids  Max Bid",
    "  AB4003-1-1   Pongsit Suksomboonpong   15   $1,890",
    "  AB4003-1-2   Ploy Makaew               4   $1,190",
    "  ```",
    "• Format currency with $ and commas ($1,890.00 not 1890.00)",
    "• TIMEZONE: Event datetimes in the database are stored in UTC. When the data includes a timezone_icann field (e.g. America/Toronto, America/New_York, Australia/Sydney), you MUST convert UTC times to that local timezone before displaying. Example: 2026-12-18T00:30:00Z with timezone America/Toronto = Dec 17, 2026 at 7:30 PM ET. Always show the timezone abbreviation (ET, PT, AEST, etc.).",
    "• Format dates/times in a human-readable way (Jan 15, 2025 at 3:14 PM ET, not 2025-01-15T15:14:15Z)",
    "• Keep responses concise — Slack messages should be scannable, not walls of text. For large result sets (20+ items), present a summary with totals and the top entries rather than listing every single row.",
    "• STRUCTURE: Always start your response with a single-line summary (e.g. '*AB4003* — Toronto, Jan 15, 2025 · 3 rounds · 12 artworks'). Put detailed data on subsequent lines. This first line may be shown as a preview in the channel with full details in a thread.",
    "",
    // ── DOMAIN GUIDANCE (changes only on deploy — still cached) ────────────
    "EVENTBRITE CHARTS:",
    "• When asked about ticket sales, ticket pace, or chart requests: first check cache freshness with get_eventbrite_data. If stale (>6h), call refresh_eventbrite_data before generating the chart.",
    "• Use generate_chart to create ticket sales pace charts. It auto-refreshes stale data and picks comparators.",
    "• For ongoing tracking, suggest schedule_chart_autopost so charts auto-post to the channel on a schedule.",
    "• Use verify_eventbrite_config to diagnose Eventbrite connectivity issues.",
    "• Charts are uploaded as images directly to Slack.",
    "",
    "TOOL MEMORY:",
    "• If you encounter unexpected errors or issues with a tool, call get_memory with scope_type='tool' and scope_id=<tool_name> to check for known patterns and workarounds.",
    "• Do not proactively load tool memories — only load them when you hit an issue or need context about a specific tool's quirks."
  ].join("\n");

  // ── PER-CHANNEL CONTEXT (appended at the end — varies per channel) ──────
  const system_prompt = channel_context
    ? static_prompt + "\n\n" + "CHANNEL CONTEXT (from memory — use this to inform your responses):\n" + channel_context
    : static_prompt;

  const messages = [
    {
      role: "system",
      content: system_prompt
    },
    {
      role: "user",
      content: user_prompt_text
    }
  ];

  const openai_tools = build_openai_tools(tool_definitions);
  const all_executed_tool_calls = [];
  let total_tool_calls = 0;
  const MAX_ROUNDS = 5;

  // Accumulate token usage across all rounds
  let total_prompt_tokens = 0;
  let total_completion_tokens = 0;
  let api_rounds = 0;

  function accumulate_usage(response) {
    const usage = response?.usage;
    if (usage) {
      total_prompt_tokens += usage.prompt_tokens || 0;
      total_completion_tokens += usage.completion_tokens || 0;
    }
    api_rounds++;
  }

  function build_token_usage() {
    return {
      prompt_tokens: total_prompt_tokens,
      completion_tokens: total_completion_tokens,
      total_tokens: total_prompt_tokens + total_completion_tokens,
      api_rounds
    };
  }

  // Loop: keep calling OpenAI until it stops requesting tools or we hit limits
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await openai_client.chat.completions.create({
      model: model_name,
      messages,
      tools: openai_tools,
      tool_choice: "auto",
      max_tokens: max_output_tokens
    });
    accumulate_usage(response);

    const assistant_message = response.choices?.[0]?.message;
    const tool_calls = Array.isArray(assistant_message?.tool_calls) ? assistant_message.tool_calls : [];

    // No tool calls — model is done, return the final text
    if (tool_calls.length === 0) {
      const final_text = extract_text_from_message(assistant_message?.content);
      return {
        response_text: final_text || "No action was required.",
        executed_tool_calls: all_executed_tool_calls,
        token_usage: build_token_usage()
      };
    }

    // Budget check: cap total tool calls across all rounds
    const remaining_budget = Math.max(max_tool_calls - total_tool_calls, 0);
    const bounded_tool_calls = tool_calls.slice(0, Math.max(remaining_budget, 1));
    total_tool_calls += bounded_tool_calls.length;

    // Execute tool calls in parallel
    const tool_call_results = await Promise.all(
      bounded_tool_calls.map(async (tool_call) => {
        const tool_name = tool_call?.function?.name;
        const arguments_payload = parse_tool_arguments(tool_call?.function?.arguments);
        const argument_summary = summarize_arguments_payload(arguments_payload);

        logger.info("executing_tool_call", {
          tool_name,
          round,
          ...argument_summary
        });

        // Update assistant loading state (fire-and-forget — cosmetic only)
        if (set_status) {
          set_status(TOOL_STATUS_LABELS[tool_name] || "Working...").catch(() => {});
        }

        const tool_result = await tool_executor({
          tool_name,
          arguments_payload
        });

        return {
          tool_call_id: tool_call.id,
          tool_name,
          argument_summary,
          tool_result
        };
      })
    );

    // Track all executed calls
    for (const item of tool_call_results) {
      all_executed_tool_calls.push({
        tool_name: item.tool_name,
        ...item.argument_summary
      });
    }

    // Append assistant message + tool results to conversation
    messages.push({
      role: "assistant",
      content: assistant_message?.content || "",
      tool_calls: bounded_tool_calls
    });

    for (const item of tool_call_results) {
      messages.push({
        role: "tool",
        tool_call_id: item.tool_call_id,
        content: JSON.stringify(item.tool_result)
      });
    }

    // If we've exhausted the tool call budget, do one final call without tools
    if (total_tool_calls >= max_tool_calls) {
      const final_response = await openai_client.chat.completions.create({
        model: model_name,
        messages,
        max_tokens: max_output_tokens
      });
      accumulate_usage(final_response);

      const final_text = extract_text_from_message(final_response.choices?.[0]?.message?.content);
      return {
        response_text: final_text || "Tool execution completed.",
        executed_tool_calls: all_executed_tool_calls,
        token_usage: build_token_usage()
      };
    }
  }

  // Safety: if we somehow exhaust MAX_ROUNDS, do a final text-only call
  const fallback_response = await openai_client.chat.completions.create({
    model: model_name,
    messages,
    max_tokens: max_output_tokens
  });
  accumulate_usage(fallback_response);

  const fallback_text = extract_text_from_message(fallback_response.choices?.[0]?.message?.content);
  return {
    response_text: fallback_text || "Tool execution completed.",
    executed_tool_calls: all_executed_tool_calls,
    token_usage: build_token_usage()
  };
}

export { create_openai_client, run_openai_tool_routing };
