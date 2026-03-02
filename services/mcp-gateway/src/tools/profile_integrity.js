// profile_integrity domain — 10 tools
// Skills: 6-10, 21, 25, 27

import { require_uuid } from "@abcodex/shared/validators.js";
import { require_mutating, require_edge, require_event } from "../tool_helpers.js";

async function find_duplicate_profiles({ query, search_by }, sql) {
  const field = search_by || "phone";

  if (field === "phone") {
    const rows = await sql`
      SELECT ap.id, ap.name, ap.country, (ap.superseded_by IS NULL) AS is_active,
             p.email, p.phone, p.first_name, p.last_name,
             ap.created_at
      FROM artist_profiles ap
      JOIN people p ON p.id = ap.person_id
      WHERE p.phone = ${query}
      ORDER BY ap.created_at DESC
    `;
    return { profiles: rows, count: rows.length, match_field: "phone" };
  }

  if (field === "email") {
    const rows = await sql`
      SELECT ap.id, ap.name, ap.country, (ap.superseded_by IS NULL) AS is_active,
             p.email, p.phone, p.first_name, p.last_name,
             ap.created_at
      FROM artist_profiles ap
      JOIN people p ON p.id = ap.person_id
      WHERE p.email ILIKE ${query}
      ORDER BY ap.created_at DESC
    `;
    return { profiles: rows, count: rows.length, match_field: "email" };
  }

  if (field === "name") {
    const rows = await sql`
      SELECT ap.id, ap.name, ap.country, (ap.superseded_by IS NULL) AS is_active,
             p.email, p.phone, p.first_name, p.last_name,
             ap.created_at
      FROM artist_profiles ap
      JOIN people p ON p.id = ap.person_id
      WHERE ap.name ILIKE ${'%' + query + '%'}
      ORDER BY ap.created_at DESC
      LIMIT 20
    `;
    return { profiles: rows, count: rows.length, match_field: "name" };
  }

  return { error: `Invalid search_by: ${field}. Use phone, email, or name.` };
}

async function update_artist_name({ artist_profile_id, new_name }, sql, _edge, service_config) {
  const id_err = require_uuid(artist_profile_id, "artist_profile_id"); if (id_err) return id_err;
  require_mutating(service_config);

  const current = await sql`
    SELECT id, name FROM artist_profiles WHERE id = ${artist_profile_id}::uuid LIMIT 1
  `;
  if (current.length === 0) return { error: `Artist profile ${artist_profile_id} not found` };

  const trimmed = new_name.trim();
  if (!trimmed || trimmed.length < 1) return { error: "Name cannot be empty" };
  if (trimmed.length > 200) return { error: "Name too long (max 200 chars)" };

  const result = await sql`
    UPDATE artist_profiles
    SET name = ${trimmed}, updated_at = NOW()
    WHERE id = ${artist_profile_id}::uuid
    RETURNING id, name
  `;

  return {
    updated: true,
    previous_name: current[0].name,
    new_name: result[0].name,
    artist_profile_id
  };
}

async function update_artist_bio({ artist_profile_id, new_bio }, sql, _edge, service_config) {
  const id_err = require_uuid(artist_profile_id, "artist_profile_id"); if (id_err) return id_err;
  require_mutating(service_config);

  const current = await sql`
    SELECT id, abhq_bio FROM artist_profiles WHERE id = ${artist_profile_id}::uuid LIMIT 1
  `;
  if (current.length === 0) return { error: `Artist profile ${artist_profile_id} not found` };

  const trimmed = (new_bio || "").trim();
  if (trimmed.length > 5000) return { error: "Bio too long (max 5000 chars)" };

  const result = await sql`
    UPDATE artist_profiles
    SET abhq_bio = ${trimmed}, updated_at = NOW()
    WHERE id = ${artist_profile_id}::uuid
    RETURNING id, abhq_bio
  `;

  return {
    updated: true,
    previous_bio_length: (current[0].abhq_bio || "").length,
    new_bio_length: result[0].abhq_bio.length,
    artist_profile_id
  };
}

async function update_artist_country({ artist_profile_id, new_country }, sql, _edge, service_config) {
  const id_err = require_uuid(artist_profile_id, "artist_profile_id"); if (id_err) return id_err;
  require_mutating(service_config);

  const current = await sql`
    SELECT id, country FROM artist_profiles WHERE id = ${artist_profile_id}::uuid LIMIT 1
  `;
  if (current.length === 0) return { error: `Artist profile ${artist_profile_id} not found` };

  const trimmed = new_country.trim().toUpperCase();
  if (trimmed.length < 2 || trimmed.length > 3) {
    return { error: "Country must be a 2 or 3 letter ISO code" };
  }

  const result = await sql`
    UPDATE artist_profiles
    SET country = ${trimmed}, updated_at = NOW()
    WHERE id = ${artist_profile_id}::uuid
    RETURNING id, country
  `;

  return {
    updated: true,
    previous_country: current[0].country,
    new_country: result[0].country,
    artist_profile_id
  };
}

