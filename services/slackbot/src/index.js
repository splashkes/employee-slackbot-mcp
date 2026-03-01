import { App } from "@slack/bolt";
import postgres from "postgres";
import { service_config, assert_required_config } from "./config.js";
import { Logger } from "./logger.js";
import { create_mcp_client } from "./mcp_client.js";
import { create_openai_client, run_openai_tool_routing } from "./openai_router.js";
import {
  build_tool_index,
  get_allowed_tools_for_role,
  get_tool_definition_by_name,
  load_allowed_tools_manifest
} from "./policy.js";
import {
  FixedWindowRateLimiter,
  is_confirmation_satisfied,
  is_identity_allowed,
  redact_text,
  truncate_text
} from "./policy.js";
import { AUDIT_EVENTS, MCP_ERROR_CODES, RISK_LEVELS } from "@abcodex/shared/constants.js";
import { create_session_writer } from "./session_writer.js";
import { markdown_to_slack_mrkdwn } from "./slack_format.js";
import { create_assistant } from "./assistant.js";

const logger = new Logger(service_config.app.log_level);
const role_cache_map = new Map();
const ROLE_CACHE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const _role_cache_sweep_handle = setInterval(() => {
  const now_ms = Date.now();
  for (const [key, entry] of role_cache_map) {
    if (now_ms >= entry.expires_at_ms) {
      role_cache_map.delete(key);
    }
  }
}, ROLE_CACHE_SWEEP_INTERVAL_MS);
if (_role_cache_sweep_handle.unref) {
  _role_cache_sweep_handle.unref();
}
const user_rate_limiter = new FixedWindowRateLimiter();
const channel_rate_limiter = new FixedWindowRateLimiter();

