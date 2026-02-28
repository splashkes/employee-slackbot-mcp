import { App } from "@slack/bolt";
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

async function resolve_role_for_user(user_id) {
  if (service_config.rbac.mode === "static") {
    return service_config.rbac.user_role_map[user_id] || null;
  }

  const cached_entry = role_cache_map.get(user_id);
  const now_ms = Date.now();

  if (cached_entry && now_ms < cached_entry.expires_at_ms) {
    return cached_entry.role_name;
  }

  if (!service_config.rbac.directory_api_base_url) {
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
    return null;
  }

  const payload = await response.json();
  const role_name = payload?.role || null;

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
  mcp_client
}) {
  const normalized_prompt = remove_bot_mentions(prompt_text);

  if (!normalized_prompt) {
    return "Please provide a request after the command or mention.";
  }

  if (normalized_prompt.length > service_config.limits.request_max_chars) {
    return `Request is too long. Limit is ${service_config.limits.request_max_chars} characters.`;
  }

  const identity_result = is_identity_allowed(service_config, identity_context);

  if (!identity_result.allowed) {
    write_audit_event(AUDIT_EVENTS.REQUEST_DENIED_IDENTITY, {
      reason: identity_result.reason,
      identity_context
    });

    return "Access denied for this workspace/channel/user.";
  }

  const rate_limit_result = apply_rate_limits(identity_context);

  if (!rate_limit_result.allowed) {
    write_audit_event(AUDIT_EVENTS.REQUEST_DENIED_RATE_LIMIT, {
      reason: rate_limit_result.reason,
      identity_context
    });

    return "Rate limit reached. Please wait and retry.";
  }

  const role_name = await resolve_role_for_user(identity_context.user_id);

  if (!role_name) {
    write_audit_event(AUDIT_EVENTS.REQUEST_DENIED_ROLE, {
      identity_context
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

    return "Your role currently has no enabled tools.";
  }

  const started_at_ms = Date.now();
  const tool_call_counts = new Map();
  const is_confirmed = is_confirmation_satisfied(normalized_prompt);

  const routing_result = await run_openai_tool_routing({
    openai_client,
    model_name: service_config.openai.model,
    user_prompt_text: normalized_prompt,
    tool_definitions: role_allowed_tools,
    max_tool_calls: service_config.mcp.max_tool_calls_per_request,
    max_output_tokens: service_config.openai.max_output_tokens,
    logger,
    tool_executor: async ({ tool_name, arguments_payload }) => {
      const tool_definition = get_tool_definition_by_name(tool_index, tool_name);

      if (!tool_definition) {
        throw new Error(`Tool is not allowlisted: ${tool_name}`);
      }

      const current_count = tool_call_counts.get(tool_name) || 0;
      const next_count = current_count + 1;
      const tool_max_calls =
        Number(tool_definition.max_calls_per_request) > 0
          ? tool_definition.max_calls_per_request
          : service_config.mcp.max_tool_calls_per_request;

      if (next_count > tool_max_calls) {
        throw new Error(`Tool ${tool_name} exceeded max calls per request (${tool_max_calls})`);
      }

      tool_call_counts.set(tool_name, next_count);

      if (
        tool_definition.risk_level === RISK_LEVELS.HIGH &&
        service_config.policy.require_confirmation_for_high_risk &&
        !is_confirmed
      ) {
        throw new Error(
          `Tool ${tool_name} requires explicit confirmation. Add the word CONFIRM in your request.`
        );
      }

      const request_context = {
        team_id: identity_context.team_id,
        channel_id: identity_context.channel_id,
        user_id: identity_context.user_id,
        role: role_name,
        confirmed: is_confirmed
      };

      return await mcp_client.call_tool({
        tool_name,
        arguments_payload,
        request_context
      });
    }
  });

  const latency_ms = Date.now() - started_at_ms;

  write_audit_event(AUDIT_EVENTS.REQUEST_COMPLETED, {
    identity_context,
    role_name,
    latency_ms,
    tools_executed: routing_result.executed_tool_calls.map((item) => item.tool_name)
  });

  const response_redaction_rules = get_response_redaction_rules(
    tool_index,
    routing_result.executed_tool_calls
  );
  const redacted_text = redact_text(routing_result.response_text, response_redaction_rules);
  return truncate_text(redacted_text, service_config.limits.response_max_chars);
}

async function handle_and_reply({ prompt_text, identity_context, reply_fn, event_label, allowed_tools_manifest, tool_index, openai_client, mcp_client }) {
  try {
    const response_text = await handle_prompt({
      prompt_text,
      identity_context,
      allowed_tools_manifest,
      tool_index,
      openai_client,
      mcp_client
    });

    await reply_fn(response_text);
  } catch (error) {
    const error_id = create_error_id();

    logger.error(event_label, {
      error_id,
      error_message: error?.message,
      stack: error?.stack
    });

    await reply_fn(build_safe_error_message(error_id, error?.message));
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
              method: "HEAD",
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

  app.command(service_config.slack.command_prefix, async ({ command, ack, respond }) => {
    await ack();

    await handle_and_reply({
      prompt_text: command.text,
      identity_context: {
        team_id: command.team_id,
        channel_id: command.channel_id,
        user_id: command.user_id
      },
      reply_fn: respond,
      event_label: "command_handler_failed",
      allowed_tools_manifest,
      tool_index,
      openai_client,
      mcp_client
    });
  });

  app.event("app_mention", async ({ event, body, say }) => {
    await handle_and_reply({
      prompt_text: event.text,
      identity_context: {
        team_id: body.team_id,
        channel_id: event.channel,
        user_id: event.user
      },
      reply_fn: say,
      event_label: "mention_handler_failed",
      allowed_tools_manifest,
      tool_index,
      openai_client,
      mcp_client
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
