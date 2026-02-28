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

function get_allowed_tools_for_role(manifest, role_name, enable_mutating_tools) {
  return manifest.tools.filter((tool_definition) => {
    const role_allowed = (tool_definition.allowed_roles || []).includes(role_name);

    if (!role_allowed) {
      return false;
    }

    if (tool_definition.risk_level === "high" && !enable_mutating_tools) {
      return false;
    }

    return true;
  });
}

function is_identity_allowed(service_config, identity_context) {
  const { team_id, channel_id, user_id } = identity_context;

  const team_restricted = service_config.slack.allowed_team_ids.length > 0;
  const channel_restricted = service_config.slack.allowed_channel_ids.length > 0;
  const user_restricted = service_config.slack.allowed_user_ids.length > 0;

  if (team_restricted && !service_config.slack.allowed_team_ids.includes(team_id)) {
    return { allowed: false, reason: "team_not_allowed" };
  }

  if (
    channel_restricted &&
    channel_id &&
    !service_config.slack.allowed_channel_ids.includes(channel_id)
  ) {
    return { allowed: false, reason: "channel_not_allowed" };
  }

  if (user_restricted && !service_config.slack.allowed_user_ids.includes(user_id)) {
    return { allowed: false, reason: "user_not_allowed" };
  }

  return { allowed: true, reason: "ok" };
}

function is_confirmation_satisfied(user_prompt_text) {
  return /\bconfirm\b/i.test(user_prompt_text || "");
}

class FixedWindowRateLimiter {
  constructor({ sweep_interval_ms = 5 * 60 * 1000 } = {}) {
    this.state_map = new Map();
    this._sweep_handle = setInterval(() => this._sweep(), sweep_interval_ms);
    if (this._sweep_handle.unref) {
      this._sweep_handle.unref();
    }
  }

  _sweep() {
    const now_ms = Date.now();
    for (const [key, state] of this.state_map) {
      if (now_ms - state.window_start_ms >= state.window_ms) {
        this.state_map.delete(key);
      }
    }
  }

  consume(key, max_count, window_sec) {
    const now_ms = Date.now();
    const window_ms = window_sec * 1000;

    const current_state = this.state_map.get(key);

    if (!current_state || now_ms - current_state.window_start_ms >= window_ms) {
      this.state_map.set(key, {
        window_start_ms: now_ms,
        window_ms,
        count: 1
      });

      return { allowed: true, remaining: max_count - 1 };
    }

    if (current_state.count >= max_count) {
      return {
        allowed: false,
        remaining: 0
      };
    }

    current_state.count += 1;
    this.state_map.set(key, current_state);

    return {
      allowed: true,
      remaining: Math.max(max_count - current_state.count, 0)
    };
  }
}

function apply_email_redaction(input_text) {
  return input_text.replace(
    /([a-zA-Z0-9._%+-])[a-zA-Z0-9._%+-]*@([a-zA-Z0-9.-]+\.[A-Za-z]{2,})/g,
    "$1***@$2"
  );
}

function apply_phone_redaction(input_text) {
  return input_text.replace(/\+?\d[\d\s()-]{7,}\d/g, (match_text) => {
    const digits_only = match_text.replace(/\D/g, "");
    if (digits_only.length < 7) {
      return match_text;
    }

    const visible_suffix = digits_only.slice(-2);
    return `***${visible_suffix}`;
  });
}

function apply_card_redaction(input_text) {
  return input_text.replace(/\b(?:\d[ -]*){13,19}\b/g, (match_text) => {
    const digits_only = match_text.replace(/\D/g, "");

    if (digits_only.length < 13 || digits_only.length > 19) {
      return match_text;
    }

    const visible_suffix = digits_only.slice(-4);
    return `**** **** **** ${visible_suffix}`;
  });
}

const redaction_rule_map = {
  mask_email: apply_email_redaction,
  mask_phone: apply_phone_redaction,
  mask_card_data: apply_card_redaction
};

function redact_text(raw_text, redaction_rules = []) {
  if (!raw_text) {
    return "";
  }

  const default_rules = ["mask_email", "mask_phone"];
  const rules_to_apply =
    Array.isArray(redaction_rules) && redaction_rules.length > 0
      ? redaction_rules
      : default_rules;

  let redacted_text = String(raw_text);

  for (const rule_name of rules_to_apply) {
    const redaction_function = redaction_rule_map[rule_name];

    if (!redaction_function) {
      continue;
    }

    redacted_text = redaction_function(redacted_text);
  }

  return redacted_text;
}

function truncate_text(raw_text, max_length) {
  const value = String(raw_text ?? "");
  if (value.length <= max_length) {
    return value;
  }

  return `${value.slice(0, max_length)}...`;
}

export {
  FixedWindowRateLimiter,
  get_allowed_tools_for_role,
  get_tool_definition_by_name,
  is_confirmation_satisfied,
  is_identity_allowed,
  load_allowed_tools_manifest,
  redact_text,
  truncate_text
};
