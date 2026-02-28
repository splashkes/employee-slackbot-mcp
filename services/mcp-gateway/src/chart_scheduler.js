// Chart autopost scheduler — polls esbmcp_scheduled_chart_jobs every 60s
// for active jobs whose next_run_at has passed. Generates charts and posts
// them to Slack channels. Runs inside the gateway process (no extra k8s resource).

import { Logger } from "./logger.js";
import {
  build_cumulative_timeline,
  render_chart,
  compute_next_run,
  should_skip_chart,
  hash_chart_config
} from "./tools/eventbrite_charts.js";

const logger = new Logger(process.env.LOG_LEVEL || "info");

const POLL_INTERVAL_MS = 60_000;

function create_chart_scheduler({ sql, config, slack_poster }) {
  if (!sql || !slack_poster) {
    logger.warn("chart_scheduler_disabled", {
      reason: !sql ? "no_db" : "no_slack_poster"
    });
    return { start: () => {}, stop: () => {} };
  }

  let interval_id = null;

  async function tick() {
    try {
      // Auto-stop expired jobs
      await sql`
        UPDATE esbmcp_scheduled_chart_jobs
        SET status = 'completed', updated_at = NOW()
        WHERE status = 'active' AND auto_stop_at <= NOW()
      `;

      // Find due jobs
      const due_jobs = await sql`
        SELECT j.*, e.name AS event_name, e.event_start_datetime,
               c.name AS city_name
        FROM esbmcp_scheduled_chart_jobs j
        JOIN events e ON e.eid = j.eid
        LEFT JOIN cities c ON c.id = e.city_id
        WHERE j.status = 'active' AND j.next_run_at <= NOW()
        ORDER BY j.next_run_at
        LIMIT 5
      `;

      for (const job of due_jobs) {
        await process_job(job);
      }
    } catch (err) {
      logger.error("chart_scheduler_tick_error", { error: err?.message });
    }
  }

  async function process_job(job) {
    const job_log_ctx = { job_id: job.id, eid: job.eid };

    try {
      logger.info("chart_job_processing", job_log_ctx);

      // Fetch fresh EB data
      const eb = config.eventbrite;
      if (!eb.api_token) {
        throw new Error("EVENTBRITE_API_TOKEN not configured");
      }

      // Get cached attendee data (refresh if stale > 6h)
      const cache = await sql`
        SELECT fetched_at, raw_attendees, total_tickets_sold, gross_revenue
        FROM eventbrite_api_cache
        WHERE eventbrite_id = ${job.eventbrite_id}
        ORDER BY fetched_at DESC LIMIT 1
      `;

      let attendees, ticket_count, revenue;

      if (cache.length === 0 || (Date.now() - new Date(cache[0].fetched_at).getTime()) > 6 * 3600000) {
        // Need to refresh — import and call the refresh tool directly
        const { eventbrite_charts_tools } = await import("./tools/eventbrite_charts.js");
        const refresh_result = await eventbrite_charts_tools.refresh_eventbrite_data(
          { eid: job.eid, force: true }, sql, null, config
        );
        if (refresh_result.error) throw new Error(refresh_result.error);

        const fresh_cache = await sql`
          SELECT raw_attendees, total_tickets_sold, gross_revenue
          FROM eventbrite_api_cache
          WHERE eventbrite_id = ${job.eventbrite_id}
          ORDER BY fetched_at DESC LIMIT 1
        `;
        attendees = fresh_cache[0]?.raw_attendees || [];
        ticket_count = fresh_cache[0]?.total_tickets_sold || 0;
        revenue = fresh_cache[0]?.gross_revenue || 0;
      } else {
        attendees = cache[0].raw_attendees || [];
        ticket_count = cache[0].total_tickets_sold || 0;
        revenue = cache[0].gross_revenue || 0;
      }

      // Build timeline
      const timeline = build_cumulative_timeline(
        attendees,
        job.event_start_datetime,
        job.event_start_datetime
      );

      if (timeline.length === 0) {
        await log_skip(job, "no_data");
        await advance_job(job);
        return;
      }

      // Meaningful-change gate
      const days_range = Math.max(1, timeline[0].days_until_event - timeline[timeline.length - 1].days_until_event);
      const pace_per_day = Math.round((ticket_count / days_range) * 100) / 100;

      if (should_skip_chart({ ticket_count, pace_per_day }, job)) {
        logger.info("chart_job_skipped_no_change", job_log_ctx);
        await log_skip(job, "no_change");
        await advance_job(job);
        return;
      }

      // Get comparators
      const comparators = [];
      let comp_eids = [];

      if (job.comparator_mode === "locked" && job.locked_comparators?.length > 0) {
        comp_eids = job.locked_comparators;
      } else {
        const candidates = await sql`
          SELECT candidate_eid FROM esbmcp_chart_comparator_candidates
          WHERE target_eid = ${job.eid}
          ORDER BY total_score DESC LIMIT 5
        `;
        comp_eids = candidates.map((c) => c.candidate_eid);
      }

      for (const comp_eid of comp_eids.slice(0, 5)) {
        const comp_event = await sql`
          SELECT e.eid, e.name, e.eventbrite_id, e.event_start_datetime,
                 c.name AS city_name
          FROM events e
          LEFT JOIN cities c ON c.id = e.city_id
          WHERE e.eid = ${comp_eid} LIMIT 1
        `;
        if (comp_event.length === 0 || !comp_event[0].eventbrite_id) continue;

        const comp_cache = await sql`
          SELECT raw_attendees FROM eventbrite_api_cache
          WHERE eventbrite_id = ${comp_event[0].eventbrite_id}
          ORDER BY fetched_at DESC LIMIT 1
        `;
        if (!comp_cache[0]?.raw_attendees) continue;

        const comp_timeline = build_cumulative_timeline(
          comp_cache[0].raw_attendees,
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

      // Render chart
      const { chart_url, chart_config, render_duration_ms } = await render_chart({
        target_event: { eid: job.eid, name: job.event_name },
        target_timeline: timeline,
        comparators
      });

      // Idempotency check
      const payload_hash = hash_chart_config(chart_config);
      const duplicate = await sql`
        SELECT id FROM esbmcp_chart_posts_log
        WHERE payload_hash = ${payload_hash} AND eid = ${job.eid}
        LIMIT 1
      `;

      if (duplicate.length > 0) {
        logger.info("chart_job_skipped_duplicate", job_log_ctx);
        await log_skip(job, "duplicate_hash");
        await advance_job(job);
        return;
      }

      // Post to Slack
      const days_until = timeline[timeline.length - 1]?.days_until_event;
      const comparator_label = comparators.length > 0
        ? ` vs ${comparators.map((c) => c.eid).join(", ")}`
        : "";
      const slack_text = `*${job.eid}* — ${job.event_name}\n` +
        `Tickets: *${ticket_count}* · Pace: *${pace_per_day}/day*` +
        (days_until != null ? ` · *${days_until} days* until event` : "") +
        comparator_label + `\n${chart_url}`;

      const slack_result = await slack_poster.post_message({
        channel: job.slack_channel_id,
        text: slack_text
      });

      // Log success
      await sql`
        INSERT INTO esbmcp_chart_posts_log (
          job_id, eid, chart_url, payload_hash, comparators_used,
          ticket_count, revenue, pace_per_day, days_until_event,
          slack_message_ts, render_duration_ms
        ) VALUES (
          ${job.id}, ${job.eid}, ${chart_url}, ${payload_hash},
          ${JSON.stringify(comparators.map((c) => ({ eid: c.eid, name: c.name, city: c.city })))},
          ${ticket_count}, ${revenue}, ${pace_per_day}, ${days_until},
          ${slack_result.ts}, ${render_duration_ms}
        )
      `;

      // Advance job
      await sql`
        UPDATE esbmcp_scheduled_chart_jobs
        SET last_run_at = NOW(),
            last_ticket_count = ${ticket_count},
            last_pace_per_day = ${pace_per_day},
            next_run_at = ${compute_next_run(job.event_start_datetime, job.cadence)},
            updated_at = NOW()
        WHERE id = ${job.id}
      `;

      logger.info("chart_job_completed", {
        ...job_log_ctx,
        ticket_count,
        pace_per_day,
        comparators: comparators.length,
        render_duration_ms
      });
    } catch (err) {
      logger.error("chart_job_failed", {
        ...job_log_ctx,
        error: err?.message
      });

      // Log error as a skipped post
      await sql`
        INSERT INTO esbmcp_chart_posts_log (
          job_id, eid, skipped, skip_reason
        ) VALUES (
          ${job.id}, ${job.eid}, true, 'error'
        )
      `.catch(() => {});

      // Set job to error state
      await sql`
        UPDATE esbmcp_scheduled_chart_jobs
        SET status = 'error', updated_at = NOW()
        WHERE id = ${job.id}
      `.catch(() => {});
    }
  }

  async function log_skip(job, reason) {
    await sql`
      INSERT INTO esbmcp_chart_posts_log (
        job_id, eid, skipped, skip_reason
      ) VALUES (
        ${job.id}, ${job.eid}, true, ${reason}
      )
    `.catch(() => {});
  }

  async function advance_job(job) {
    await sql`
      UPDATE esbmcp_scheduled_chart_jobs
      SET last_run_at = NOW(),
          next_run_at = ${compute_next_run(job.event_start_datetime, job.cadence)},
          updated_at = NOW()
      WHERE id = ${job.id}
    `.catch(() => {});
  }

  function start() {
    logger.info("chart_scheduler_started", { poll_interval_ms: POLL_INTERVAL_MS });
    // Run first tick after a short delay to let the server finish starting
    setTimeout(() => tick(), 5_000);
    interval_id = setInterval(tick, POLL_INTERVAL_MS);
  }

  function stop() {
    if (interval_id) {
      clearInterval(interval_id);
      interval_id = null;
      logger.info("chart_scheduler_stopped");
    }
  }

  return { start, stop };
}

export { create_chart_scheduler };
