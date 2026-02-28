// payments domain — 9 tools
// Skills: 11-16

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function require_uuid(value, field_name) {
  if (!value || !UUID_RE.test(value)) {
    return { error: `${field_name} must be a valid UUID. Use lookup_artist_profile or lookup_person first to get the real ID.` };
  }
  return null;
}

async function get_artist_stripe_status({ artist_profile_id, eid }, sql) {
  if (artist_profile_id) { const err = require_uuid(artist_profile_id, "artist_profile_id"); if (err) return err; }
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
  if (artist_profile_id) { const err = require_uuid(artist_profile_id, "artist_profile_id"); if (err) return err; }
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

async function get_artists_owed({ eid, artist_profile_id }, sql) {
  if (artist_profile_id) { const err = require_uuid(artist_profile_id, "artist_profile_id"); if (err) return err; }

  const artist_filter = artist_profile_id ? sql`AND a.artist_id = ${artist_profile_id}::uuid` : sql``;
  const eid_filter = eid ? sql`AND e.eid = ${eid}` : sql``;

  // Credits and debits run concurrently — they are independent queries
  const debit_filter = artist_profile_id
    ? sql`WHERE ap2.artist_profile_id = ${artist_profile_id}::uuid AND ap2.status != 'cancelled'`
    : sql`WHERE ap2.status != 'cancelled'`;

  const [credits, debits] = await Promise.all([
    sql`
      SELECT a.artist_id,
             ap.name AS artist_name,
             e.currency,
             SUM(COALESCE(a.final_price, a.current_bid, 0) * COALESCE(e.artist_auction_portion, 0.5)) AS total_credits
      FROM art a
      JOIN events e ON e.id = a.event_id
      JOIN artist_profiles ap ON ap.id = a.artist_id
      WHERE a.status = 'paid'
        AND COALESCE(a.final_price, a.current_bid, 0) > 0
        ${eid_filter} ${artist_filter}
      GROUP BY a.artist_id, ap.name, e.currency
    `,
    sql`
      SELECT ap2.artist_profile_id AS artist_id,
             SUM(ap2.gross_amount) AS total_debits
      FROM artist_payments ap2
      ${debit_filter}
      GROUP BY ap2.artist_profile_id
    `
  ]);

  // Merge credits and debits per artist+currency
  const debit_map = new Map();
  for (const d of debits) debit_map.set(d.artist_id, Number(d.total_debits || 0));

  const results = [];
  // Group credits by artist
  const by_artist = new Map();
  for (const c of credits) {
    if (!by_artist.has(c.artist_id)) {
      by_artist.set(c.artist_id, { artist_name: c.artist_name, currencies: [] });
    }
    by_artist.get(c.artist_id).currencies.push({
      currency: c.currency,
      credits: Number(c.total_credits || 0)
    });
  }

  for (const [artist_id, info] of by_artist) {
    const total_credits = info.currencies.reduce((s, c) => s + c.credits, 0);
    const total_debits = debit_map.get(artist_id) || 0;
    const balance = Math.max(0, Math.round((total_credits - total_debits) * 100) / 100);
    if (balance < 0.01) continue;

    results.push({
      artist_id,
      artist_name: info.artist_name,
      total_credits: Math.round(total_credits * 100) / 100,
      total_debits: Math.round(total_debits * 100) / 100,
      balance,
      currency_breakdown: info.currencies
    });
  }

  results.sort((a, b) => b.balance - a.balance);
  const total_owed = results.reduce((sum, r) => sum + r.balance, 0);

  // For large result sets, return a summary to avoid overwhelming the AI context
  if (results.length > 25) {
    // Group totals by currency using per-currency credits (not the merged balance)
    const by_currency = {};
    for (const r of results) {
      for (const cb of r.currency_breakdown) {
        const cur = cb.currency || "UNKNOWN";
        if (!by_currency[cur]) by_currency[cur] = { currency: cur, total_credits: 0, artist_count: 0 };
        by_currency[cur].total_credits += cb.credits;
        by_currency[cur].artist_count++;
      }
    }

    return {
      count: results.length,
      total_owed: Math.round(total_owed * 100) / 100,
      currency_summary: Object.values(by_currency).map((c) => ({
        currency: c.currency,
        artist_count: c.artist_count,
        total_credits: Math.round(c.total_credits * 100) / 100
      })),
      top_20: results.slice(0, 20).map((r) => ({
        artist_name: r.artist_name,
        balance: r.balance,
        currency_breakdown: r.currency_breakdown
      })),
      note: `Showing top 20 of ${results.length} unpaid artists sorted by balance descending. Use eid filter or artist_profile_id to narrow results.`
    };
  }

  return { artists_owed: results, count: results.length, total_owed: Math.round(total_owed * 100) / 100 };
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
  if (artist_profile_id) { const err = require_uuid(artist_profile_id, "artist_profile_id"); if (err) return err; }
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