function create_error_id() {
  return `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const SAFE_ERROR_MAP = {
  [MCP_ERROR_CODES.CONFIRMATION_REQUIRED]:
    "This action requires explicit confirmation. Add CONFIRM to your request and retry.",
  [MCP_ERROR_CODES.TOOL_NOT_ALLOWED_FOR_ROLE]:
    "Your role is not permitted to run one of the requested tools.",
  [MCP_ERROR_CODES.INVALID_ARGUMENTS]:
    "The tool request was rejected because one or more arguments were invalid."
};

function build_safe_error_message(error_id, error_code) {
  return SAFE_ERROR_MAP[error_code] ||
    `Request failed due to an internal error. Reference ID: ${error_id}.`;
}

function remove_bot_mentions(raw_text) {
  return String(raw_text || "").replace(/<@[^>]+>/g, "").trim();
}

// Channels where any user gets read-only (viewer) access without being whitelisted
const OPEN_VIEWER_CHANNELS = new Set(
  (process.env.OPEN_VIEWER_CHANNELS || "C0AHV5ZCJG4").split(",").map((s) => s.trim()).filter(Boolean)
);

// Reaction sentiment classification for Tier 3 feedback
const POSITIVE_REACTIONS = new Set(["thumbsup", "+1", "white_check_mark", "100", "tada", "heart", "star"]);
const NEGATIVE_REACTIONS = new Set(["thumbsdown", "-1", "x", "confused", "disappointed", "face_with_rolling_eyes"]);
const BUG_REACTIONS = new Set(["bug"]);

// Shared thread context fetcher — used by app_mention and DM handlers
async function fetch_thread_context(client, channel, thread_ts, current_ts, current_text) {
  if (!thread_ts) return current_text;
  try {
    const thread = await client.conversations.replies({
      channel,
      ts: thread_ts,
      limit: 20
    });
    const prior_messages = (thread.messages || [])
      .filter((m) => m.ts !== current_ts)
      .map((m) => {
        const author = m.bot_id ? "Arthur Bot" : (m.user ? `<@${m.user}>` : "Unknown");
        return `${author}: ${m.text}`;
      })
      .join("\n");
    if (prior_messages) {
      return `[Thread context — previous messages in this thread]\n${prior_messages}\n\n[Current question]\n${current_text}`;
    }
  } catch (err) {
    logger.warn("thread_context_fetch_failed", { channel, error_message: err?.message });
  }
  return current_text;
}

// Fetch recent DM conversation history (non-threaded) — last 10 messages within 6 hours
async function fetch_dm_context(client, channel, current_ts, current_text) {
  try {
    const six_hours_ago = String(Date.now() / 1000 - 6 * 60 * 60);
    const history = await client.conversations.history({
      channel,
      limit: 11,
      oldest: six_hours_ago
    });
    const prior_messages = (history.messages || [])
      .filter((m) => m.ts !== current_ts && !m.thread_ts)
      .slice(0, 10)
      .reverse()
      .map((m) => {
        const author = m.bot_id ? "Arthur Bot" : (m.user ? `<@${m.user}>` : "Unknown");
        return `${author}: ${m.text}`;
      })
      .join("\n");
    if (prior_messages) {
      return `[Recent conversation context — last messages in this DM (within 6 hours)]\n${prior_messages}\n\n[Current question]\n${current_text}`;
    }
  } catch (err) {
    logger.warn("dm_context_fetch_failed", { channel, error_message: err?.message });
  }
  return current_text;
}

async function resolve_role_for_user(user_id, channel_id) {
  if (service_config.rbac.mode === "static") {
    const explicit_role = service_config.rbac.user_role_map[user_id];
    if (explicit_role) return explicit_role;
    // Fall back to viewer for open channels
    if (channel_id && OPEN_VIEWER_CHANNELS.has(channel_id)) return "viewer";
    return null;
  }

  const cached_entry = role_cache_map.get(user_id);
  const now_ms = Date.now();

  if (cached_entry && now_ms < cached_entry.expires_at_ms) {
    return cached_entry.role_name;
  }

  if (!service_config.rbac.directory_api_base_url) {
    if (channel_id && OPEN_VIEWER_CHANNELS.has(channel_id)) return "viewer";
    return null;
  }

  const directory_url = `${service_config.rbac.directory_api_base_url.replace(/\/$/, "")}/users/${encodeURIComponent(
    user_id
  )}/role`;

  const response = await fetch(directory_url, {
    headers: {
      authorization: `Bearer ${service_config.rbac.directory_api_token}`
    }
  });

  if (!response.ok) {
    if (channel_id && OPEN_VIEWER_CHANNELS.has(channel_id)) return "viewer";
    return null;
  }

  const payload = await response.json();
  let role_name = payload?.role || null;
  if (!role_name && channel_id && OPEN_VIEWER_CHANNELS.has(channel_id)) {
    role_name = "viewer";
  }

  role_cache_map.set(user_id, {
    role_name,
    expires_at_ms: now_ms + service_config.rbac.directory_cache_ttl_sec * 1000
  });

  return role_name;
}

function apply_rate_limits(identity_context) {
  const user_limit_result = user_rate_limiter.consume(
    `user:${identity_context.user_id}`,
    service_config.rate_limit.user_max,
    service_config.rate_limit.user_window_sec
  );

  if (!user_limit_result.allowed) {
    return {
      allowed: false,
      reason: "user_rate_limit_exceeded"
    };
  }

  const channel_key = identity_context.channel_id || "direct";
  const channel_limit_result = channel_rate_limiter.consume(
    `channel:${channel_key}`,
    service_config.rate_limit.channel_max,
    service_config.rate_limit.channel_window_sec
  );

  if (!channel_limit_result.allowed) {
    return {
      allowed: false,
      reason: "channel_rate_limit_exceeded"
    };
  }

  return {
    allowed: true,
    reason: "ok"
  };
}

function write_audit_event(event_name, metadata) {
  if (!service_config.audit.enabled) {
    return;
  }

  logger.info("audit_event", {
    event_name,
    ...metadata
  });
}

function get_response_redaction_rules(tool_index, executed_tool_calls) {
  const collected_rules = new Set();

  for (const executed_call of executed_tool_calls) {
    const tool_definition = get_tool_definition_by_name(
      tool_index,
      executed_call.tool_name
    );

    for (const rule_name of tool_definition?.redaction_rules || []) {
      collected_rules.add(rule_name);
    }
  }

  return [...collected_rules];
}

async function handle_prompt({
  prompt_text,
  identity_context,
  allowed_tools_manifest,
  tool_index,
  openai_client,
  mcp_client,
  session_writer,
  interaction_type,
  confirm_fn,
  set_status
}) {
  const session_id = session_writer.create_session_id();
  const session_start_ms = Date.now();
  const normalized_prompt = remove_bot_mentions(prompt_text);

  // Helper to build origin metadata for session/audit writes
  const origin = {
    session_id,
    slack_user_id: identity_context.user_id,
    slack_team_id: identity_context.team_id,
    slack_channel_id: identity_context.channel_id,
    slack_username: identity_context.username || null
  };

  if (!normalized_prompt) {
    session_writer.write_session({
      ...origin, interaction_type,
      user_prompt: normalized_prompt || "",
      status: "completed",
      ai_response: "Please provide a request after the command or mention.",
      total_duration_ms: Date.now() - session_start_ms
    });
    return "Please provide a request after the command or mention.";
  }

  if (normalized_prompt.length > service_config.limits.request_max_chars) {
    const msg = `Request is too long. Limit is ${service_config.limits.request_max_chars} characters.`;
    session_writer.write_session({
      ...origin, interaction_type,
      user_prompt: normalized_prompt.slice(0, 500),
      status: "error", error_message: "prompt_too_long",
      ai_response: msg,
      total_duration_ms: Date.now() - session_start_ms
    });
    return msg;
  }

  const identity_result = is_identity_allowed(service_config, identity_context);

  if (!identity_result.allowed) {
    write_audit_event(AUDIT_EVENTS.REQUEST_DENIED_IDENTITY, {
      reason: identity_result.reason,
      identity_context
    });
    session_writer.write_audit_event({ ...origin, event_type: "identity_denied", detail: { reason: identity_result.reason } });
    session_writer.write_session({
      ...origin, interaction_type,
      user_prompt: normalized_prompt,
      status: "denied", error_message: "identity_denied",
      total_duration_ms: Date.now() - session_start_ms
    });

    return "Access denied for this workspace/channel/user.";
  }

  const rate_limit_result = apply_rate_limits(identity_context);

  if (!rate_limit_result.allowed) {
    write_audit_event(AUDIT_EVENTS.REQUEST_DENIED_RATE_LIMIT, {
      reason: rate_limit_result.reason,
      identity_context
    });
    session_writer.write_audit_event({ ...origin, event_type: "rate_limit_exceeded", detail: { reason: rate_limit_result.reason } });
    session_writer.write_session({
      ...origin, interaction_type,
      user_prompt: normalized_prompt,
      status: "rate_limited", error_message: rate_limit_result.reason,
      total_duration_ms: Date.now() - session_start_ms
    });

    return "Rate limit reached. Please wait and retry.";
  }

  const role_name = await resolve_role_for_user(identity_context.user_id, identity_context.channel_id);
  origin.user_role = role_name;

  if (!role_name) {
    write_audit_event(AUDIT_EVENTS.REQUEST_DENIED_ROLE, {
      identity_context
    });
    session_writer.write_audit_event({ ...origin, event_type: "role_denied" });
    session_writer.write_session({
      ...origin, interaction_type,
      user_prompt: normalized_prompt,
      status: "denied", error_message: "no_role",
      total_duration_ms: Date.now() - session_start_ms
    });

    return "No authorized role was found for your user.";
  }

  const role_allowed_tools = get_allowed_tools_for_role(
    allowed_tools_manifest,
    role_name,
    service_config.policy.enable_mutating_tools
  );

  if (role_allowed_tools.length === 0) {
    write_audit_event(AUDIT_EVENTS.REQUEST_DENIED_NO_TOOLS, {
      identity_context,
      role_name
    });
    session_writer.write_audit_event({ ...origin, event_type: "no_tools_available" });
    session_writer.write_session({
      ...origin, interaction_type,
      user_prompt: normalized_prompt,
      status: "denied", error_message: "no_tools_for_role",
      total_duration_ms: Date.now() - session_start_ms
    });

    return "Your role currently has no enabled tools.";
  }

  session_writer.write_audit_event({ ...origin, event_type: "session_started", detail: { tools_available: role_allowed_tools.length } });

  // Load channel memory (lazy — only if memory exists for this channel)
  let channel_context = null;
  try {
    const memory_result = await mcp_client.call_tool({
      tool_name: "get_memory",
      arguments_payload: { scope_type: "channel", scope_id: identity_context.channel_id },
      request_context: {
        team_id: identity_context.team_id,
        channel_id: identity_context.channel_id,
        user_id: identity_context.user_id,
        role: role_name,
        session_id
      }
    });
    const mem = memory_result?.result;
    if (mem && !mem.is_empty && mem.content_md) {
      channel_context = mem.content_md;
    }
  } catch (err) {
    logger.warn("channel_memory_load_failed", { channel: identity_context.channel_id, error: err?.message });
  }

  const started_at_ms = Date.now();
  const tool_call_counts = new Map();
  const tool_call_details = [];
  const is_confirmed = is_confirmation_satisfied(normalized_prompt);

  const routing_result = await run_openai_tool_routing({
    openai_client,
    model_name: service_config.openai.model,
    user_prompt_text: normalized_prompt,
    tool_definitions: role_allowed_tools,
    max_tool_calls: service_config.mcp.max_tool_calls_per_request,
    max_output_tokens: service_config.openai.max_output_tokens,
    logger,
    channel_context,
    set_status,
    tool_executor: async ({ tool_name, arguments_payload }) => {
      const tool_definition = get_tool_definition_by_name(tool_index, tool_name);

      if (!tool_definition) {
        return { error: `Tool ${tool_name} is not available.` };
      }

      const current_count = tool_call_counts.get(tool_name) || 0;
      const next_count = current_count + 1;
      const tool_max_calls =
        Number(tool_definition.max_calls_per_request) > 0
          ? tool_definition.max_calls_per_request
          : service_config.mcp.max_tool_calls_per_request;

      if (next_count > tool_max_calls) {
        return { error: `Tool ${tool_name} has been called too many times in this request (max ${tool_max_calls}). Try a different approach or be more specific.` };
      }

      tool_call_counts.set(tool_name, next_count);

      // Interactive confirmation for non-low-risk tools
      let confirmed_for_request = is_confirmed;
      if (
        tool_definition.risk_level !== RISK_LEVELS.LOW &&
        !is_confirmed
      ) {
        if (confirm_fn) {
          const user_confirmed = await confirm_fn(tool_name, tool_definition, arguments_payload);
          if (!user_confirmed) {
            return { error: `Action *${tool_name}* was cancelled by the user.`, cancelled: true };
          }
          confirmed_for_request = true;
        } else {
          return { error: `Tool ${tool_name} requires confirmation. Add the word CONFIRM in your request.` };
        }
      }

      const request_context = {
        team_id: identity_context.team_id,
        channel_id: identity_context.channel_id,
        user_id: identity_context.user_id,
        username: identity_context.username,
        role: role_name,
        confirmed: confirmed_for_request,
        session_id
      };

      const argument_keys = arguments_payload ? Object.keys(arguments_payload).sort().join(",") : "";
      const tool_start = Date.now();
      let result;
      try {
        result = await mcp_client.call_tool({
          tool_name,
          arguments_payload,
          request_context
        });
      } catch (tool_error) {
        logger.error("tool_executor_error", {
          tool_name,
          error_message: tool_error?.message
        });
        result = { error: `Tool ${tool_name} failed: ${tool_error?.message || "unknown error"}` };
      }
      const tool_duration = Date.now() - tool_start;

      tool_call_details.push({
        tool_name,
        argument_keys,
        duration_ms: tool_duration,
        ok: !result?.error
      });

      return result;
    }
  });

  const latency_ms = Date.now() - started_at_ms;
  const total_duration_ms = Date.now() - session_start_ms;

  write_audit_event(AUDIT_EVENTS.REQUEST_COMPLETED, {
    identity_context,
    role_name,
    latency_ms,
    tools_executed: routing_result.executed_tool_calls.map((item) => item.tool_name)
  });

  // Skip PII redaction for ops role — they need full contact details
  const response_redaction_rules = role_name === "ops"
    ? []
    : get_response_redaction_rules(tool_index, routing_result.executed_tool_calls);
  const redacted_text = role_name === "ops"
    ? routing_result.response_text
    : redact_text(routing_result.response_text, response_redaction_rules);
  const final_response = truncate_text(redacted_text, service_config.limits.response_max_chars);

  // Write full session to Postgres
  const token_usage = routing_result.token_usage || {};
  session_writer.write_session({
    ...origin,
    interaction_type,
    user_prompt: normalized_prompt,
    ai_model: service_config.openai.model,
    ai_response: final_response,
    tools_called: tool_call_details,
    tool_call_count: tool_call_details.length,
    status: "completed",
    total_duration_ms,
    prompt_tokens: token_usage.prompt_tokens || 0,
    completion_tokens: token_usage.completion_tokens || 0,
    total_tokens: token_usage.total_tokens || 0,
    api_rounds: token_usage.api_rounds || 0,
    redaction_rules_applied: response_redaction_rules
  });

  session_writer.write_audit_event({
    ...origin, event_type: "session_completed",
    detail: {
      tool_call_count: tool_call_details.length,
      total_duration_ms,
      tools: tool_call_details.map((t) => t.tool_name)
    }
  });

  // Fire-and-forget: update channel memory if conversation had substance
  if (tool_call_details.length > 0) {
    update_channel_memory_after_session({
      openai_client,
      mcp_client,
      channel_id: identity_context.channel_id,
      channel_context,
      user_prompt: normalized_prompt,
      ai_response: final_response,
      tools_used: tool_call_details.map((t) => t.tool_name),
      session_id,
      role_name,
      identity_context
    }).catch((err) => {
      logger.warn("memory_update_failed", { channel: identity_context.channel_id, error: err?.message });
    });
  }

  return final_response;
}

// ---------------------------------------------------------------------------
// Post-session memory update (fire-and-forget)
// Uses a cheap gpt-4o-mini call to decide if the conversation contained
// durable facts worth persisting to channel memory.
// ---------------------------------------------------------------------------
async function update_channel_memory_after_session({
  openai_client, mcp_client, channel_id, channel_context,
  user_prompt, ai_response, tools_used, session_id, role_name, identity_context
}) {
  const current_memory = channel_context || "";

  const memory_prompt = [
    "You maintain a contextual memory for a Slack channel. Below is the current memory and a conversation that just happened.",
    "Output an updated memory following the exact template format below, or output exactly UNCHANGED if nothing worth remembering.",
    "",
    "Rules:",
    "• Only store DURABLE facts: who does what, recurring topics, resolved problems, learned preferences, open issues.",
    "• Do NOT store: one-off data lookups, transient numbers, anything already in the database.",
    "• Keep under 2200 characters total.",
    "• Update existing entries rather than duplicating.",
    "• Add (Mon YYYY) date suffix to new/updated entries for staleness tracking.",
    "• Drop entries not referenced in 30+ days when space is needed.",
    "• Keep the <!-- MEMORY INSTRUCTIONS --> block intact at the top.",
    "",
    "CURRENT MEMORY:",
    current_memory || "(empty — this is a new channel memory)",
    "",
    "CONVERSATION:",
    `User: ${user_prompt}`,
    `Tools used: ${tools_used.join(", ")}`,
    `Assistant: ${ai_response.slice(0, 500)}`,
    "",
    "Output the full updated memory (including instructions block and all section headings), or UNCHANGED:"
  ].join("\n");

  const response = await openai_client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: memory_prompt }],
    max_tokens: 800
  });

  const output = response.choices?.[0]?.message?.content?.trim();
  if (!output || output === "UNCHANGED" || output.length < 20) {
    return;
  }

  // Hard cap check
  if (output.length > 4000) {
    return;
  }

  // Extract change summary (first line or auto-generate)
  const first_meaningful_line = output.split("\n").find((l) =>
    l.trim() && !l.startsWith("<!--") && !l.startsWith("##") && !l.startsWith("-->")
  );
  const change_summary = first_meaningful_line
    ? `Auto: ${first_meaningful_line.slice(0, 80)}`
    : "Auto-updated from session";

  await mcp_client.call_tool({
    tool_name: "update_memory",
    arguments_payload: {
      scope_type: "channel",
      scope_id: channel_id,
      content_md: output,
      change_summary
    },
    request_context: {
      team_id: identity_context.team_id,
      channel_id,
      user_id: identity_context.user_id,
      role: role_name,
      session_id
    }
  });
}

// ---------------------------------------------------------------------------
// Interactive confirmation for non-low-risk tools
// ---------------------------------------------------------------------------
const pending_confirmations = new Map();
const CONFIRMATION_TIMEOUT_MS = 60_000;

function format_tool_summary(tool_name, arguments_payload) {
  const arg_lines = Object.entries(arguments_payload || {})
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `  • _${k}_: ${v}`)
    .join("\n");
  return `*${tool_name}*${arg_lines ? "\n" + arg_lines : ""}`;
}

function create_confirmation_handler(slack_client, channel_id) {
  if (!slack_client || !channel_id) return null;

  return async function request_confirmation(tool_name, tool_definition, arguments_payload) {
    const confirmation_id = `cf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const summary = format_tool_summary(tool_name, arguments_payload);

    const msg = await slack_client.chat.postMessage({
      channel: channel_id,
      text: `Confirmation required: ${tool_name}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `I'd like to run a tool that makes changes:\n\n${summary}\n\nShould I proceed?`
          }
        },
        {
          type: "actions",
          block_id: `confirm_block_${confirmation_id}`,
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Confirm", emoji: true },
              style: "primary",
              action_id: "confirm_tool_action",
              value: confirmation_id
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Cancel", emoji: true },
              style: "danger",
              action_id: "cancel_tool_action",
              value: confirmation_id
            }
          ]
        }
      ]
    });

    return new Promise((resolve) => {
      const timeout_handle = setTimeout(() => {
        pending_confirmations.delete(confirmation_id);
        slack_client.chat.update({
          channel: channel_id,
          ts: msg.ts,
          text: "Confirmation timed out",
          blocks: [{
            type: "section",
            text: { type: "mrkdwn", text: `~${summary}~\n\n_Timed out — action was not taken._` }
          }]
        }).catch(() => {});
        resolve(false);
      }, CONFIRMATION_TIMEOUT_MS);

      pending_confirmations.set(confirmation_id, {
        resolve,
        timeout_handle,
        channel_id,
        message_ts: msg.ts,
        summary
      });
    });
  };
}

