-- =============================================================================
-- Reaction-based feedback — captures emoji reactions on bot messages
-- as implicit quality signals. No session FK required (keyed by message ts).
-- =============================================================================

CREATE TABLE IF NOT EXISTS esbmcp_reaction_feedback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Where the reaction happened
  slack_channel_id text       NOT NULL,
  message_ts      text        NOT NULL,   -- ts of the bot message that was reacted to
  thread_ts       text,                   -- thread root ts (for correlation with chat sessions)

  -- Who reacted
  slack_user_id   text        NOT NULL,

  -- Reaction
  reaction        text        NOT NULL,   -- emoji name (thumbsup, bug, etc.)
  sentiment       text        NOT NULL,   -- positive, negative, bug

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Prevent duplicate reactions from same user on same message
  CONSTRAINT uq_reaction_user_message UNIQUE (slack_channel_id, message_ts, slack_user_id, reaction)
);

CREATE INDEX IF NOT EXISTS idx_esbmcp_reaction_feedback_sentiment
  ON esbmcp_reaction_feedback (sentiment, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_esbmcp_reaction_feedback_channel
  ON esbmcp_reaction_feedback (slack_channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_esbmcp_reaction_feedback_negative
  ON esbmcp_reaction_feedback (created_at DESC)
  WHERE sentiment IN ('negative', 'bug');

ALTER TABLE esbmcp_reaction_feedback ENABLE ROW LEVEL SECURITY;
