// payments domain — 9 tools
// Skills: 11-16

async function get_artist_stripe_status({ artist_profile_id, eid }, sql) {
  let rows;

  if (artist_profile_id) {
    rows = await sql`
      SELECT asa.id, asa.artist_profile_id, asa.stripe_account_id,
             asa.country, asa.onboarding_status, asa.charges_enabled, asa.payouts_enabled,
             asa.created_at, asa.updated_at,
             ap.name AS artist_name
      FROM artist_stripe_accounts asa
      JOIN artist_profiles ap ON ap.id = asa.artist_profile_id
      WHERE asa.artist_profile_id = ${artist_profile_id}::uuid
      ORDER BY asa.created_at DESC
    `;
  } else if (eid) {
    rows = await sql`
      SELECT asa.id, asa.artist_profile_id, asa.stripe_account_id,
             asa.country, asa.onboarding_status, asa.charges_enabled, asa.payouts_enabled,
             asa.created_at, asa.updated_at,
             ap.name AS artist_name
      FROM artist_stripe_accounts asa
      JOIN artist_profiles ap ON ap.id = asa.artist_profile_id
      JOIN art a ON a.artist_id = ap.id
      JOIN events e ON e.id = a.event_id
      WHERE e.eid = ${eid}
      GROUP BY asa.id, asa.artist_profile_id, asa.stripe_account_id,
               asa.country, asa.onboarding_status, asa.charges_enabled, asa.payouts_enabled,
               asa.created_at, asa.updated_at, ap.name
      ORDER BY ap.name
    `;
  } else {
    return { error: "Provide artist_profile_id or eid" };
  }

  return { accounts: rows, count: rows.length };
}

async function process_artist_payment({ eid, artist_profile_id, amount, currency }, _sql, edge, service_config) {
  if (!service_config.gateway.enable_mutating_tools) {
    throw new Error("Mutating tools are disabled by policy");
  }

  if (!edge) throw new Error("Edge function client not configured");

  const result = await edge.invoke("auto-process-artist-payments", {
    eid,
    artist_profile_id,
    amount,
    currency
  });

  return { processed: true, result };
}

async function get_exchange_rates({ currency, base_currency, target_currency }, sql) {
  let rows;

  if (currency) {
    rows = await sql`
      SELECT currency_code, rate_to_usd, last_updated
      FROM exchange_rates
      WHERE currency_code = ${currency.toUpperCase()}
    `;
  } else if (base_currency && target_currency) {
    // Cross-rate: get both currencies' USD rates and compute
    const pair = await sql`
      SELECT currency_code, rate_to_usd, last_updated
      FROM exchange_rates
      WHERE currency_code IN (${base_currency.toUpperCase()}, ${target_currency.toUpperCase()})
    `;
    const base = pair.find((r) => r.currency_code === base_currency.toUpperCase());
    const target = pair.find((r) => r.currency_code === target_currency.toUpperCase());
    if (base && target) {
      const cross_rate = target.rate_to_usd / base.rate_to_usd;
      return {
        base_currency: base.currency_code,
        target_currency: target.currency_code,
        cross_rate,
        base_rate_to_usd: base.rate_to_usd,
        target_rate_to_usd: target.rate_to_usd,
        last_updated: base.last_updated > target.last_updated ? target.last_updated : base.last_updated
      };
    }
    return { error: "One or both currencies not found", available: pair };
  } else {
    rows = await sql`
      SELECT currency_code, rate_to_usd, last_updated
      FROM exchange_rates
      ORDER BY currency_code
    `;
  }

  return { rates: rows, count: rows.length };
}