function register_confirmation_actions(app) {
  app.action("confirm_tool_action", async ({ action, ack, client, body }) => {
    await ack();
    const pending = pending_confirmations.get(action.value);
    if (!pending) return;
    clearTimeout(pending.timeout_handle);
    pending_confirmations.delete(action.value);

    await client.chat.update({
      channel: pending.channel_id,
      ts: pending.message_ts,
      text: "Confirmed",
      blocks: [{
        type: "section",
        text: { type: "mrkdwn", text: `${pending.summary}\n\n_Confirmed by <@${body.user.id}>_ :white_check_mark:` }
      }]
    }).catch(() => {});

    pending.resolve(true);
  });

  app.action("cancel_tool_action", async ({ action, ack, client, body }) => {
    await ack();
    const pending = pending_confirmations.get(action.value);
    if (!pending) return;
    clearTimeout(pending.timeout_handle);
    pending_confirmations.delete(action.value);

    await client.chat.update({
      channel: pending.channel_id,
      ts: pending.message_ts,
      text: "Cancelled",
      blocks: [{
        type: "section",
        text: { type: "mrkdwn", text: `~${pending.summary}~\n\n_Cancelled by <@${body.user.id}>_` }
      }]
    }).catch(() => {});

    pending.resolve(false);
  });
}

