// data_read domain — 15 read-only SQL tools
// Skills: 1-5, 17-20, 22-24, 28-30

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function require_uuid(value, field_name) {
  if (!value || !UUID_RE.test(value)) {
    return { error: `${field_name} must be a valid UUID. Use lookup_artist_profile or lookup_person first to get the real ID.` };
  }
  return null;
}

async function lookup_event({ eid, city, limit }, sql) {
  // Search by city name if no eid provided
  if (!eid && city) {
    const max_rows = Math.min(limit || 10, 25);
    const rows = await sql`
      SELECT
        e.id, e.eid, e.name, e.event_start_datetime, e.event_end_datetime,
        e.timezone_icann,
        e.enabled, e.currency, e.show_in_app, e.event_level,
        e.city_id, c.name AS city_name, c.country_id,
        e.venue_id, v.name AS venue_name
      FROM events e
      LEFT JOIN cities c ON c.id = e.city_id
      LEFT JOIN venues v ON v.id = e.venue_id
      WHERE c.name ILIKE ${'%' + city + '%'}
      ORDER BY e.event_start_datetime DESC
      LIMIT ${max_rows}
    `;
    return { events: rows, count: rows.length, search: { city } };
  }

  if (!eid) return { error: "Provide either an eid (e.g. AB4003) or a city name." };

  const rows = await sql`
    SELECT
      e.id, e.eid, e.name, e.event_start_datetime, e.event_end_datetime,
      e.timezone_icann,
      e.enabled, e.currency, e.show_in_app, e.event_level,
      e.eventbrite_id, e.meta_ads_budget, e.capacity,
      e.city_id, c.name AS city_name, c.country_id,
      e.venue_id, v.name AS venue_name, v.address AS venue_address
    FROM events e
    LEFT JOIN cities c ON c.id = e.city_id
    LEFT JOIN venues v ON v.id = e.venue_id
    WHERE e.eid = ${eid}
    LIMIT 1
  `;
  if (rows.length === 0) return { error: `No event found for eid=${eid}` };
  return rows[0];
}

async function lookup_person({ query, search_by }, sql) {
  const field = search_by || "email";
  let rows;

  if (field === "email") {
    rows = await sql`
      SELECT id, first_name, last_name, email, phone, created_at
      FROM people
      WHERE email ILIKE ${'%' + query + '%'}
      ORDER BY created_at DESC LIMIT 10
    `;
  } else if (field === "phone") {
    rows = await sql`
      SELECT id, first_name, last_name, email, phone, created_at
      FROM people
      WHERE phone ILIKE ${'%' + query + '%'}
      ORDER BY created_at DESC LIMIT 10
    `;
  } else if (field === "name") {
    rows = await sql`
      SELECT id, first_name, last_name, email, phone, created_at
      FROM people
      WHERE (first_name || ' ' || last_name) ILIKE ${'%' + query + '%'}
      ORDER BY created_at DESC LIMIT 10
    `;
  } else {
    return { error: `Invalid search_by field: ${field}. Use email, phone, or name.` };
  }

  return { results: rows, count: rows.length };
}

async function lookup_artist_profile({ query, search_by }, sql) {
  const field = search_by || "name";
  let rows;

  if (field === "name") {
    rows = await sql`
      SELECT ap.id, ap.name, ap.country, ap.abhq_bio,
             (ap.superseded_by IS NULL) AS is_active,
             ap.person_id, p.email, p.phone, p.first_name, p.last_name,
             ap.created_at
      FROM artist_profiles ap
      LEFT JOIN people p ON p.id = ap.person_id
      WHERE ap.name ILIKE ${'%' + query + '%'}
      ORDER BY ap.created_at DESC LIMIT 10
    `;
  } else if (field === "id") {
    const id_err = require_uuid(query, "query (artist profile id)"); if (id_err) return id_err;
    rows = await sql`
      SELECT ap.id, ap.name, ap.country, ap.abhq_bio,
             (ap.superseded_by IS NULL) AS is_active,
             ap.person_id, p.email, p.phone, p.first_name, p.last_name,
             ap.created_at
      FROM artist_profiles ap
      LEFT JOIN people p ON p.id = ap.person_id
      WHERE ap.id = ${query}::uuid
      LIMIT 1
    `;
  } else if (field === "person_id") {
    const id_err = require_uuid(query, "query (person id)"); if (id_err) return id_err;
    rows = await sql`
      SELECT ap.id, ap.name, ap.country, ap.abhq_bio,
             (ap.superseded_by IS NULL) AS is_active,
             ap.person_id, p.email, p.phone, p.first_name, p.last_name,
             ap.created_at
      FROM artist_profiles ap
      LEFT JOIN people p ON p.id = ap.person_id
      WHERE ap.person_id = ${query}::uuid
      LIMIT 10
    `;
  } else {
    return { error: `Invalid search_by: ${field}. Use name, id, or person_id.` };
  }

  return { results: rows, count: rows.length };
}