async function get_manual_payment_requests({ eid, status }, sql) {
  const status_filter = status ? sql`AND mpr.status = ${status}` : sql``;

  let rows;

  if (eid) {
    rows = await sql`
      SELECT mpr.id, mpr.artist_profile_id, mpr.events_referenced,
             mpr.requested_amount, mpr.preferred_currency, mpr.status,
             mpr.payment_method, mpr.admin_notes,
             mpr.created_at, mpr.processed_at,
             ap.name AS artist_name
      FROM artist_manual_payment_requests mpr
      JOIN artist_profiles ap ON ap.id = mpr.artist_profile_id
      WHERE ${eid} = ANY(mpr.events_referenced) ${status_filter}
      ORDER BY mpr.created_at DESC
    `;
  } else {
    rows = await sql`
      SELECT mpr.id, mpr.artist_profile_id, mpr.events_referenced,
             mpr.requested_amount, mpr.preferred_currency, mpr.status,
             mpr.payment_method, mpr.admin_notes,
             mpr.created_at, mpr.processed_at,
             ap.name AS artist_name
      FROM artist_manual_payment_requests mpr
      JOIN artist_profiles ap ON ap.id = mpr.artist_profile_id
      WHERE 1=1 ${status_filter}
      ORDER BY mpr.created_at DESC
      LIMIT 50
    `;
  }

  return { requests: rows, count: rows.length };
}

async function get_artist_payment_ledger({ artist_profile_id, eid }, sql) {
  let rows;

  if (artist_profile_id && eid) {
    rows = await sql`
      SELECT ap2.id AS payment_id, ap2.artist_profile_id, ap2.art_id,
             ap2.gross_amount, ap2.currency, ap2.status, ap2.payment_method,
             ap2.stripe_transfer_id, ap2.created_at, ap2.paid_at,
             a.art_code, a.final_price,
             e.eid, e.name AS event_name,
             apf.name AS artist_name
      FROM artist_payments ap2
      JOIN art a ON a.id = ap2.art_id
      JOIN events e ON e.id = a.event_id
      JOIN artist_profiles apf ON apf.id = ap2.artist_profile_id
      WHERE ap2.artist_profile_id = ${artist_profile_id}::uuid
        AND e.eid = ${eid}
      ORDER BY ap2.created_at DESC
    `;
  } else if (artist_profile_id) {
    rows = await sql`
      SELECT ap2.id AS payment_id, ap2.gross_amount, ap2.currency,
             ap2.status, ap2.payment_method, ap2.created_at,
             a.art_code, a.final_price,
             e.eid, e.name AS event_name
      FROM artist_payments ap2
      JOIN art a ON a.id = ap2.art_id
      JOIN events e ON e.id = a.event_id
      WHERE ap2.artist_profile_id = ${artist_profile_id}::uuid
      ORDER BY ap2.created_at DESC
      LIMIT 100
    `;
  } else if (eid) {
    rows = await sql`
      SELECT ap2.id AS payment_id, ap2.artist_profile_id,
             ap2.gross_amount, ap2.currency, ap2.status, ap2.payment_method,
             ap2.created_at,
             a.art_code, a.final_price,
             apf.name AS artist_name
      FROM artist_payments ap2
      JOIN art a ON a.id = ap2.art_id
      JOIN events e ON e.id = a.event_id
      JOIN artist_profiles apf ON apf.id = ap2.artist_profile_id
      WHERE e.eid = ${eid}
      ORDER BY apf.name, ap2.created_at DESC
    `;
  } else {
    return { error: "Provide artist_profile_id or eid" };
  }

  const total_paid = rows
    .filter((r) => r.status === "paid" || r.status === "completed")
    .reduce((sum, r) => sum + Number(r.gross_amount || 0), 0);

  return { payments: rows, count: rows.length, total_paid };
}

async function get_artists_owed({ eid }, sql) {
  const rows = await sql`
    SELECT a.artist_id,
           ap.name AS artist_name,
           e.eid, e.currency,
           COALESCE(SUM(a.final_price), 0) AS total_sales,
           COALESCE(SUM(CASE WHEN ap2.status IN ('paid', 'completed') THEN ap2.gross_amount ELSE 0 END), 0) AS total_paid,
           COALESCE(SUM(a.final_price), 0) -
             COALESCE(SUM(CASE WHEN ap2.status IN ('paid', 'completed') THEN ap2.gross_amount ELSE 0 END), 0) AS amount_owed
    FROM art a
    JOIN events e ON e.id = a.event_id
    JOIN artist_profiles ap ON ap.id = a.artist_id
    LEFT JOIN artist_payments ap2 ON ap2.art_id = a.id
    WHERE e.eid = ${eid}
      AND a.final_price IS NOT NULL AND a.final_price > 0
    GROUP BY a.artist_id, ap.name, e.eid, e.currency
    HAVING COALESCE(SUM(a.final_price), 0) -
           COALESCE(SUM(CASE WHEN ap2.status IN ('paid', 'completed') THEN ap2.gross_amount ELSE 0 END), 0) > 0
    ORDER BY amount_owed DESC
  `;

  const total_owed = rows.reduce((sum, r) => sum + Number(r.amount_owed || 0), 0);

  return { artists_owed: rows, count: rows.length, total_owed };
}