// ---------------------------------------------------------------------------
// Typing indicator (Slack assistant thread status)
// ---------------------------------------------------------------------------

function create_typing_indicator(slack_client, channel, thread_ts) {
  if (!slack_client || !channel || !thread_ts) {
    return { start() {}, stop() {} };
  }

  let active = false;

  const stop = async () => {
    if (!active) return;
    active = false;
    try {
      await slack_client.assistant.threads.setStatus({
        channel_id: channel,
        thread_ts,
        status: ""
      });
    } catch (_err) {
      // Status auto-clears on reply anyway — ignore
    }
  };

  const start = async () => {
    try {
      await slack_client.assistant.threads.setStatus({
        channel_id: channel,
        thread_ts,
        status: "is thinking..."
      });
      active = true;
    } catch (_err) {
      // Non-critical — don't block the request
    }
  };

  return { start, stop };
}

// ---------------------------------------------------------------------------
// Summary / thread splitting for long responses
// ---------------------------------------------------------------------------
const THREAD_THRESHOLD_CHARS = 500;

function extract_summary_line(full_text) {
  // Take the first non-empty line (or first sentence) as the summary
  const lines = full_text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return null; // Short enough — no split needed

  const first_line = lines[0].trim();
  // If the first line is already a decent summary (< 200 chars), use it
  if (first_line.length > 0 && first_line.length < 200) {
    return first_line;
  }
  // Otherwise truncate
  return first_line.slice(0, 150) + "…";
}

