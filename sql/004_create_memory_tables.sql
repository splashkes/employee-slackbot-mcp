-- =============================================================================
-- Channel & Tool Memory — Versioned contextual memory per scope
-- Prefix: esbmcp_
-- Run against: Supabase Postgres (same project as the main AB database)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. esbmcp_memory_heads
--    One row per memory scope. Points to the current active version.
--    scope_type: 'channel' (per Slack channel) or 'tool' (per tool name)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS esbmcp_memory_heads (
  scope_type       text        NOT NULL,  -- channel | tool
  scope_id         text        NOT NULL,  -- Slack channel ID or tool name
  scope_label      text,                  -- human-readable: channel name or tool name
  current_version  int         NOT NULL DEFAULT 0,
  token_budget     int         NOT NULL DEFAULT 2200,
  total_versions   int         NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_id)
);

-- ---------------------------------------------------------------------------
-- 2. esbmcp_memory_versions
--    Immutable version history. Each row is a full snapshot of the memory
--    content at a point in time. Never mutated, only appended.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS esbmcp_memory_versions (
  id                       bigserial   PRIMARY KEY,
  scope_type               text        NOT NULL,
  scope_id                 text        NOT NULL,
  version_no               int         NOT NULL,

  -- Lineage
  parent_version_id        bigint,                   -- previous version's id
  rollback_from_version_id bigint,                   -- set when this version is a rollback

  -- Content (dual representation)
  content_md               text        NOT NULL,     -- the canonical markdown memory
  content_json             jsonb,                    -- parsed sections for querying

  -- Metadata
  change_summary           text,                     -- "Added John as Toronto producer"
  content_chars            int,                      -- length of content_md
  session_id               uuid,                     -- which chat session triggered this
  source_message_ts        text,                     -- Slack message timestamp
  created_by               text,                     -- slack_user_id or 'system'

  created_at               timestamptz NOT NULL DEFAULT now(),

  UNIQUE(scope_type, scope_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_esbmcp_memory_versions_scope
  ON esbmcp_memory_versions (scope_type, scope_id, version_no DESC);

CREATE INDEX IF NOT EXISTS idx_esbmcp_memory_versions_latest
  ON esbmcp_memory_versions (scope_type, scope_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS: service-role only
-- ---------------------------------------------------------------------------
ALTER TABLE esbmcp_memory_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE esbmcp_memory_versions ENABLE ROW LEVEL SECURITY;
