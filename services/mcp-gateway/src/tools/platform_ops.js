// platform_ops domain — 5 read-only tools
// Skills: 36-38, 42, 50

async function get_slack_queue_health(_args, sql) {
  const stats = await sql`
    SELECT status, COUNT(*) AS cnt,
           MIN(created_at) AS oldest,
           MAX(created_at) AS newest
    FROM slack_notifications
    GROUP BY status
    ORDER BY status
  `;

  const recent_failures = await sql`
    SELECT id, channel_id, payload, status, error, created_at
    FROM slack_notifications
    WHERE status = 'failed'
    ORDER BY created_at DESC
    LIMIT 10
  `;

  const total = stats.reduce((sum, r) => sum + Number(r.cnt), 0);
  const failed = stats.find((r) => r.status === "failed");

  return {
    statuses: Object.fromEntries(stats.map((r) => [r.status, Number(r.cnt)])),
    total_notifications: total,
    failed_count: failed ? Number(failed.cnt) : 0,
    recent_failures,
    healthy: !failed || Number(failed.cnt) === 0
  };
}

async function get_email_queue_stats({ hours_back }, sql) {
  const lookback = hours_back || 24;

  const stats = await sql`
    SELECT status, COUNT(*) AS cnt
    FROM email_logs
    WHERE created_at > NOW() - (${lookback} || ' hours')::interval
    GROUP BY status
    ORDER BY status
  `;

  const recent_errors = await sql`
    SELECT id, recipient, subject, status, error_message, created_at
    FROM email_logs
    WHERE status = 'failed'
      AND created_at > NOW() - (${lookback} || ' hours')::interval
    ORDER BY created_at DESC
    LIMIT 10
  `;

  return {
    period_hours: lookback,
    statuses: Object.fromEntries(stats.map((r) => [r.status, Number(r.cnt)])),
    total_emails: stats.reduce((sum, r) => sum + Number(r.cnt), 0),
    recent_errors,
    error_count: recent_errors.length
  };
}

async function get_email_log({ recipient, eid, limit }, sql) {
  const max_rows = Math.min(limit || 20, 50);

  let rows;

  if (recipient && eid) {
    rows = await sql`
      SELECT el.id, el.recipient, el.subject,
             el.status, el.error_message, el.sent_at, el.created_at,
             e.eid
      FROM email_logs el
      LEFT JOIN events e ON e.id = el.event_id
      WHERE el.recipient ILIKE ${'%' + recipient + '%'}
        AND e.eid = ${eid}
      ORDER BY el.created_at DESC
      LIMIT ${max_rows}
    `;
  } else if (recipient) {
    rows = await sql`
      SELECT el.id, el.recipient, el.subject,
             el.status, el.error_message, el.sent_at, el.created_at,
             e.eid
      FROM email_logs el
      LEFT JOIN events e ON e.id = el.event_id
      WHERE el.recipient ILIKE ${'%' + recipient + '%'}
      ORDER BY el.created_at DESC
      LIMIT ${max_rows}
    `;
  } else if (eid) {
    rows = await sql`
      SELECT el.id, el.recipient, el.subject,
             el.status, el.error_message, el.sent_at, el.created_at
      FROM email_logs el
      JOIN events e ON e.id = el.event_id
      WHERE e.eid = ${eid}
      ORDER BY el.created_at DESC
      LIMIT ${max_rows}
    `;
  } else {
    rows = await sql`
      SELECT el.id, el.recipient, el.subject,
             el.status, el.sent_at, el.created_at
      FROM email_logs el
      ORDER BY el.created_at DESC
      LIMIT ${max_rows}
    `;
  }

  return { emails: rows, count: rows.length };
}