async function handle_and_reply({ prompt_text, identity_context, reply_fn, event_label, interaction_type, allowed_tools_manifest, tool_index, openai_client, mcp_client, session_writer, typing_indicator, confirm_fn, slack_client, channel_id, thread_ts }) {
  const session_start_ms = Date.now();
  await typing_indicator?.start();
  try {
    const response_text = await handle_prompt({
      prompt_text,
      identity_context,
      allowed_tools_manifest,
      tool_index,
      openai_client,
      mcp_client,
      session_writer,
      interaction_type,
      confirm_fn
    });

    const formatted = markdown_to_slack_mrkdwn(response_text);

    // Reply as thread when thread_ts is set, inline otherwise.
    // DM handler only sets thread_ts when user is already in a thread.
    if (thread_ts && slack_client && channel_id) {
      await slack_client.chat.postMessage({
        channel: channel_id,
        thread_ts,
        text: formatted
      });
    } else if (slack_client && channel_id) {
      await slack_client.chat.postMessage({
        channel: channel_id,
        text: formatted
      });
    } else if (!slack_client || !channel_id) {
      // Fallback for slash commands or missing client
      await reply_fn(formatted);
    } else {
      // Should not happen (thread_ts is always set for app_mention), but safety fallback
      await reply_fn(formatted);
    }
  } catch (error) {
    const error_id = create_error_id();

    logger.error(event_label, {
      error_id,
      error_message: error?.message,
      stack: error?.stack
    });

    // Write error session
    const session_id = session_writer.create_session_id();
    session_writer.write_session({
      session_id,
      slack_user_id: identity_context.user_id,
      slack_team_id: identity_context.team_id,
      slack_channel_id: identity_context.channel_id,
      interaction_type,
      user_prompt: remove_bot_mentions(prompt_text) || "",
      ai_model: service_config.openai.model,
      status: "error",
      error_message: error?.message,
      error_id,
      total_duration_ms: Date.now() - session_start_ms
    });

    await reply_fn(build_safe_error_message(error_id, error?.message));
  } finally {
    await typing_indicator?.stop();
  }
}