async function lookup_artwork_bids({ eid, artist_profile_id }, sql) {
  if (artist_profile_id) { const err = require_uuid(artist_profile_id, "artist_profile_id"); if (err) return err; }
  let rows;

  if (artist_profile_id) {
    rows = await sql`
      SELECT a.id AS art_id, a.art_code, a.round, a.status, a.final_price,
             a.closing_time, a.artist_id, ap.name AS artist_name,
             COUNT(b.id) AS bid_count,
             MAX(b.amount) AS max_bid,
             MIN(b.amount) AS min_bid
      FROM art a
      LEFT JOIN artist_profiles ap ON ap.id = a.artist_id
      LEFT JOIN bids b ON b.art_id = a.id
      JOIN events e ON e.id = a.event_id
      WHERE e.eid = ${eid} AND a.artist_id = ${artist_profile_id}::uuid
      GROUP BY a.id, a.art_code, a.round, a.status, a.final_price,
               a.closing_time, a.artist_id, ap.name
      ORDER BY a.round, a.art_code
    `;
  } else {
    rows = await sql`
      SELECT a.id AS art_id, a.art_code, a.round, a.status, a.final_price,
             a.closing_time, a.artist_id, ap.name AS artist_name,
             COUNT(b.id) AS bid_count,
             MAX(b.amount) AS max_bid,
             MIN(b.amount) AS min_bid
      FROM art a
      LEFT JOIN artist_profiles ap ON ap.id = a.artist_id
      LEFT JOIN bids b ON b.art_id = a.id
      JOIN events e ON e.id = a.event_id
      WHERE e.eid = ${eid}
      GROUP BY a.id, a.art_code, a.round, a.status, a.final_price,
               a.closing_time, a.artist_id, ap.name
      ORDER BY a.round, a.art_code
    `;
  }

  return { artworks: rows, count: rows.length };
}

async function get_vote_data({ eid, round }, sql) {
  const round_num = round ? Number(round) : null;
  const round_filter = round_num ? sql`AND a.round = ${round_num}` : sql``;

  const votes = await sql`
    SELECT v.id, v.person_id, v.art_id, v.created_at,
           a.art_code AS artwork_title, a.round,
           ap.name AS artist_name,
           vw.vote_factor, vw.from_source
    FROM votes v
    JOIN art a ON a.id = v.art_uuid
    JOIN events e ON e.id = a.event_id
    LEFT JOIN artist_profiles ap ON ap.id = a.artist_id
    LEFT JOIN vote_weights vw ON vw.person_id = v.person_id AND vw.event_id = v.event_id
    WHERE e.eid = ${eid} ${round_filter}
    ORDER BY a.round, v.created_at DESC
    LIMIT 500
  `;

  const summary = await sql`
    SELECT a.round,
           COUNT(DISTINCT v.id) AS vote_count,
           COUNT(DISTINCT v.person_id) AS unique_voters,
           COALESCE(SUM(vw.vote_factor), COUNT(v.id)) AS weighted_total
    FROM votes v
    JOIN art a ON a.id = v.art_uuid
    JOIN events e ON e.id = a.event_id
    LEFT JOIN vote_weights vw ON vw.person_id = v.person_id AND vw.event_id = v.event_id
    WHERE e.eid = ${eid} ${round_filter}
    GROUP BY a.round
    ORDER BY a.round
  `;

  return { votes: votes.slice(0, 100), summary, total_votes: votes.length };
}

async function debug_event_visibility({ eid }, sql) {
  const event = await sql`
    SELECT e.id, e.eid, e.name, e.show_in_app, e.enabled,
           e.event_start_datetime, e.event_end_datetime
    FROM events e
    WHERE e.eid = ${eid}
    LIMIT 1
  `;

  if (event.length === 0) return { error: `No event found for eid=${eid}` };

  const cache = await sql`
    SELECT * FROM endpoint_cache_versions
    WHERE endpoint_path = 'event' AND event_eid = ${event[0].eid}
    ORDER BY last_updated DESC LIMIT 5
  `;

  const flags = event[0];
  const issues = [];
  if (!flags.show_in_app) issues.push("show_in_app=false — event not visible in app");
  if (!flags.enabled) issues.push("enabled=false — event not enabled");

  return { event: flags, cache_versions: cache, issues, issue_count: issues.length };
}

async function get_event_config({ eid }, sql) {
  const rows = await sql`
    SELECT *
    FROM events
    WHERE eid = ${eid}
    LIMIT 1
  `;
  if (rows.length === 0) return { error: `No event found for eid=${eid}` };
  return rows[0];
}

