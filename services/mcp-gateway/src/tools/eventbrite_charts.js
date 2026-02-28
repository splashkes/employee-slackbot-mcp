// eventbrite_charts domain — 10 tools for Eventbrite ticket chart generation,
// comparator scoring, and scheduled autopost.
// Uses live Eventbrite API, QuickChart.io for rendering, and internal DB cache.

import crypto from "node:crypto";

// ─── Internal Helpers ────────────────────────────────────────────────────────

const EB_BASE = "https://www.eventbriteapi.com/v3";

async function eb_fetch(path, eb_config, rate_limit_ms) {
  if (rate_limit_ms > 0) {
    await new Promise((r) => setTimeout(r, rate_limit_ms));
  }
  const token = eb_config.private_token || eb_config.api_key;
  const res = await fetch(`${EB_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(eb_config.api_key ? { "X-Eventbrite-Api-Key": eb_config.api_key } : {})
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Eventbrite API ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function eb_fetch_paginated(path, eb_config, rate_limit_ms, collection_key, max_pages = 20) {
  const items = [];
  let page = 1;
  let has_more = true;
  while (has_more && page <= max_pages) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await eb_fetch(`${path}${sep}page=${page}`, eb_config, rate_limit_ms);
    const page_items = data[collection_key] || [];
    items.push(...page_items);
    has_more = data.pagination?.has_more_items === true;
    page++;
  }
  return items;
}

function expand_orders_to_attendees(order_rows) {
  const attendees = [];
  for (const o of order_rows) {
    const count = Math.min(o.attendee_count || 1, 200);
    const per_ticket = o.gross ? parseFloat(o.gross) / count : 0;
    for (let i = 0; i < count; i++) {
      attendees.push({
        created: o.order_created,
        costs: { gross: { major_value: String(per_ticket) } }
      });
    }
  }
  return attendees;
}

async function load_event_attendees(sql, eventbrite_id) {
  const cache = await sql`
    SELECT orders_summary, total_tickets_sold, gross_revenue
    FROM eventbrite_api_cache
    WHERE eventbrite_id = ${eventbrite_id}
    ORDER BY fetched_at DESC LIMIT 1
  `;
  let attendees = cache[0]?.orders_summary?.attendees || [];
  const ticket_count = cache[0]?.total_tickets_sold || 0;
  const revenue = parseFloat(cache[0]?.gross_revenue) || 0;

  // Fallback: build from eventbrite_orders_cache
  if (attendees.length === 0) {
    const order_rows = await sql`
      SELECT order_created, attendee_count, gross
      FROM eventbrite_orders_cache
      WHERE eventbrite_event_id = ${eventbrite_id}
        AND order_status = 'placed'
      ORDER BY order_created
    `;
    if (order_rows.length > 0) {
      attendees = expand_orders_to_attendees(order_rows);
    }
  }

  return { attendees, ticket_count: ticket_count || attendees.length, revenue };
}

function build_cumulative_timeline(attendees, event_start, event_date) {
  if (!attendees || attendees.length === 0) return [];

  const event_date_ms = new Date(event_date || event_start).getTime();

  // Build daily buckets
  const daily = {};
  for (const a of attendees) {
    const order_date = a.created || a.order_date;
    if (!order_date) continue;
    const order_ms = new Date(order_date).getTime();
    const days_until = Math.round((event_date_ms - order_ms) / (1000 * 60 * 60 * 24));
    if (days_until < 0 || days_until > 90) continue;
    if (!daily[days_until]) daily[days_until] = { tickets: 0, revenue: 0 };
    daily[days_until].tickets += 1;
    const cost = a.costs?.gross?.major_value ? parseFloat(a.costs.gross.major_value) : 0;
    daily[days_until].revenue += cost;
  }

  // Sort by days_until descending (earliest purchases first) and accumulate
  const sorted_days = Object.keys(daily).map(Number).sort((a, b) => b - a);
  const timeline = [];
  let cumulative_tickets = 0;
  let cumulative_revenue = 0;

  for (const days_until of sorted_days) {
    cumulative_tickets += daily[days_until].tickets;
    cumulative_revenue += daily[days_until].revenue;
    timeline.push({
      days_until_event: days_until,
      cumulative_tickets,
      cumulative_revenue: Math.round(cumulative_revenue * 100) / 100
    });
  }

  // Filter to 0-45 days range and sample to max 30 points
  const filtered = timeline.filter((p) => p.days_until_event <= 45);
  if (filtered.length <= 30) return filtered;

  const step = Math.ceil(filtered.length / 30);
  const sampled = filtered.filter((_, i) => i % step === 0);
  // Always include the last point
  if (sampled[sampled.length - 1] !== filtered[filtered.length - 1]) {
    sampled.push(filtered[filtered.length - 1]);
  }
  return sampled;
}

function score_comparator(target, candidate) {
  // City match: 1.0 if same city, 0.0 otherwise
  const city_score = target.city_name && candidate.city_name &&
    target.city_name.toLowerCase() === candidate.city_name.toLowerCase() ? 1.0 : 0.0;

  // Scale similarity: how close are ticket counts? 1.0 = identical, 0 = very different
  const t_tickets = target.total_tickets || 1;
  const c_tickets = candidate.total_tickets || 1;
  const ratio = Math.min(t_tickets, c_tickets) / Math.max(t_tickets, c_tickets);
  const scale_similarity = ratio;

  // Price similarity: how close are avg ticket prices?
  const t_price = target.avg_ticket_price || 0;
  const c_price = candidate.avg_ticket_price || 0;
  const price_ratio = (t_price > 0 && c_price > 0)
    ? Math.min(t_price, c_price) / Math.max(t_price, c_price)
    : 0.5;
  const price_similarity = price_ratio;

  // Recency: more recent events score higher. 1.0 for 30 days ago, 0 for 540 days ago
  const days_ago = candidate.days_ago || 365;
  const recency_score = Math.max(0, 1 - (days_ago - 30) / 510);

  // Weekday similarity: 1.0 if same day of week, 0.5 if weekend match, 0.0 otherwise
  const t_day = target.day_of_week;
  const c_day = candidate.day_of_week;
  let weekday_similarity = 0;
  if (t_day !== undefined && c_day !== undefined) {
    if (t_day === c_day) {
      weekday_similarity = 1.0;
    } else {
      const t_weekend = t_day === 0 || t_day === 6;
      const c_weekend = c_day === 0 || c_day === 6;
      weekday_similarity = (t_weekend === c_weekend) ? 0.5 : 0.0;
    }
  }

  // Weighted total: 0.45*city + 0.25*scale + 0.15*price + 0.10*recency + 0.05*weekday
  const total_score = Math.round((
    0.45 * city_score +
    0.25 * scale_similarity +
    0.15 * price_similarity +
    0.10 * recency_score +
    0.05 * weekday_similarity
  ) * 1000) / 1000;

  return {
    city_score: Math.round(city_score * 1000) / 1000,
    scale_similarity: Math.round(scale_similarity * 1000) / 1000,
    price_similarity: Math.round(price_similarity * 1000) / 1000,
    recency_score: Math.round(recency_score * 1000) / 1000,
    weekday_similarity: Math.round(weekday_similarity * 1000) / 1000,
    total_score
  };
}

async function render_chart({ target_event, target_timeline, comparators }) {
  const datasets = [];

  // Target event dataset
  datasets.push({
    label: `${target_event.eid} - ${target_event.name} (current)`,
    data: target_timeline.map((p) => ({ x: p.days_until_event, y: p.cumulative_tickets })),
    borderColor: "#FF6384",
    backgroundColor: "rgba(255, 99, 132, 0.1)",
    borderWidth: 3,
    pointRadius: 2,
    fill: true
  });

  // Comparator datasets
  const comparator_colors = ["#36A2EB", "#4BC0C0", "#FFCE56", "#9966FF", "#FF9F40"];
  for (let i = 0; i < comparators.length; i++) {
    const comp = comparators[i];
    if (!comp.timeline || comp.timeline.length === 0) continue;
    datasets.push({
      label: `${comp.eid} - ${comp.name} (${comp.city || "?"})`,
      data: comp.timeline.map((p) => ({ x: p.days_until_event, y: p.cumulative_tickets })),
      borderColor: comparator_colors[i % comparator_colors.length],
      borderWidth: 2,
      pointRadius: 1,
      borderDash: [5, 3],
      fill: false
    });
  }

  const chart_config = {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: `Ticket Sales Pace: ${target_event.eid} — ${target_event.name}`,
          font: { size: 16 }
        },
        legend: {
          position: "bottom",
          labels: { boxWidth: 12, font: { size: 10 } }
        }
      },
      scales: {
        x: {
          title: { display: true, text: "Days Until Event" },
          reverse: true,
          min: 0
        },
        y: {
          title: { display: true, text: "Cumulative Tickets Sold" },
          beginAtZero: true
        }
      }
    }
  };

  const render_start = Date.now();
  const qc_response = await fetch("https://quickchart.io/chart/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      backgroundColor: "white",
      width: 800,
      height: 450,
      format: "png",
      chart: chart_config
    }),
    signal: AbortSignal.timeout(15_000)
  });

  if (!qc_response.ok) {
    throw new Error(`QuickChart.io returned ${qc_response.status}`);
  }

  const qc_data = await qc_response.json();

  // Download the actual PNG so we can upload it to Slack
  const image_response = await fetch(qc_data.url, {
    signal: AbortSignal.timeout(15_000)
  });
  if (!image_response.ok) {
    throw new Error(`Failed to download chart image: ${image_response.status}`);
  }
  const image_buffer = Buffer.from(await image_response.arrayBuffer());
  const render_duration_ms = Date.now() - render_start;

  return {
    chart_url: qc_data.url,
    image_buffer,
    chart_config,
    render_duration_ms
  };
}

function compute_next_run(event_date, cadence) {
  const now = new Date();
  const event_ms = new Date(event_date).getTime();
  const days_until = Math.ceil((event_ms - now.getTime()) / (1000 * 60 * 60 * 24));

  let interval_days;
  if (cadence === "daily") {
    interval_days = 1;
  } else if (cadence === "every_2_days") {
    interval_days = 2;
  } else if (cadence === "weekly") {
    interval_days = 7;
  } else {
    // auto: compute from days until event
    if (days_until > 28) interval_days = 7;
    else if (days_until > 7) interval_days = 2;
    else interval_days = 1;
  }

  const next = new Date(now.getTime() + interval_days * 24 * 60 * 60 * 1000);
  // Normalize to 10 AM UTC
  next.setUTCHours(10, 0, 0, 0);
  return next.toISOString();
}

function should_skip_chart(current, last) {
  if (!last || !last.last_ticket_count) return false;

  const ticket_delta = Math.abs(current.ticket_count - last.last_ticket_count);
  const ticket_pct = last.last_ticket_count > 0
    ? (ticket_delta / last.last_ticket_count) * 100
    : 100;

  const pace_delta = last.last_pace_per_day > 0
    ? Math.abs(current.pace_per_day - last.last_pace_per_day) / last.last_pace_per_day * 100
    : 100;

  // Skip if pace change < 5% AND ticket change < 20%
  return pace_delta < 5 && ticket_pct < 20;
}

function hash_chart_config(config) {
  return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}


// ─── Tool Functions ──────────────────────────────────────────────────────────

async function refresh_eventbrite_data({ eid, force }, sql, _edge, config) {
  // Resolve eventbrite_id from event
  const events = await sql`
    SELECT e.id, e.eid, e.eventbrite_id, e.name,
           e.event_start_datetime, e.city_id,
           c.name AS city_name
    FROM events e
    LEFT JOIN cities c ON c.id = e.city_id
    WHERE e.eid = ${eid} LIMIT 1
  `;
  if (events.length === 0) return { error: `No event found for eid=${eid}` };
  const event = events[0];
  if (!event.eventbrite_id) return { error: `No Eventbrite ID linked to ${eid}` };

  // Check cache freshness (skip if < 1 hour unless force)
  if (!force) {
    const cache = await sql`
      SELECT fetched_at FROM eventbrite_api_cache
      WHERE eventbrite_id = ${event.eventbrite_id}
      ORDER BY fetched_at DESC LIMIT 1
    `;
    if (cache.length > 0) {
      const age_minutes = (Date.now() - new Date(cache[0].fetched_at).getTime()) / 60000;
      if (age_minutes < 60) {
        return {
          eid, eventbrite_id: event.eventbrite_id,
          skipped: true, reason: "cache_fresh",
          age_minutes: Math.round(age_minutes),
          message: `Cache is ${Math.round(age_minutes)} minutes old. Use force=true to refresh anyway.`
        };
      }
    }
  }

  // Refresh totals via Edge Function (writes to eventbrite_api_cache)
  if (_edge) {
    try {
      await _edge.invoke("fetch-eventbrite-data", {
        eid,
        force_refresh: !!force,
        fetch_reason: "mcp_refresh"
      });
    } catch (err) {
      // Non-fatal — we can still use existing cache
    }
  }

  // Fetch attendee-level data for chart timelines (writes to eventbrite_orders_cache)
  const eb = config.eventbrite;
  if (eb.private_token || eb.api_key) {
    try {
      const attendees = await eb_fetch_paginated(
        `/events/${event.eventbrite_id}/attendees/`,
        eb, eb.rate_limit_ms,
        "attendees", 20
      );
      // Upsert orders into eventbrite_orders_cache for timeline use
      for (const a of attendees) {
        const order_id = a.order_id || a.order?.id;
        if (!order_id) continue;
        await sql`
          INSERT INTO eventbrite_orders_cache (
            event_id, eid, eventbrite_event_id, order_id,
            order_created, order_status, attendee_count,
            gross, currency_code, fetched_at, fetched_by
          ) VALUES (
            ${event.id}, ${eid}, ${event.eventbrite_id}, ${order_id},
            ${a.created}, ${a.status || 'placed'}, ${1},
            ${a.costs?.gross?.major_value ? parseFloat(a.costs.gross.major_value) : 0},
            ${a.costs?.gross?.currency || 'USD'},
            NOW(), 'mcp-refresh'
          ) ON CONFLICT (order_id) DO NOTHING
        `;
      }
    } catch (err) {
      // Non-fatal — charts will use whatever data exists in cache
    }
  }

  // Read back from cache to return summary
  const latest = await sql`
    SELECT total_tickets_sold, gross_revenue, net_deposit, total_fees, fetched_at
    FROM eventbrite_api_cache
    WHERE eventbrite_id = ${event.eventbrite_id}
    ORDER BY fetched_at DESC LIMIT 1
  `;

  return {
    eid, eventbrite_id: event.eventbrite_id,
    refreshed: true,
    total_tickets_sold: latest[0]?.total_tickets_sold ?? 0,
    gross_revenue: parseFloat(latest[0]?.gross_revenue) || 0,
    net_deposit: parseFloat(latest[0]?.net_deposit) || 0,
    total_fees: parseFloat(latest[0]?.total_fees) || 0,
    fetched_at: latest[0]?.fetched_at || new Date().toISOString()
  };
}

async function verify_eventbrite_config({ eid }, sql, _edge, config) {
  const eb = config.eventbrite;
  const result = {
    token_valid: false,
    org_accessible: false,
    event_mapped: false,
    event_reachable: false,
    issues: []
  };

  // Check token
  if (!eb.private_token && !eb.api_key) {
    result.issues.push("EB_PRIVATE_TOKEN is not set");
    return result;
  }

  try {
    const me = await eb_fetch("/users/me/", eb, 0);
    result.token_valid = true;
    result.user_name = me.name;
    result.user_email = me.emails?.[0]?.email;
  } catch (err) {
    result.issues.push(`Token validation failed: ${err.message}`);
    return result;
  }

  // Check org access
  if (eb.org_id) {
    try {
      await eb_fetch(`/organizations/${eb.org_id}/`, eb, eb.rate_limit_ms);
      result.org_accessible = true;
    } catch (err) {
      result.issues.push(`Org ${eb.org_id} not accessible: ${err.message}`);
    }
  } else {
    result.issues.push("EVENTBRITE_ORG_ID is not set");
  }

  // Check event mapping
  if (!eid) {
    result.issues.push("No eid provided to check event mapping");
    return result;
  }

  const events = await sql`
    SELECT eid, eventbrite_id FROM events WHERE eid = ${eid} LIMIT 1
  `;
  if (events.length === 0) {
    result.issues.push(`No event found for eid=${eid}`);
    return result;
  }
  if (!events[0].eventbrite_id) {
    result.issues.push(`Event ${eid} has no eventbrite_id mapped`);
    return result;
  }

  result.event_mapped = true;
  result.eventbrite_id = events[0].eventbrite_id;

  // Check event reachable
  try {
    const ev = await eb_fetch(`/events/${events[0].eventbrite_id}/`, eb, eb.rate_limit_ms);
    result.event_reachable = true;
    result.event_name = ev.name?.text;
    result.event_status = ev.status;
  } catch (err) {
    result.issues.push(`Event ${events[0].eventbrite_id} not reachable: ${err.message}`);
  }

  return result;
}

async function get_chart_comparators({ eid, force_rescore }, sql, _edge, config) {
  const eb = config.eventbrite;

  // Get target event
  const events = await sql`
    SELECT e.id, e.eid, e.name, e.eventbrite_id,
           e.event_start_datetime, e.capacity,
           c.name AS city_name, c.id AS city_id
    FROM events e
    LEFT JOIN cities c ON c.id = e.city_id
    WHERE e.eid = ${eid} LIMIT 1
  `;
  if (events.length === 0) return { error: `No event found for eid=${eid}` };
  const target = events[0];
  if (!target.eventbrite_id) return { error: `No Eventbrite ID linked to ${eid}` };

  // Check for existing scored candidates (unless force_rescore)
  if (!force_rescore) {
    const existing = await sql`
      SELECT * FROM esbmcp_chart_comparator_candidates
      WHERE target_eid = ${eid}
      ORDER BY total_score DESC
    `;
    if (existing.length > 0) {
      const age_hours = (Date.now() - new Date(existing[0].scored_at).getTime()) / 3600000;
      if (age_hours < 24) {
        return {
          eid,
          comparators: existing,
          count: existing.length,
          source: "cache",
          age_hours: Math.round(age_hours * 10) / 10
        };
      }
    }
  }

  // Get target event's cached ticket data for scale comparison
  const target_cache = await sql`
    SELECT total_tickets_sold, gross_revenue FROM eventbrite_api_cache
    WHERE eventbrite_id = ${target.eventbrite_id}
    ORDER BY fetched_at DESC LIMIT 1
  `;
  const target_tickets = target_cache[0]?.total_tickets_sold || target.capacity || 100;
  const target_revenue = target_cache[0]?.gross_revenue || 0;
  const target_avg_price = target_tickets > 0 ? target_revenue / target_tickets : 0;
  const target_day = target.event_start_datetime
    ? new Date(target.event_start_datetime).getDay()
    : undefined;

  // Find candidate events: same city (30-540 days ago) + cross city (30-365 days ago)
  const same_city_candidates = target.city_id ? await sql`
    SELECT e.eid, e.name, e.eventbrite_id, e.event_start_datetime, e.capacity,
           c.name AS city_name,
           eac.total_tickets_sold, eac.gross_revenue,
           EXTRACT(DAY FROM (NOW() - e.event_start_datetime)) AS days_ago
    FROM events e
    LEFT JOIN cities c ON c.id = e.city_id
    LEFT JOIN eventbrite_api_cache eac ON eac.eventbrite_id = e.eventbrite_id
    WHERE e.city_id = ${target.city_id}
      AND e.eid != ${eid}
      AND e.eventbrite_id IS NOT NULL
      AND e.event_start_datetime < NOW()
      AND e.event_start_datetime > NOW() - INTERVAL '540 days'
      AND e.event_start_datetime < NOW() - INTERVAL '30 days'
    ORDER BY e.event_start_datetime DESC
    LIMIT 20
  ` : [];

  const cross_city_candidates = await sql`
    SELECT e.eid, e.name, e.eventbrite_id, e.event_start_datetime, e.capacity,
           c.name AS city_name,
           eac.total_tickets_sold, eac.gross_revenue,
           EXTRACT(DAY FROM (NOW() - e.event_start_datetime)) AS days_ago
    FROM events e
    LEFT JOIN cities c ON c.id = e.city_id
    LEFT JOIN eventbrite_api_cache eac ON eac.eventbrite_id = e.eventbrite_id
    WHERE e.eid != ${eid}
      AND e.eventbrite_id IS NOT NULL
      AND e.event_start_datetime < NOW()
      AND e.event_start_datetime > NOW() - INTERVAL '365 days'
      AND e.event_start_datetime < NOW() - INTERVAL '30 days'
      ${target.city_id ? sql`AND (e.city_id IS NULL OR e.city_id != ${target.city_id})` : sql``}
    ORDER BY e.event_start_datetime DESC
    LIMIT 30
  `;

  // Score all candidates
  const target_info = {
    city_name: target.city_name,
    total_tickets: target_tickets,
    avg_ticket_price: target_avg_price,
    day_of_week: target_day
  };

  const scored = [];
  for (const c of [...same_city_candidates, ...cross_city_candidates]) {
    const c_tickets = c.total_tickets_sold || c.capacity || 0;
    const c_avg_price = c_tickets > 0 && c.gross_revenue ? c.gross_revenue / c_tickets : 0;
    const c_day = c.event_start_datetime ? new Date(c.event_start_datetime).getDay() : undefined;
    const pool = same_city_candidates.some((sc) => sc.eid === c.eid) ? "same_city" : "cross_city";

    const scores = score_comparator(target_info, {
      city_name: c.city_name,
      total_tickets: c_tickets,
      avg_ticket_price: c_avg_price,
      days_ago: Number(c.days_ago) || 365,
      day_of_week: c_day
    });

    scored.push({
      target_eid: eid,
      candidate_eid: c.eid,
      candidate_name: c.name,
      candidate_city: c.city_name,
      candidate_date: c.event_start_datetime,
      candidate_total_tickets: c_tickets,
      pool,
      ...scores
    });
  }

  // Sort by total_score descending
  scored.sort((a, b) => b.total_score - a.total_score);

  // Select 3 same_city + 2 cross_city (with backfill)
  const same_pool = scored.filter((s) => s.pool === "same_city");
  const cross_pool = scored.filter((s) => s.pool === "cross_city");

  let selected = same_pool.slice(0, 3);
  let cross_needed = 2 + Math.max(0, 3 - selected.length);
  selected = selected.concat(cross_pool.slice(0, cross_needed));

  // Upsert to DB
  if (selected.length > 0) {
    // Clear old candidates
    await sql`DELETE FROM esbmcp_chart_comparator_candidates WHERE target_eid = ${eid}`;

    for (const s of scored) {
      await sql`
        INSERT INTO esbmcp_chart_comparator_candidates (
          target_eid, candidate_eid, candidate_name, candidate_city,
          candidate_date, candidate_total_tickets,
          city_score, scale_similarity, price_similarity,
          recency_score, weekday_similarity, total_score, pool
        ) VALUES (
          ${s.target_eid}, ${s.candidate_eid}, ${s.candidate_name},
          ${s.candidate_city}, ${s.candidate_date}, ${s.candidate_total_tickets},
          ${s.city_score}, ${s.scale_similarity}, ${s.price_similarity},
          ${s.recency_score}, ${s.weekday_similarity}, ${s.total_score}, ${s.pool}
        )
      `;
    }
  }

  return {
    eid,
    selected: selected.map((s) => ({
      eid: s.candidate_eid, name: s.candidate_name,
      city: s.candidate_city, score: s.total_score, pool: s.pool
    })),
    all_candidates: scored.length,
    same_city_count: same_pool.length,
    cross_city_count: cross_pool.length,
    source: "scored"
  };
}

async function set_chart_comparators({ eid, comparator_eids }, sql) {
  if (!comparator_eids || !Array.isArray(comparator_eids) || comparator_eids.length === 0) {
    return { error: "comparator_eids must be a non-empty array of event eids" };
  }

  // Verify all comparator eids exist
  const valid = await sql`
    SELECT eid FROM events WHERE eid = ANY(${comparator_eids})
  `;
  const valid_eids = valid.map((r) => r.eid);
  const invalid = comparator_eids.filter((e) => !valid_eids.includes(e));
  if (invalid.length > 0) {
    return { error: `Invalid eids: ${invalid.join(", ")}` };
  }

  // Update job if one exists
  const updated = await sql`
    UPDATE esbmcp_scheduled_chart_jobs
    SET comparator_mode = 'locked',
        locked_comparators = ${JSON.stringify(comparator_eids)},
        updated_at = NOW()
    WHERE eid = ${eid} AND status = 'active'
    RETURNING id, eid
  `;

  return {
    eid,
    locked_comparators: comparator_eids,
    job_updated: updated.length > 0,
    message: updated.length > 0
      ? `Locked ${comparator_eids.length} comparators on active job`
      : `Comparators saved. No active job found for ${eid} — will apply when a job is created.`
  };
}

async function generate_chart({ eid, include_comparators, comparator_eids }, sql, _edge, config) {
  // Get target event
  const events = await sql`
    SELECT e.id, e.eid, e.name, e.eventbrite_id,
           e.event_start_datetime,
           c.name AS city_name
    FROM events e
    LEFT JOIN cities c ON c.id = e.city_id
    WHERE e.eid = ${eid} LIMIT 1
  `;
  if (events.length === 0) return { error: `No event found for eid=${eid}` };
  const event = events[0];
  if (!event.eventbrite_id) return { error: `No Eventbrite ID linked to ${eid}` };

  // Refresh via Edge Function if cache is stale (> 6 hours)
  let cache_warning = null;
  const staleness_check = await sql`
    SELECT fetched_at FROM eventbrite_api_cache
    WHERE eventbrite_id = ${event.eventbrite_id}
    ORDER BY fetched_at DESC LIMIT 1
  `;
  const cache_age_ms = staleness_check.length > 0
    ? Date.now() - new Date(staleness_check[0].fetched_at).getTime()
    : Infinity;

  if (cache_age_ms > 6 * 3600000) {
    try {
      const refresh_result = await refresh_eventbrite_data({ eid, force: true }, sql, _edge, config);
      if (refresh_result.error) {
        if (staleness_check.length === 0) return refresh_result;
        cache_warning = `Using stale cache (refresh failed: ${refresh_result.error})`;
      }
    } catch (err) {
      if (staleness_check.length === 0) {
        return { error: `No cached Eventbrite data for ${eid} and refresh failed: ${err.message}` };
      }
      cache_warning = `Using stale cache (refresh failed: ${err.message})`;
    }
  }

  const { attendees, ticket_count, revenue } = await load_event_attendees(sql, event.eventbrite_id);

  // Build target timeline
  const target_timeline = build_cumulative_timeline(
    attendees,
    event.event_start_datetime,
    event.event_start_datetime
  );

  if (target_timeline.length === 0) {
    return {
      eid, error: "No attendee data to chart",
      ticket_count, revenue
    };
  }

  // Build comparator timelines
  const comparators = [];
  const should_compare = include_comparators !== false;

  if (should_compare) {
    let comp_eids = comparator_eids;

    if (!comp_eids || comp_eids.length === 0) {
      // Auto-select from candidates
      const candidates = await sql`
        SELECT candidate_eid FROM esbmcp_chart_comparator_candidates
        WHERE target_eid = ${eid}
        ORDER BY total_score DESC LIMIT 5
      `;
      comp_eids = candidates.map((c) => c.candidate_eid);

      // If no candidates cached, try scoring now
      if (comp_eids.length === 0) {
        const scoring_result = await get_chart_comparators({ eid }, sql, _edge, config);
        if (!scoring_result.error && scoring_result.selected) {
          comp_eids = scoring_result.selected.map((s) => s.eid);
        }
      }
    }

    // Load comparator data
    for (const comp_eid of comp_eids.slice(0, 5)) {
      const comp_event = await sql`
        SELECT e.eid, e.name, e.eventbrite_id, e.event_start_datetime,
               c.name AS city_name
        FROM events e
        LEFT JOIN cities c ON c.id = e.city_id
        WHERE e.eid = ${comp_eid} LIMIT 1
      `;
      if (comp_event.length === 0 || !comp_event[0].eventbrite_id) continue;

      const { attendees: comp_attendees } = await load_event_attendees(sql, comp_event[0].eventbrite_id);
      if (comp_attendees.length === 0) continue;

      const comp_timeline = build_cumulative_timeline(
        comp_attendees,
        comp_event[0].event_start_datetime,
        comp_event[0].event_start_datetime
      );

      if (comp_timeline.length > 0) {
        comparators.push({
          eid: comp_eid,
          name: comp_event[0].name,
          city: comp_event[0].city_name,
          timeline: comp_timeline
        });
      }
    }
  }

  // Render chart
  const render_result = await render_chart({
    target_event: event,
    target_timeline,
    comparators
  });
  const { chart_url, image_buffer, chart_config, render_duration_ms } = render_result;

  // Compute pace
  const days_range = target_timeline.length > 0
    ? Math.max(1, target_timeline[0].days_until_event - target_timeline[target_timeline.length - 1].days_until_event)
    : 1;
  const pace_per_day = Math.round((ticket_count / days_range) * 100) / 100;
  const days_until_event = target_timeline.length > 0
    ? target_timeline[target_timeline.length - 1].days_until_event
    : null;

  // Log to chart_posts_log
  const payload_hash = hash_chart_config(chart_config);
  await sql`
    INSERT INTO esbmcp_chart_posts_log (
      eid, chart_url, payload_hash, comparators_used,
      ticket_count, revenue, pace_per_day, days_until_event,
      render_duration_ms
    ) VALUES (
      ${eid}, ${chart_url}, ${payload_hash},
      ${JSON.stringify(comparators.map((c) => ({ eid: c.eid, name: c.name, city: c.city })))},
      ${ticket_count}, ${revenue}, ${pace_per_day}, ${days_until_event},
      ${render_duration_ms}
    )
  `;

  return {
    eid,
    chart_url,
    image_buffer,
    ticket_count,
    revenue,
    pace_per_day,
    days_until_event,
    comparators_used: comparators.map((c) => ({ eid: c.eid, name: c.name, city: c.city })),
    render_duration_ms,
    ...(cache_warning ? { cache_warning } : {})
  };
}

async function schedule_chart_autopost({ eid, slack_channel_id, cadence, comparator_eids }, sql, _edge, config, request_context) {
  if (!slack_channel_id) return { error: "slack_channel_id is required" };

  // Get event
  const events = await sql`
    SELECT e.eid, e.eventbrite_id, e.event_start_datetime, e.name
    FROM events e WHERE e.eid = ${eid} LIMIT 1
  `;
  if (events.length === 0) return { error: `No event found for eid=${eid}` };
  const event = events[0];
  if (!event.eventbrite_id) return { error: `No Eventbrite ID linked to ${eid}` };

  // Check for existing active job
  const existing = await sql`
    SELECT id FROM esbmcp_scheduled_chart_jobs
    WHERE eid = ${eid} AND status = 'active' LIMIT 1
  `;
  if (existing.length > 0) {
    return { error: `An active chart schedule already exists for ${eid}. Pause or cancel it first.` };
  }

  const selected_cadence = cadence || "auto";
  const auto_stop_at = new Date(new Date(event.event_start_datetime).getTime() + 2 * 24 * 3600000).toISOString();
  const next_run_at = compute_next_run(event.event_start_datetime, selected_cadence);
  const comparator_mode = comparator_eids && comparator_eids.length > 0 ? "locked" : "auto";

  const result = await sql`
    INSERT INTO esbmcp_scheduled_chart_jobs (
      eid, eventbrite_id, slack_channel_id, cadence,
      next_run_at, auto_stop_at,
      comparator_mode, locked_comparators,
      created_by
    ) VALUES (
      ${eid}, ${event.eventbrite_id}, ${slack_channel_id}, ${selected_cadence},
      ${next_run_at}, ${auto_stop_at},
      ${comparator_mode}, ${JSON.stringify(comparator_eids || [])},
      ${request_context?.user_id || null}
    )
    RETURNING id, eid, cadence, next_run_at, auto_stop_at, status
  `;

  return {
    ...result[0],
    event_name: event.name,
    slack_channel_id,
    comparator_mode,
    message: `Chart autopost scheduled for ${eid}. Next run: ${next_run_at}. Auto-stops: ${auto_stop_at}.`
  };
}

async function get_chart_schedule({ eid, status }, sql) {
  const status_filter = status ? sql`AND status = ${status}` : sql``;
  const eid_filter = eid ? sql`AND eid = ${eid}` : sql``;

  const jobs = await sql`
    SELECT id, eid, eventbrite_id, slack_channel_id, cadence,
           next_run_at, last_run_at, auto_stop_at,
           comparator_mode, locked_comparators,
           status, last_ticket_count, last_pace_per_day,
           created_by, created_at
    FROM esbmcp_scheduled_chart_jobs
    WHERE 1=1 ${eid_filter} ${status_filter}
    ORDER BY created_at DESC
    LIMIT 25
  `;

  return { jobs, count: jobs.length };
}

async function update_chart_schedule({ eid, action }, sql) {
  if (!eid) return { error: "eid is required" };
  if (!action || !["pause", "resume", "run_now", "cancel"].includes(action)) {
    return { error: "action must be one of: pause, resume, run_now, cancel" };
  }

  if (action === "pause") {
    const result = await sql`
      UPDATE esbmcp_scheduled_chart_jobs
      SET status = 'paused', updated_at = NOW()
      WHERE eid = ${eid} AND status = 'active'
      RETURNING id, eid, status
    `;
    if (result.length === 0) return { error: `No active job found for ${eid}` };
    return { ...result[0], message: `Chart schedule for ${eid} paused.` };
  }

  if (action === "resume") {
    const job = await sql`
      SELECT id, eid, event_start_datetime
      FROM esbmcp_scheduled_chart_jobs j
      JOIN events e ON e.eid = j.eid
      WHERE j.eid = ${eid} AND j.status = 'paused'
      LIMIT 1
    `;
    if (job.length === 0) return { error: `No paused job found for ${eid}` };

    const result = await sql`
      UPDATE esbmcp_scheduled_chart_jobs
      SET status = 'active', next_run_at = NOW(), updated_at = NOW()
      WHERE eid = ${eid} AND status = 'paused'
      RETURNING id, eid, status, next_run_at
    `;
    return { ...result[0], message: `Chart schedule for ${eid} resumed. Will run shortly.` };
  }

  if (action === "run_now") {
    const result = await sql`
      UPDATE esbmcp_scheduled_chart_jobs
      SET next_run_at = NOW(), updated_at = NOW()
      WHERE eid = ${eid} AND status = 'active'
      RETURNING id, eid, status, next_run_at
    `;
    if (result.length === 0) return { error: `No active job found for ${eid}` };
    return { ...result[0], message: `Chart for ${eid} queued for immediate run.` };
  }

  if (action === "cancel") {
    const result = await sql`
      UPDATE esbmcp_scheduled_chart_jobs
      SET status = 'completed', updated_at = NOW()
      WHERE eid = ${eid} AND status IN ('active', 'paused')
      RETURNING id, eid, status
    `;
    if (result.length === 0) return { error: `No active/paused job found for ${eid}` };
    return { ...result[0], message: `Chart schedule for ${eid} cancelled.` };
  }
}

async function get_chart_history({ eid, limit }, sql) {
  const max_rows = Math.min(limit || 20, 50);

  const logs = await sql`
    SELECT id, job_id, eid, chart_url, comparators_used,
           ticket_count, revenue, pace_per_day, days_until_event,
           skipped, skip_reason, render_duration_ms, created_at
    FROM esbmcp_chart_posts_log
    WHERE eid = ${eid}
    ORDER BY created_at DESC
    LIMIT ${max_rows}
  `;

  return { logs, count: logs.length };
}

async function get_chart_scheduler_status({ hours_back }, sql) {
  const lookback = hours_back || 24;

  const active_jobs = await sql`
    SELECT id, eid, cadence, next_run_at, last_run_at, status,
           last_ticket_count, last_pace_per_day
    FROM esbmcp_scheduled_chart_jobs
    WHERE status = 'active'
    ORDER BY next_run_at
  `;

  const recent_posts = await sql`
    SELECT eid, chart_url, ticket_count, pace_per_day,
           skipped, skip_reason, created_at
    FROM esbmcp_chart_posts_log
    WHERE created_at > NOW() - make_interval(hours => ${lookback})
    ORDER BY created_at DESC
    LIMIT 20
  `;

  const stats = await sql`
    SELECT
      COUNT(*) FILTER (WHERE NOT skipped) AS charts_posted,
      COUNT(*) FILTER (WHERE skipped) AS charts_skipped,
      COUNT(*) FILTER (WHERE skip_reason = 'error') AS errors
    FROM esbmcp_chart_posts_log
    WHERE created_at > NOW() - make_interval(hours => ${lookback})
  `;

  return {
    active_jobs,
    active_job_count: active_jobs.length,
    recent_posts,
    recent_post_count: recent_posts.length,
    stats: stats[0] || { charts_posted: 0, charts_skipped: 0, errors: 0 },
    hours_back: lookback
  };
}


// ─── Exports ─────────────────────────────────────────────────────────────────

const eventbrite_charts_tools = {
  refresh_eventbrite_data,
  verify_eventbrite_config,
  get_chart_comparators,
  set_chart_comparators,
  generate_chart,
  schedule_chart_autopost,
  get_chart_schedule,
  update_chart_schedule,
  get_chart_history,
  get_chart_scheduler_status
};

// Export helpers for use by chart_scheduler
export {
  eventbrite_charts_tools,
  build_cumulative_timeline,
  expand_orders_to_attendees,
  load_event_attendees,
  render_chart,
  compute_next_run,
  should_skip_chart,
  hash_chart_config,
  score_comparator
};