async function start_service() {
  assert_required_config();

  const allowed_tools_manifest = load_allowed_tools_manifest(service_config.policy.allowed_tools_file);
  const tool_index = build_tool_index(allowed_tools_manifest);
  const openai_client = create_openai_client(service_config.openai.api_key);
  const mcp_client = create_mcp_client({
    gateway_url: service_config.mcp.gateway_url,
    gateway_auth_token: service_config.mcp.gateway_auth_token,
    request_signing_secret: service_config.mcp.request_signing_secret,
    timeout_ms: service_config.mcp.timeout_ms
  });

  // Initialize session writer (writes to esbmcp_ tables)
  const audit_db_url = process.env.SUPABASE_DB_URL || "";
  const audit_sql = audit_db_url
    ? postgres(audit_db_url, { max: 3, idle_timeout: 30, connect_timeout: 10, prepare: false, transform: { undefined: null } })
    : null;
  const session_writer = create_session_writer(audit_sql);

  if (audit_sql) {
    logger.info("session_writer_connected", { has_audit_db: true });
  } else {
    logger.warn("session_writer_not_configured", { message: "Chat sessions will not be persisted. Set SUPABASE_DB_URL." });
  }

  const app = new App({
    token: service_config.slack.bot_token,
    signingSecret: service_config.slack.signing_secret || "unused-in-socket-mode",
    socketMode: service_config.slack.use_socket_mode,
    appToken: service_config.slack.use_socket_mode ? service_config.slack.app_token : undefined,
    customRoutes: [
      {
        path: "/healthz",
        method: ["GET"],
        handler: (_req, res) => {
          res.writeHead(200);
          res.end("ok");
        }
      },
      {
        path: "/readyz",
        method: ["GET"],
        handler: async (_req, res) => {
          if (!service_config.openai.api_key) {
            res.writeHead(503);
            res.end("not ready: missing OPENAI_API_KEY");
            return;
          }

          try {
            const gateway_health_url = `${service_config.mcp.gateway_url.replace(/\/$/, "")}/healthz`;
            const probe = await fetch(gateway_health_url, {
              method: "GET",
              signal: AbortSignal.timeout(3000)
            });
            if (!probe.ok) {
              res.writeHead(503);
              res.end("not ready: mcp gateway unhealthy");
              return;
            }
          } catch (_err) {
            res.writeHead(503);
            res.end("not ready: mcp gateway unreachable");
            return;
          }

          res.writeHead(200);
          res.end("ready");
        }
      }
    ]
  });

  register_confirmation_actions(app);

  // -------------------------------------------------------------------------
  // Tier 2: Slack Assistant framework (assistant:write scope)
  // Provides top-bar icon, split-pane UI, suggested prompts, loading states.
  // Requires: Enable "Agents & AI Apps" in Slack app settings.
  // -------------------------------------------------------------------------
  const assistant = create_assistant({
    handle_prompt_fn: async ({ prompt_text, identity_context, interaction_type, set_status }) => {
      const response_text = await handle_prompt({
        prompt_text,
        identity_context,
        allowed_tools_manifest,
        tool_index,
        openai_client,
        mcp_client,
        session_writer,
        interaction_type,
        set_status
      });
      return markdown_to_slack_mrkdwn(response_text);
    },
    logger
  });
  app.assistant(assistant);

  app.command(service_config.slack.command_prefix, async ({ command, ack, respond, client }) => {
    await ack();

    await handle_and_reply({
      prompt_text: command.text,
      identity_context: {
        team_id: command.team_id,
        channel_id: command.channel_id,
        user_id: command.user_id,
        username: command.user_name
      },
      reply_fn: respond,
      event_label: "command_handler_failed",
      interaction_type: "slash_command",
      allowed_tools_manifest,
      tool_index,
      openai_client,
      mcp_client,
      session_writer,
      slack_client: client,
      channel_id: command.channel_id
    });
  });

  app.event("app_mention", async ({ event, body, say, client }) => {
    const thread_ts = event.thread_ts || event.ts;
    const typing = create_typing_indicator(client, event.channel, thread_ts);
    const confirm = create_confirmation_handler(client, event.channel);

    const prompt_text = await fetch_thread_context(
      client, event.channel, event.thread_ts, event.ts, event.text
    );

    await handle_and_reply({
      prompt_text,
      identity_context: {
        team_id: body.team_id,
        channel_id: event.channel,
        user_id: event.user,
        username: event.username || null
      },
      reply_fn: say,
      event_label: "mention_handler_failed",
      interaction_type: "app_mention",
      allowed_tools_manifest,
      tool_index,
      openai_client,
      mcp_client,
      session_writer,
      typing_indicator: typing,
      confirm_fn: confirm,
      slack_client: client,
      channel_id: event.channel,
      thread_ts
    });
  });

  // -------------------------------------------------------------------------
  // Tier 1: DM and group DM support (im:history, im:read, mpim:history, mpim:read)
  // Handles direct messages and multi-person DMs without requiring @mention.
  // Requires subscribing to message.im and message.mpim events in Slack app settings.
  // -------------------------------------------------------------------------
  app.event("message", async ({ event, body, say, client }) => {
    // Only handle DMs and group DMs — channel messages are handled by app_mention
    if (event.channel_type !== "im" && event.channel_type !== "mpim") return;
    // Ignore bot's own messages, message_changed, message_deleted, etc.
    if (event.subtype) return;
    // Ignore if no user (system messages)
    if (!event.user) return;
    // In group DMs (mpim), skip messages that @mention the bot — app_mention handles those.
    // Without this, both handlers fire and the user gets duplicate (often conflicting) responses.
    if (event.channel_type === "mpim" && /<@[^>]+>/.test(event.text || "")) return;

    // In DMs, reply inline (no threading) unless user is already in a thread.
    // Only set thread_ts when event.thread_ts exists (user sent a threaded reply).
    const thread_ts = event.thread_ts || null;
    const typing = create_typing_indicator(client, event.channel, thread_ts || event.ts);
    const confirm = create_confirmation_handler(client, event.channel);

    // In threads, fetch thread context; otherwise fetch recent DM history (last 10 msgs, 6h window)
    const prompt_text = thread_ts
      ? await fetch_thread_context(client, event.channel, event.thread_ts, event.ts, event.text)
      : await fetch_dm_context(client, event.channel, event.ts, event.text);

    const interaction_type = event.channel_type === "mpim" ? "group_dm" : "direct_message";

    await handle_and_reply({
      prompt_text,
      identity_context: {
        team_id: body?.team_id || event.team,
        channel_id: event.channel,
        user_id: event.user,
        username: event.username || null
      },
      reply_fn: say,
      event_label: "dm_handler_failed",
      interaction_type,
      allowed_tools_manifest,
      tool_index,
      openai_client,
      mcp_client,
      session_writer,
      typing_indicator: typing,
      confirm_fn: confirm,
      slack_client: client,
      channel_id: event.channel,
      thread_ts
    });
  });

  // -------------------------------------------------------------------------
  // Tier 3: Reaction-based feedback (reactions:read scope)
  // Maps emoji reactions on bot messages to sentiment and logs to DB.
  // Requires subscribing to reaction_added event in Slack app settings.
  // -------------------------------------------------------------------------
  app.event("reaction_added", async ({ event }) => {
    if (event.item?.type !== "message") return;

    const reaction = event.reaction;
    let sentiment = null;

    if (POSITIVE_REACTIONS.has(reaction)) sentiment = "positive";
    else if (NEGATIVE_REACTIONS.has(reaction)) sentiment = "negative";
    else if (BUG_REACTIONS.has(reaction)) sentiment = "bug";
    else return;

    session_writer.write_reaction_feedback({
      slack_channel_id: event.item.channel,
      message_ts: event.item.ts,
      thread_ts: null,
      slack_user_id: event.user,
      reaction,
      sentiment
    });

    logger.info("reaction_feedback_captured", {
      reaction,
      sentiment,
      channel: event.item.channel,
      user: event.user
    });
  });

  app.error((error) => {
    logger.error("slack_app_error", {
      error_message: error?.message,
      stack: error?.stack
    });
  });

  await app.start(service_config.app.port);

  logger.info("slackbot_started", {
    port: service_config.app.port,
    socket_mode: service_config.slack.use_socket_mode,
    allowed_tools_count: allowed_tools_manifest.tools.length
  });

  const shutdown = async () => {
    logger.info("shutdown_initiated", { signal: "SIGTERM" });

    clearInterval(_role_cache_sweep_handle);
    role_cache_map.clear();

    try {
      await app.stop();
      await session_writer.close();
      logger.info("shutdown_complete");
    } catch (error) {
      logger.error("shutdown_error", { error_message: error?.message });
    }

    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start_service().catch((error) => {
  logger.error("service_start_failed", {
    error_message: error?.message,
    stack: error?.stack
  });

  process.exit(1);
});