async function run_event_health_check({ eid }, sql) {
  const event = await sql`
    SELECT e.id, e.eid, e.name, e.enabled, e.event_start_datetime,
           e.city_id, e.venue_id, e.currency, e.eventbrite_id
    FROM events e WHERE e.eid = ${eid} LIMIT 1
  `;

  if (event.length === 0) return { error: `No event found for eid=${eid}` };
  const ev = event[0];
  const checks = [];

  if (!ev.city_id) checks.push({ rule: "missing_city", severity: "error", message: "No city assigned" });
  if (!ev.venue_id) checks.push({ rule: "missing_venue", severity: "error", message: "No venue assigned" });
  if (!ev.currency) checks.push({ rule: "missing_currency", severity: "error", message: "No currency set" });
  if (!ev.event_start_datetime) checks.push({ rule: "missing_start_time", severity: "error", message: "No start time" });

  const artists = await sql`
    SELECT COUNT(*) AS cnt
    FROM art a WHERE a.event_id = ${ev.id}
  `;
  if (Number(artists[0].cnt) === 0) {
    checks.push({ rule: "no_artworks", severity: "warning", message: "No artworks registered" });
  }

  // linter_suppressions table does not exist — return empty array
  const suppressions = [];

  return {
    event: { eid: ev.eid, name: ev.name, enabled: ev.enabled },
    checks,
    suppressed_rules: suppressions,
    pass: checks.filter((c) => c.severity === "error").length === 0
  };
}

async function get_event_summary({ eid }, sql) {
  const event = await sql`
    SELECT e.id, e.eid, e.name, e.enabled, e.currency,
           e.event_start_datetime, e.event_end_datetime
    FROM events e WHERE e.eid = ${eid} LIMIT 1
  `;

  if (event.length === 0) return { error: `No event found for eid=${eid}` };
  const ev = event[0];

  const art_stats = await sql`
    SELECT
      COUNT(*) AS total_artworks,
      COUNT(CASE WHEN final_price IS NOT NULL AND final_price > 0 THEN 1 END) AS sold_count,
      COALESCE(SUM(final_price), 0) AS total_revenue,
      MAX(final_price) AS highest_sale,
      COUNT(DISTINCT artist_id) AS unique_artists
    FROM art WHERE event_id = ${ev.id}
  `;

  const bid_stats = await sql`
    SELECT COUNT(*) AS total_bids, COUNT(DISTINCT person_id) AS unique_bidders
    FROM bids b
    JOIN art a ON a.id = b.art_id
    WHERE a.event_id = ${ev.id}
  `;

  const vote_stats = await sql`
    SELECT COUNT(*) AS total_votes, COUNT(DISTINCT person_id) AS unique_voters
    FROM votes v
    JOIN art a ON a.id = v.art_uuid
    WHERE a.event_id = ${ev.id}
  `;

  return {
    event: { eid: ev.eid, name: ev.name, enabled: ev.enabled, currency: ev.currency },
    dates: { start: ev.event_start_datetime, end: ev.event_end_datetime },
    artworks: art_stats[0],
    bids: bid_stats[0],
    votes: vote_stats[0]
  };
}

async function get_bid_history({ eid, art_id }, sql) {
  if (art_id) { const err = require_uuid(art_id, "art_id"); if (err) return err; }
  let rows;

  if (art_id) {
    rows = await sql`
      SELECT b.id, b.amount, b.created_at,
             b.person_id, p.first_name, p.last_name, p.email, p.phone,
             a.art_code AS artwork_title, a.round
      FROM bids b
      JOIN art a ON a.id = b.art_id
      JOIN people p ON p.id = b.person_id
      JOIN events e ON e.id = a.event_id
      WHERE e.eid = ${eid} AND a.id = ${art_id}::uuid
      ORDER BY b.amount DESC, b.created_at DESC
      LIMIT 100
    `;
  } else {
    rows = await sql`
      SELECT b.id, b.amount, b.created_at,
             b.person_id, p.first_name, p.last_name, p.email, p.phone,
             a.art_code AS artwork_title, a.round
      FROM bids b
      JOIN art a ON a.id = b.art_id
      JOIN people p ON p.id = b.person_id
      JOIN events e ON e.id = a.event_id
      WHERE e.eid = ${eid}
      ORDER BY b.amount DESC, b.created_at DESC
      LIMIT 200
    `;
  }

  return { bids: rows, count: rows.length };
}

async function get_auction_timing({ eid }, sql) {
  const rows = await sql`
    SELECT a.id AS art_id, a.art_code, a.round, a.status,
           a.closing_time, a.created_at,
           ap.name AS artist_name,
           e.eid, e.name AS event_name
    FROM art a
    JOIN events e ON e.id = a.event_id
    LEFT JOIN artist_profiles ap ON ap.id = a.artist_id
    WHERE e.eid = ${eid}
    ORDER BY a.round, a.closing_time
  `;

  const rounds = await sql`
    SELECT r.id, r.round_number, r.is_finished, r.created_at, r.closing_time
    FROM rounds r
    JOIN events e ON e.id = r.event_id
    WHERE e.eid = ${eid}
    ORDER BY r.round_number
  `;

  return { artworks: rows, rounds, artwork_count: rows.length };
}

