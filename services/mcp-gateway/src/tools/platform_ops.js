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

const platform_ops_tools = {
  get_slack_queue_health,
  get_email_queue_stats,
  get_email_log,
  check_rls_policies,
  live_event_diagnostic
};

export { platform_ops_tools };