async function get_artist_invitations({ eid, artist_profile_id }, sql) {
  if (artist_profile_id) { const err = require_uuid(artist_profile_id, "artist_profile_id"); if (err) return err; }
  let rows;

  if (eid && artist_profile_id) {
    rows = await sql`
      SELECT ai.id, ai.event_eid, ai.artist_profile_id, ai.status, ai.created_at,
             ai.message_from_producer, ai.accepted_at,
             e.eid, e.name AS event_name,
             ap.name AS artist_name
      FROM artist_invitations ai
      JOIN events e ON e.eid = ai.event_eid
      JOIN artist_profiles ap ON ap.id = ai.artist_profile_id
      WHERE e.eid = ${eid} AND ai.artist_profile_id = ${artist_profile_id}::uuid
      ORDER BY ai.created_at DESC
    `;
  } else if (eid) {
    rows = await sql`
      SELECT ai.id, ai.artist_profile_id, ai.status, ai.created_at,
             ai.message_from_producer, ai.accepted_at,
             ap.name AS artist_name
      FROM artist_invitations ai
      JOIN events e ON e.eid = ai.event_eid
      JOIN artist_profiles ap ON ap.id = ai.artist_profile_id
      WHERE e.eid = ${eid}
      ORDER BY ai.created_at DESC
    `;
  } else if (artist_profile_id) {
    rows = await sql`
      SELECT ai.id, ai.event_eid, ai.status, ai.created_at,
             ai.message_from_producer, ai.accepted_at,
             e.eid, e.name AS event_name
      FROM artist_invitations ai
      JOIN events e ON e.eid = ai.event_eid
      WHERE ai.artist_profile_id = ${artist_profile_id}::uuid
      ORDER BY ai.created_at DESC LIMIT 50
    `;
  } else {
    return { error: "Provide eid or artist_profile_id" };
  }

  const confirmed = rows.filter((r) => r.status === "accepted" || r.status === "confirmed");
  const pending = rows.filter((r) => r.status === "pending" || r.status === "invited");

  return { invitations: rows, count: rows.length, confirmed: confirmed.length, pending: pending.length };
}

async function send_artist_invitation({ eid, artist_profile_id, message_from_producer }, sql, edge, service_config) {
  require_mutating(service_config);
  const id_err = require_uuid(artist_profile_id, "artist_profile_id"); if (id_err) return id_err;
  require_edge(edge);
  if (!message_from_producer || !message_from_producer.trim()) {
    return { error: "message_from_producer is required — provide a short invitation message for the artist." };
  }

  const artist = await sql`
    SELECT id, entry_id, name FROM artist_profiles WHERE id = ${artist_profile_id}::uuid LIMIT 1
  `;
  if (artist.length === 0) return { error: `Artist profile ${artist_profile_id} not found` };
  if (!artist[0].entry_id) return { error: `Artist ${artist[0].name} has no entry_id — cannot send invitation` };

  const result = await edge.invoke("admin-send-invitation", {
    event_eid: eid,
    artist_number: artist[0].entry_id,
    artist_profile_id,
    message_from_producer: message_from_producer.trim()
  });

  return { sent: true, artist_name: artist[0].name, eid, result };
}

async function get_event_readiness({ eid }, sql) {
  const event = await sql`
    SELECT e.id, e.eid, e.name, e.enabled, e.event_start_datetime,
           e.city_id, e.venue_id, e.currency, e.eventbrite_id,
           e.show_in_app
    FROM events e WHERE e.eid = ${eid} LIMIT 1
  `;

  if (event.length === 0) return { error: `No event found for eid=${eid}` };
  const ev = event[0];

  const [artists, invitations, confirmations, applications] = await Promise.all([
    sql`
      SELECT COUNT(DISTINCT a.artist_id) AS artist_count,
             COUNT(a.id) AS artwork_count
      FROM art a WHERE a.event_id = ${ev.id}
    `,
    sql`
      SELECT status, COUNT(*) AS cnt
      FROM artist_invitations
      WHERE event_eid = ${ev.eid}
      GROUP BY status
    `,
    sql`
      SELECT COUNT(*) AS cnt
      FROM artist_confirmations
      WHERE event_eid = ${ev.eid}
        AND confirmation_status = 'confirmed'
    `,
    sql`
      SELECT COUNT(*) AS cnt
      FROM artist_applications
      WHERE event_eid = ${ev.eid}
    `
  ]);

  const confirmed_count = Number(confirmations[0]?.cnt || 0);

  const readiness = {
    has_venue: !!ev.venue_id,
    has_city: !!ev.city_id,
    has_currency: !!ev.currency,
    has_start_time: !!ev.event_start_datetime,
    has_artists: confirmed_count > 0 || Number(artists[0].artist_count) > 0,
    has_eventbrite: !!ev.eventbrite_id,
    enabled: ev.enabled,
    show_in_app: ev.show_in_app
  };

  const ready_count = Object.values(readiness).filter(Boolean).length;
  const total_checks = Object.keys(readiness).length;

  return {
    event: { eid: ev.eid, name: ev.name, enabled: ev.enabled },
    readiness,
    score: `${ready_count}/${total_checks}`,
    applications: Number(applications[0]?.cnt || 0),
    confirmed_artists: confirmed_count,
    invited_artists: Object.fromEntries(invitations.map((i) => [i.status, Number(i.cnt)])),
    artists_with_artwork: Number(artists[0].artist_count),
    artwork_count: Number(artists[0].artwork_count)
  };
}

