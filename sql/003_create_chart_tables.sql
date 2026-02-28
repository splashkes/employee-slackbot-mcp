-- =============================================================================
-- Eventbrite Chart Autopost — Tables
-- Prefix: esbmcp_
-- Run against: Supabase Postgres (same project as the main AB database)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. esbmcp_scheduled_chart_jobs
--    One row per autopost schedule. The chart_scheduler polls this table
--    every 60s for jobs where status='active' AND next_run_at <= now().
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS esbmcp_scheduled_chart_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Target event
  eid                 text        NOT NULL,
  eventbrite_id       text        NOT NULL,

  -- Where to post
  slack_channel_id    text        NOT NULL,

  -- Cadence: auto computes from days-until-event, or locked to a specific interval
  cadence             text        NOT NULL DEFAULT 'auto',
  -- auto | weekly | every_2_days | daily

  -- Scheduling
  next_run_at         timestamptz,
  last_run_at         timestamptz,
  auto_stop_at        timestamptz,         -- event_date + 2 days

  -- Comparator selection mode
  comparator_mode     text        NOT NULL DEFAULT 'auto',  -- auto | locked
  locked_comparators  jsonb       DEFAULT '[]',              -- array of eids when mode=locked

  -- Status
  status              text        NOT NULL DEFAULT 'active',
  -- active | paused | completed | error

  -- Last-run snapshot (for meaningful-change gate)
  last_ticket_count   int,
  last_pace_per_day   numeric(10,2),

  -- Who created
  created_by          text,                -- slack_user_id

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_esbmcp_chart_jobs_active
  ON esbmcp_scheduled_chart_jobs (next_run_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_esbmcp_chart_jobs_eid
  ON esbmcp_scheduled_chart_jobs (eid);


-- ---------------------------------------------------------------------------
-- 2. esbmcp_chart_posts_log
--    One row per chart rendered or skipped. Tracks idempotency via
--    payload_hash to avoid re-posting identical charts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS esbmcp_chart_posts_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid,                -- correlates to esbmcp_scheduled_chart_jobs (no FK)
  eid                 text        NOT NULL,

  -- Chart output
  chart_url           text,
  payload_hash        text,                -- sha256 of chart config (idempotency)
  comparators_used    jsonb       DEFAULT '[]',  -- [{eid, name, city}]

  -- Snapshot at render time
  ticket_count        int,
  revenue             numeric(12,2),
  pace_per_day        numeric(10,2),
  days_until_event    int,

  -- Slack delivery
  slack_message_ts    text,                -- Slack message timestamp (for threading)

  -- Skip tracking
  skipped             boolean     NOT NULL DEFAULT false,
  skip_reason         text,                -- no_change | duplicate_hash | error

  -- Timing
  render_duration_ms  int,

  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_esbmcp_chart_posts_eid
  ON esbmcp_chart_posts_log (eid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_esbmcp_chart_posts_job
  ON esbmcp_chart_posts_log (job_id, created_at DESC)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_esbmcp_chart_posts_hash
  ON esbmcp_chart_posts_log (payload_hash)
  WHERE payload_hash IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 3. esbmcp_chart_comparator_candidates
--    Scored comparator candidates per target event. Re-scored periodically
--    or on-demand via get_chart_comparators.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS esbmcp_chart_comparator_candidates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Target event being charted
  target_eid          text        NOT NULL,

  -- Candidate event
  candidate_eid       text        NOT NULL,
  candidate_name      text,
  candidate_city      text,
  candidate_date      timestamptz,
  candidate_total_tickets int,

  -- Scoring components (0.0 to 1.0 each)
  city_score          numeric(5,3) DEFAULT 0,
  scale_similarity    numeric(5,3) DEFAULT 0,
  price_similarity    numeric(5,3) DEFAULT 0,
  recency_score       numeric(5,3) DEFAULT 0,
  weekday_similarity  numeric(5,3) DEFAULT 0,

  -- Weighted total
  total_score         numeric(5,3) DEFAULT 0,

  -- Pool classification
  pool                text        NOT NULL DEFAULT 'cross_city',
  -- same_city | cross_city

  scored_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_esbmcp_comparators_target
  ON esbmcp_chart_comparator_candidates (target_eid, total_score DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_esbmcp_comparators_pair
  ON esbmcp_chart_comparator_candidates (target_eid, candidate_eid);


-- ---------------------------------------------------------------------------
-- RLS: service-role only
-- ---------------------------------------------------------------------------
ALTER TABLE esbmcp_scheduled_chart_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE esbmcp_chart_posts_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE esbmcp_chart_comparator_candidates ENABLE ROW LEVEL SECURITY;
