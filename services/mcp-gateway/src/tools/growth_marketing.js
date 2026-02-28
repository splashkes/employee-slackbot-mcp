// growth_marketing domain — 7 read-only tools
// Skills: 31, 33-35, 48-49

async function get_meta_ads_data({ eid }, sql) {
  const event = await sql`
    SELECT e.id, e.eid, e.name, e.meta_ads_budget, e.other_ads_budget
    FROM events e WHERE e.eid = ${eid} LIMIT 1
  `;

  if (event.length === 0) return { error: `No event found for eid=${eid}` };

  // meta_ads_cache_cron_log is a cron log table (not per-event).
  // Fetch the latest cron run status separately.
  const cron_log = await sql`
    SELECT id, executed_at, status, total_events, successful, failed,
           skipped, errors, duration_ms, response
    FROM meta_ads_cache_cron_log
    ORDER BY executed_at DESC
    LIMIT 1
  `;

  return {
    event: {
      eid: event[0].eid,
      name: event[0].name,
      meta_ads_budget: event[0].meta_ads_budget,
      other_ads_budget: event[0].other_ads_budget
    },
    latest_cron_sync: cron_log.length > 0 ? cron_log[0] : null
  };
}

async function get_sms_campaigns({ eid, status }, sql) {
  const status_filter = status ? sql`AND smc.status = ${status}` : sql``;

  let rows;

  if (eid) {
    rows = await sql`
      SELECT smc.id, smc.name, smc.status, smc.template_id,
             smc.targeting_criteria, smc.scheduled_at, smc.started_at,
             smc.total_recipients, smc.messages_sent, smc.messages_delivered,
             smc.created_at,
             e.eid, e.name AS event_name
      FROM sms_marketing_campaigns smc
      JOIN events e ON e.id = smc.event_id
      WHERE e.eid = ${eid} ${status_filter}
      ORDER BY smc.created_at DESC
    `;
  } else {
    rows = await sql`
      SELECT smc.id, smc.name, smc.status, smc.template_id,
             smc.scheduled_at, smc.started_at,
             smc.total_recipients, smc.messages_sent, smc.messages_delivered,
             smc.created_at,
             e.eid, e.name AS event_name
      FROM sms_marketing_campaigns smc
      JOIN events e ON e.id = smc.event_id
      WHERE 1=1 ${status_filter}
      ORDER BY smc.created_at DESC
      LIMIT 30
    `;
  }

  return { campaigns: rows, count: rows.length };
}

async function get_sms_audience_count({ eid, audience_filter }, sql) {
  const event = await sql`
    SELECT id, eid FROM events WHERE eid = ${eid} LIMIT 1
  `;

  if (event.length === 0) return { error: `No event found for eid=${eid}` };

  // Basic audience count — count people associated with the event's city
  // or who have attended/bid at similar events
  const filter = audience_filter || "event_attendees";

  let count_result;

  if (filter === "event_attendees") {
    count_result = await sql`
      SELECT COUNT(DISTINCT p.id) AS audience_count
      FROM people p
      JOIN votes v ON v.person_id = p.id
      JOIN art a ON a.id = v.art_uuid
      WHERE a.event_id = ${event[0].id}
        AND p.phone IS NOT NULL AND p.phone != ''
    `;
  } else if (filter === "bidders") {
    count_result = await sql`
      SELECT COUNT(DISTINCT p.id) AS audience_count
      FROM people p
      JOIN bids b ON b.person_id = p.id
      JOIN art a ON a.id = b.art_id
      WHERE a.event_id = ${event[0].id}
        AND p.phone IS NOT NULL AND p.phone != ''
    `;
  } else if (filter === "all_with_phone") {
    count_result = await sql`
      SELECT COUNT(DISTINCT p.id) AS audience_count
      FROM people p
      WHERE p.phone IS NOT NULL AND p.phone != ''
    `;
  } else {
    return { error: `Unknown audience_filter: ${filter}. Use event_attendees, bidders, or all_with_phone.` };
  }

  return {
    eid,
    audience_filter: filter,
    audience_count: Number(count_result[0].audience_count)
  };
}