async function get_vote_weights({ eid, round }, sql) {
  const round_filter = round ? sql`AND a.round = ${round}` : sql``;

  const rows = await sql`
    SELECT vw.id, vw.vote_factor, vw.from_source,
           vw.created_at, v.person_id, v.art_id,
           a.art_code AS artwork_title, a.round,
           ap.name AS artist_name
    FROM vote_weights vw
    JOIN votes v ON vw.person_id = v.person_id AND vw.event_id = v.event_id
    JOIN art a ON a.id = v.art_uuid
    JOIN events e ON e.id = a.event_id
    LEFT JOIN artist_profiles ap ON ap.id = a.artist_id
    WHERE e.eid = ${eid} ${round_filter}
    ORDER BY a.round, vw.from_source, vw.vote_factor DESC
    LIMIT 200
  `;

  const factor_summary = await sql`
    SELECT vw.from_source, COUNT(*) AS cnt,
           AVG(vw.vote_factor) AS avg_weight,
           MIN(vw.vote_factor) AS min_weight,
           MAX(vw.vote_factor) AS max_weight
    FROM vote_weights vw
    JOIN votes v ON vw.person_id = v.person_id AND vw.event_id = v.event_id
    JOIN art a ON a.id = v.art_uuid
    JOIN events e ON e.id = a.event_id
    WHERE e.eid = ${eid} ${round_filter}
    GROUP BY vw.from_source
    ORDER BY vw.from_source
  `;

  return { weights: rows, factor_summary, count: rows.length };
}

async function refresh_vote_weights({ eid }, sql, _edge, service_config) {
  require_mutating(service_config);

  const ev = await require_event(eid, sql);
  if (ev.error) return ev;

  const result = await sql`SELECT manual_refresh_vote_weights(${ev.id})`;

  return { refreshed: true, eid, result: result[0] };
}

async function get_qr_scan_status({ eid, person_id }, sql) {
  if (person_id) { const err = require_uuid(person_id, "person_id"); if (err) return err; }
  let rows;
  let total_count;

  if (person_id) {
    rows = await sql`
      SELECT qr.id, qr.code, qr.generated_at, qr.expires_at, qr.is_active,
             pqs.scan_timestamp, pqs.event_id,
             e.eid, e.name AS event_name,
             p.first_name, p.last_name, p.email
      FROM people_qr_scans pqs
      JOIN qr_codes qr ON qr.code = pqs.qr_code
      JOIN people p ON p.id = pqs.person_id
      LEFT JOIN events e ON e.id = pqs.event_id
      WHERE pqs.person_id = ${person_id}::uuid
      ORDER BY pqs.scan_timestamp DESC NULLS LAST
      LIMIT 50
    `;
  } else {
    const ev = await require_event(eid, sql);
    if (ev.error) return ev;

    const [detail, total] = await Promise.all([
      sql`
        SELECT qr.id, COALESCE(qr.code, pqs.qr_code) AS code,
               pqs.scan_timestamp, pqs.person_id,
               p.first_name, p.last_name, p.email
        FROM people_qr_scans pqs
        LEFT JOIN qr_codes qr ON qr.code = pqs.qr_code
        JOIN people p ON p.id = pqs.person_id
        WHERE pqs.event_id = ${ev.id}
        ORDER BY pqs.scan_timestamp DESC
        LIMIT 200
      `,
      sql`
        SELECT COUNT(*) AS cnt
        FROM people_qr_scans
        WHERE event_id = ${ev.id}
      `
    ]);
    rows = detail;
    total_count = Number(total[0].cnt);
  }

  return { scans: rows, count: total_count || rows.length, returned: rows.length };
}

const profile_integrity_tools = {
  find_duplicate_profiles,
  update_artist_name,
  update_artist_bio,
  update_artist_country,
  get_artist_invitations,
  send_artist_invitation,
  get_event_readiness,
  get_vote_weights,
  refresh_vote_weights,
  get_qr_scan_status
};

export { profile_integrity_tools };