async function get_payment_status_health({ eid }, sql) {
  const art_statuses = await sql`
    SELECT a.status AS art_status, COUNT(*) AS cnt
    FROM art a
    JOIN events e ON e.id = a.event_id
    WHERE e.eid = ${eid}
    GROUP BY a.status
  `;

  const payment_statuses = await sql`
    SELECT ap2.status AS payment_status, COUNT(*) AS cnt
    FROM artist_payments ap2
    JOIN art a ON a.id = ap2.art_id
    JOIN events e ON e.id = a.event_id
    WHERE e.eid = ${eid}
    GROUP BY ap2.status
  `;

  // Cross-check: artworks sold but no payment record
  const sold_no_payment = await sql`
    SELECT a.id AS art_id, a.art_code, a.final_price,
           ap.name AS artist_name, a.artist_id
    FROM art a
    JOIN events e ON e.id = a.event_id
    JOIN artist_profiles ap ON ap.id = a.artist_id
    LEFT JOIN artist_payments ap2 ON ap2.art_id = a.id
    WHERE e.eid = ${eid}
      AND a.final_price IS NOT NULL AND a.final_price > 0
      AND ap2.id IS NULL
    ORDER BY a.art_code
  `;

  return {
    art_statuses: Object.fromEntries(art_statuses.map((r) => [r.art_status, Number(r.cnt)])),
    payment_statuses: Object.fromEntries(payment_statuses.map((r) => [r.payment_status, Number(r.cnt)])),
    sold_without_payment: sold_no_payment,
    sold_without_payment_count: sold_no_payment.length,
    healthy: sold_no_payment.length === 0
  };
}

async function get_payment_invitations({ eid, artist_profile_id }, sql) {
  let rows;

  if (eid) {
    rows = await sql`
      SELECT psi.id, psi.artist_profile_id, psi.status,
             psi.invitation_method, psi.recipient_email, psi.recipient_phone,
             psi.sent_by, psi.sent_at, psi.invitation_type,
             ap.name AS artist_name
      FROM payment_setup_invitations psi
      JOIN artist_profiles ap ON ap.id = psi.artist_profile_id
      JOIN art a ON a.artist_id = psi.artist_profile_id
      JOIN events e ON e.id = a.event_id
      WHERE e.eid = ${eid}
      GROUP BY psi.id, psi.artist_profile_id, psi.status,
               psi.invitation_method, psi.recipient_email, psi.recipient_phone,
               psi.sent_by, psi.sent_at, psi.invitation_type, ap.name
      ORDER BY psi.sent_at DESC
    `;
  } else if (artist_profile_id) {
    rows = await sql`
      SELECT psi.id, psi.artist_profile_id, psi.status,
             psi.invitation_method, psi.recipient_email, psi.recipient_phone,
             psi.sent_by, psi.sent_at, psi.invitation_type,
             ap.name AS artist_name
      FROM payment_setup_invitations psi
      JOIN artist_profiles ap ON ap.id = psi.artist_profile_id
      WHERE psi.artist_profile_id = ${artist_profile_id}::uuid
      ORDER BY psi.sent_at DESC
    `;
  } else {
    return { error: "Provide eid or artist_profile_id" };
  }

  return { invitations: rows, count: rows.length };
}

async function send_payment_reminder({ eid, artist_profile_id }, _sql, edge, service_config) {
  if (!service_config.gateway.enable_mutating_tools) {
    throw new Error("Mutating tools are disabled by policy");
  }

  if (!edge) throw new Error("Edge function client not configured");

  const result = await edge.invoke("admin-send-payment-reminder", {
    eid,
    artist_profile_id
  });

  return { sent: true, result };
}

const payments_tools = {
  get_artist_stripe_status,
  process_artist_payment,
  get_exchange_rates,
  get_manual_payment_requests,
  get_artist_payment_ledger,
  get_artists_owed,
  get_payment_status_health,
  get_payment_invitations,
  send_payment_reminder
};

export { payments_tools };