async function get_sms_conversation({ phone }, sql) {
  const inbound = await sql`
    SELECT id, from_phone, message_body, processed, created_at
    FROM sms_inbound
    WHERE from_phone = ${phone}
    ORDER BY created_at DESC LIMIT 50
  `;

  const outbound = await sql`
    SELECT id, to_phone, message_body, sent_at, status, created_at
    FROM sms_outbound
    WHERE to_phone = ${phone}
    ORDER BY sent_at DESC LIMIT 50
  `;

  // Merge and sort by time
  const all_messages = [
    ...inbound.map((m) => ({ ...m, direction: "inbound", timestamp: m.created_at })),
    ...outbound.map((m) => ({ ...m, direction: "outbound", timestamp: m.sent_at }))
  ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return {
    phone,
    messages: all_messages.slice(0, 50),
    inbound_count: inbound.length,
    outbound_count: outbound.length
  };
}

async function get_notification_status({ eid }, sql) {
  const event = await sql`
    SELECT id, eid FROM events WHERE eid = ${eid} LIMIT 1
  `;

  if (event.length === 0) return { error: `No event found for eid=${eid}` };

  // sms_outbound has campaign_id, not event_id.
  // Join through sms_marketing_campaigns to filter by event.
  const sms_status = await sql`
    SELECT so.status, COUNT(*) AS cnt
    FROM sms_outbound so
    JOIN sms_marketing_campaigns smc ON smc.id = so.campaign_id
    WHERE smc.event_id = ${event[0].id}
    GROUP BY so.status
  `;

  // message_queue also has campaign_id, not event_id.
  const queue = await sql`
    SELECT mq.status, COUNT(*) AS cnt
    FROM message_queue mq
    JOIN sms_marketing_campaigns smc ON smc.id = mq.campaign_id
    WHERE smc.event_id = ${event[0].id}
    GROUP BY mq.status
  `;

  return {
    eid,
    sms_statuses: Object.fromEntries(sms_status.map((r) => [r.status, Number(r.cnt)])),
    queue_statuses: Object.fromEntries(queue.map((r) => [r.status, Number(r.cnt)])),
    total_sms: sms_status.reduce((sum, r) => sum + Number(r.cnt), 0),
    total_queued: queue.reduce((sum, r) => sum + Number(r.cnt), 0)
  };
}

async function get_active_offers({ eid }, sql) {
  let rows;

  // offers have no event_id — they are not event-linked
  if (eid) {
    // Note: offers are not linked to events. Returning all active offers.
    rows = await sql`
      SELECT o.id, o.name, o.description, o.type, o.value,
             o.total_inventory, o.active, o.end_date, o.created_at,
             COUNT(orr.id) AS redemption_count
      FROM offers o
      LEFT JOIN offer_redemptions orr ON orr.offer_id = o.id
      WHERE o.active = true
      GROUP BY o.id, o.name, o.description, o.type, o.value,
               o.total_inventory, o.active, o.end_date, o.created_at
      ORDER BY o.created_at DESC
    `;
  } else {
    rows = await sql`
      SELECT o.id, o.name, o.description, o.type, o.value,
             o.total_inventory, o.active, o.end_date, o.created_at,
             COUNT(orr.id) AS redemption_count
      FROM offers o
      LEFT JOIN offer_redemptions orr ON orr.offer_id = o.id
      WHERE o.active = true
      GROUP BY o.id, o.name, o.description, o.type, o.value,
               o.total_inventory, o.active, o.end_date, o.created_at
      ORDER BY o.created_at DESC
      LIMIT 50
    `;
  }

  return {
    offers: rows,
    count: rows.length,
    ...(eid ? { note: "Offers are not linked to events. Showing all active offers." } : {})
  };
}

async function get_sponsorship_summary({ eid }, sql) {
  const event = await sql`
    SELECT id, eid, name FROM events WHERE eid = ${eid} LIMIT 1
  `;

  if (event.length === 0) return { error: `No event found for eid=${eid}` };

  const invites = await sql`
    SELECT si.id, si.prospect_name, si.prospect_email, si.discount_percent,
           si.notes, si.created_at, si.last_viewed_at, si.view_count
    FROM sponsorship_invites si
    WHERE si.event_id = ${event[0].id}
    ORDER BY si.created_at DESC
  `;

  const purchases = await sql`
    SELECT sp.id, sp.buyer_name, sp.buyer_email, sp.buyer_company,
           sp.package_details, sp.total_amount, sp.currency,
           sp.payment_status, sp.created_at
    FROM sponsorship_purchases sp
    WHERE sp.event_id = ${event[0].id}
    ORDER BY sp.created_at DESC
  `;

  const total_committed = purchases
    .filter((p) => p.payment_status === "paid" || p.payment_status === "completed")
    .reduce((sum, p) => sum + Number(p.total_amount || 0), 0);

  return {
    event: { eid: event[0].eid, name: event[0].name },
    invites,
    purchases,
    invite_count: invites.length,
    purchase_count: purchases.length,
    total_committed
  };
}

const growth_marketing_tools = {
  get_meta_ads_data,
  get_sms_campaigns,
  get_sms_audience_count,
  get_sms_conversation,
  get_notification_status,
  get_active_offers,
  get_sponsorship_summary
};

export { growth_marketing_tools };