async function get_auction_revenue({ eid, group_by }, sql) {
  const grouping = group_by || "total";

  if (grouping === "artist") {
    const rows = await sql`
      SELECT ap.id AS artist_profile_id, ap.name AS artist_name,
             COUNT(a.id) AS artworks_sold,
             COALESCE(SUM(a.final_price), 0) AS total_revenue,
             MAX(a.final_price) AS highest_sale,
             e.currency
      FROM art a
      JOIN events e ON e.id = a.event_id
      LEFT JOIN artist_profiles ap ON ap.id = a.artist_id
      WHERE e.eid = ${eid} AND a.final_price IS NOT NULL AND a.final_price > 0
      GROUP BY ap.id, ap.name, e.currency
      ORDER BY total_revenue DESC
    `;
    return { breakdown: rows, group_by: "artist" };
  }

  if (grouping === "round") {
    const rows = await sql`
      SELECT a.round,
             COUNT(a.id) AS artworks_sold,
             COALESCE(SUM(a.final_price), 0) AS total_revenue,
             MAX(a.final_price) AS highest_sale,
             e.currency
      FROM art a
      JOIN events e ON e.id = a.event_id
      WHERE e.eid = ${eid} AND a.final_price IS NOT NULL AND a.final_price > 0
      GROUP BY a.round, e.currency
      ORDER BY a.round
    `;
    return { breakdown: rows, group_by: "round" };
  }

  // Total
  const rows = await sql`
    SELECT
      COUNT(a.id) AS total_artworks,
      COUNT(CASE WHEN a.final_price > 0 THEN 1 END) AS sold_count,
      COALESCE(SUM(a.final_price), 0) AS total_revenue,
      MAX(a.final_price) AS highest_sale,
      AVG(a.final_price) FILTER (WHERE a.final_price > 0) AS avg_sale_price,
      e.currency
    FROM art a
    JOIN events e ON e.id = a.event_id
    WHERE e.eid = ${eid}
    GROUP BY e.currency
  `;

  return { summary: rows[0] || {}, group_by: "total" };
}

async function get_eventbrite_data({ eid }, sql) {
  const event = await sql`
    SELECT e.id, e.eid, e.eventbrite_id
    FROM events e WHERE e.eid = ${eid} LIMIT 1
  `;

  if (event.length === 0) return { error: `No event found for eid=${eid}` };
  if (!event[0].eventbrite_id) return { error: `No Eventbrite ID linked to event ${eid}` };

  const cache = await sql`
    SELECT *
    FROM eventbrite_api_cache
    WHERE eventbrite_id = ${event[0].eventbrite_id}
    ORDER BY fetched_at DESC LIMIT 1
  `;

  return {
    eventbrite_id: event[0].eventbrite_id,
    cached_data: cache[0] || null,
    has_cache: cache.length > 0
  };
}

async function get_eventbrite_mapping({ eid }, sql) {
  const rows = await sql`
    SELECT e.eid, e.name, e.eventbrite_id, e.enabled
    FROM events e
    WHERE e.eid = ${eid}
    LIMIT 1
  `;

  if (rows.length === 0) return { error: `No event found for eid=${eid}` };
  return rows[0];
}

async function get_eventbrite_fees({ eid }, sql) {
  const event = await sql`
    SELECT e.id, e.eid, e.eventbrite_id
    FROM events e WHERE e.eid = ${eid} LIMIT 1
  `;

  if (event.length === 0) return { error: `No event found for eid=${eid}` };
  if (!event[0].eventbrite_id) return { error: `No Eventbrite ID linked to event ${eid}` };

  const cache = await sql`
    SELECT eventbrite_id,
           gross_revenue, taxes_collected, total_fees,
           net_deposit, total_tickets_sold, fetched_at
    FROM eventbrite_api_cache
    WHERE eventbrite_id = ${event[0].eventbrite_id}
    ORDER BY fetched_at DESC LIMIT 20
  `;

  return {
    eventbrite_id: event[0].eventbrite_id,
    fee_data: cache,
    count: cache.length
  };
}

const data_read_tools = {
  lookup_event,
  lookup_person,
  lookup_artist_profile,
  lookup_artwork_bids,
  get_vote_data,
  debug_event_visibility,
  get_event_config,
  run_event_health_check,
  get_event_summary,
  get_bid_history,
  get_auction_timing,
  get_auction_revenue,
  get_eventbrite_data,
  get_eventbrite_mapping,
  get_eventbrite_fees
};

export { data_read_tools };