async function check_rls_policies({ table_name }, sql) {
  let rows;

  if (table_name) {
    rows = await sql`
      SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies
      WHERE tablename = ${table_name}
      ORDER BY policyname
    `;
  } else {
    rows = await sql`
      SELECT schemaname, tablename, policyname, permissive, roles, cmd
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname
    `;
  }

  // Also check if RLS is enabled on the table
  let rls_status = [];
  if (table_name) {
    rls_status = await sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname = ${table_name} AND relkind = 'r'
    `;
  }

  return {
    policies: rows,
    count: rows.length,
    rls_enabled: rls_status.length > 0 ? rls_status[0].relrowsecurity : null,
    rls_forced: rls_status.length > 0 ? rls_status[0].relforcerowsecurity : null
  };
}

async function live_event_diagnostic({ eid }, sql) {
  const event = await sql`
    SELECT e.id, e.eid, e.name, e.enabled, e.show_in_app,
           e.event_start_datetime, e.event_end_datetime, e.currency,
           e.city_id, e.venue_id,
           c.name AS city_name, v.name AS venue_name
    FROM events e
    LEFT JOIN cities c ON c.id = e.city_id
    LEFT JOIN venues v ON v.id = e.venue_id
    WHERE e.eid = ${eid}
    LIMIT 1
  `;

  if (event.length === 0) return { error: `No event found for eid=${eid}` };
  const ev = event[0];

  const rounds = await sql`
    SELECT r.id, r.round_number, r.is_finished, r.created_at, r.closing_time
    FROM rounds r
    WHERE r.event_id = ${ev.id}
    ORDER BY r.round_number
  `;

  const contestants = await sql`
    SELECT rc.id, rc.round_id, rc.art_id, rc.easel_number,
           a.art_code AS artwork_title, a.status AS art_status,
           ap.name AS artist_name,
           r.round_number
    FROM round_contestants rc
    JOIN art a ON a.id = rc.art_id
    JOIN rounds r ON r.id = rc.round_id
    LEFT JOIN artist_profiles ap ON ap.id = a.artist_id
    WHERE r.event_id = ${ev.id}
    ORDER BY r.round_number, rc.easel_number
  `;

  const artworks = await sql`
    SELECT a.id, a.art_code, a.round, a.status, a.final_price,
           a.closing_time, a.artist_id,
           ap.name AS artist_name,
           COUNT(DISTINCT b.id) AS bid_count,
           COUNT(DISTINCT v.id) AS vote_count
    FROM art a
    LEFT JOIN artist_profiles ap ON ap.id = a.artist_id
    LEFT JOIN bids b ON b.art_id = a.id
    LEFT JOIN votes v ON v.art_uuid = a.id
    WHERE a.event_id = ${ev.id}
    GROUP BY a.id, a.art_code, a.round, a.status, a.final_price,
             a.closing_time, a.artist_id, ap.name
    ORDER BY a.round, a.art_code
  `;

  const vote_weight_summary = await sql`
    SELECT vw.from_source, COUNT(*) AS cnt, AVG(vw.vote_factor) AS avg_weight
    FROM vote_weights vw
    JOIN votes v ON v.person_id = vw.person_id AND v.event_id = vw.event_id
    JOIN art a ON a.id = v.art_uuid
    WHERE a.event_id = ${ev.id}
    GROUP BY vw.from_source
  `;

  const cache_status = await sql`
    SELECT endpoint_path, last_updated
    FROM endpoint_cache_versions
    WHERE event_eid = ${ev.id}::text
    ORDER BY last_updated DESC
  `;

  return {
    event: ev,
    rounds,
    contestants,
    artworks,
    vote_weight_summary,
    cache_status,
    summary: {
      round_count: rounds.length,
      contestant_count: contestants.length,
      artwork_count: artworks.length,
      active_rounds: rounds.filter((r) => !r.is_finished).length,
      total_bids: artworks.reduce((sum, a) => sum + Number(a.bid_count), 0),
      total_votes: artworks.reduce((sum, a) => sum + Number(a.vote_count), 0)
    }
  };
}

// ---------------------------------------------------------------------------
// Bot self-introspection tools (query esbmcp_ observability tables)
// ---------------------------------------------------------------------------

async function get_bot_errors({ hours_back, tool_name, limit }, sql) {
  const lookback = hours_back || 24;
  const max_rows = Math.min(limit || 20, 50);

  let rows;
  if (tool_name) {
    rows = await sql`
      SELECT te.id, te.tool_name, te.domain, te.error_type,
             te.error_message, te.error_code, te.error_hint,
             te.arguments_preview, te.resolved,
             te.slack_user_id, te.user_role,
             te.created_at
      FROM esbmcp_tool_errors te
      WHERE te.created_at > NOW() - (${lookback} || ' hours')::interval
        AND te.tool_name = ${tool_name}
      ORDER BY te.created_at DESC
      LIMIT ${max_rows}
    `;
  } else {
    rows = await sql`
      SELECT te.id, te.tool_name, te.domain, te.error_type,
             te.error_message, te.error_code, te.error_hint,
             te.arguments_preview, te.resolved,
             te.slack_user_id, te.user_role,
             te.created_at
      FROM esbmcp_tool_errors te
      WHERE te.created_at > NOW() - (${lookback} || ' hours')::interval
      ORDER BY te.created_at DESC
      LIMIT ${max_rows}
    `;
  }

  // Also get a summary by tool + error_type
  const summary = await sql`
    SELECT tool_name, error_type, COUNT(*) AS cnt
    FROM esbmcp_tool_errors
    WHERE created_at > NOW() - (${lookback} || ' hours')::interval
    GROUP BY tool_name, error_type
    ORDER BY cnt DESC
    LIMIT 20
  `;

  const unresolved = await sql`
    SELECT COUNT(*) AS cnt
    FROM esbmcp_tool_errors
    WHERE resolved = false
      AND created_at > NOW() - (${lookback} || ' hours')::interval
  `;

  return {
    errors: rows,
    count: rows.length,
    summary,
    unresolved_count: Number(unresolved[0]?.cnt || 0),
    period_hours: lookback
  };
}

async function get_bot_sessions({ hours_back, status, user_id, limit }, sql) {
  const lookback = hours_back || 24;
  const max_rows = Math.min(limit || 20, 50);

  const conditions = [
    sql`cs.created_at > NOW() - (${lookback} || ' hours')::interval`
  ];
  if (status) conditions.push(sql`cs.status = ${status}`);
  if (user_id) conditions.push(sql`cs.slack_user_id = ${user_id}`);

  const where = conditions.reduce((a, b) => sql`${a} AND ${b}`);

  const rows = await sql`
    SELECT cs.id, cs.slack_user_id, cs.slack_username, cs.user_role,
           cs.interaction_type, cs.status,
           LEFT(cs.user_prompt, 120) AS prompt_preview,
           cs.tool_call_count, cs.tools_called,
           cs.total_duration_ms, cs.error_message, cs.error_id,
           cs.ai_model,
           cs.prompt_tokens, cs.completion_tokens, cs.total_tokens, cs.api_rounds,
           cs.created_at
    FROM esbmcp_chat_sessions cs
    WHERE ${where}
    ORDER BY cs.created_at DESC
    LIMIT ${max_rows}
  `;

  // Summary stats
  const stats = await sql`
    SELECT status, COUNT(*) AS cnt,
           AVG(total_duration_ms)::int AS avg_duration_ms,
           AVG(tool_call_count)::numeric(10,1) AS avg_tools,
           SUM(prompt_tokens) AS total_prompt_tokens,
           SUM(completion_tokens) AS total_completion_tokens,
           SUM(total_tokens) AS total_tokens
    FROM esbmcp_chat_sessions
    WHERE created_at > NOW() - (${lookback} || ' hours')::interval
    GROUP BY status
    ORDER BY cnt DESC
  `;

  // Estimate cost based on model (rough pricing in USD per 1M tokens)
  const model_pricing = {
    "gpt-4o-mini": { input: 0.15, output: 0.60 },
    "gpt-4o": { input: 2.50, output: 10.00 },
    "gpt-4-turbo": { input: 10.00, output: 30.00 }
  };
  const all_prompt = stats.reduce((s, r) => s + Number(r.total_prompt_tokens || 0), 0);
  const all_completion = stats.reduce((s, r) => s + Number(r.total_completion_tokens || 0), 0);

  // Try to determine model from most recent session
  const model_name = rows[0]?.ai_model || "gpt-4o-mini";
  const pricing = model_pricing[model_name] || model_pricing["gpt-4o-mini"];
  const estimated_cost_usd = (all_prompt / 1_000_000) * pricing.input +
                             (all_completion / 1_000_000) * pricing.output;

  return {
    sessions: rows,
    count: rows.length,
    stats,
    token_totals: {
      prompt_tokens: all_prompt,
      completion_tokens: all_completion,
      total_tokens: all_prompt + all_completion,
      model: model_name,
      estimated_cost_usd: Math.round(estimated_cost_usd * 10000) / 10000
    },
    period_hours: lookback
  };
}

async function get_bot_tool_stats({ hours_back, limit }, sql) {
  const lookback = hours_back || 24;
  const max_rows = Math.min(limit || 30, 50);

  const by_tool = await sql`
    SELECT tool_name, domain,
           COUNT(*) AS total_calls,
           COUNT(*) FILTER (WHERE ok = true) AS success,
           COUNT(*) FILTER (WHERE ok = false) AS failures,
           AVG(duration_ms)::int AS avg_duration_ms,
           MAX(duration_ms) AS max_duration_ms
    FROM esbmcp_tool_executions
    WHERE created_at > NOW() - (${lookback} || ' hours')::interval
    GROUP BY tool_name, domain
    ORDER BY total_calls DESC
    LIMIT ${max_rows}
  `;

  const by_user = await sql`
    SELECT slack_user_id, user_role,
           COUNT(*) AS total_calls,
           COUNT(DISTINCT tool_name) AS unique_tools
    FROM esbmcp_tool_executions
    WHERE created_at > NOW() - (${lookback} || ' hours')::interval
    GROUP BY slack_user_id, user_role
    ORDER BY total_calls DESC
    LIMIT 10
  `;

  const totals = await sql`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE ok = true) AS success,
           COUNT(*) FILTER (WHERE ok = false) AS failures,
           AVG(duration_ms)::int AS avg_duration_ms
    FROM esbmcp_tool_executions
    WHERE created_at > NOW() - (${lookback} || ' hours')::interval
  `;

  return {
    by_tool,
    by_user,
    totals: totals[0] || {},
    period_hours: lookback
  };
}

// ---------------------------------------------------------------------------
// Bug reports
// ---------------------------------------------------------------------------

async function create_bug_report({ title, description, related_eid, priority }, sql, _edge, _config, request_context) {
  if (!title || title.trim().length < 3) {
    return { error: "Bug report title is required (at least 3 characters)." };
  }

  const rows = await sql`
    INSERT INTO esbmcp_bug_reports (
      slack_user_id, slack_username, slack_channel_id,
      title, description, related_eid, priority
    ) VALUES (
      ${request_context?.user_id || "unknown"},
      ${request_context?.username || null},
      ${request_context?.channel_id || null},
      ${title.trim()},
      ${(description || "").trim() || null},
      ${related_eid || null},
      ${priority || "normal"}
    )
    RETURNING id, title, status, priority, created_at
  `;

  return { created: true, bug_report: rows[0] };
}

async function get_bug_reports({ status, limit }, sql) {
  const max_rows = Math.min(limit || 20, 50);
  const status_filter = status ? sql`AND status = ${status}` : sql``;

  const rows = await sql`
    SELECT id, slack_user_id, slack_username, title, description,
           related_eid, status, priority,
           resolved_by, resolution_note, resolved_at,
           created_at
    FROM esbmcp_bug_reports
    WHERE 1=1 ${status_filter}
    ORDER BY created_at DESC
    LIMIT ${max_rows}
  `;

  const open_count = await sql`
    SELECT COUNT(*) AS cnt FROM esbmcp_bug_reports WHERE status IN ('open', 'in_progress')
  `;

  return { bug_reports: rows, count: rows.length, open_count: Number(open_count[0]?.cnt || 0) };
}

const platform_ops_tools = {
  get_slack_queue_health,
  get_email_queue_stats,
  get_email_log,
  check_rls_policies,
  live_event_diagnostic,
  get_bot_errors,
  get_bot_sessions,
  get_bot_tool_stats,
  create_bug_report,
  get_bug_reports
};

export { platform_ops_tools };
