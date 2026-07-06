-- Human @mentions in shared spaces. Today @mentions only summon agents; this
-- records when a message @-mentions a HUMAN workspace member so we can (a) surface
-- it in-app for that person and (b) send a "what you missed" email if the mention
-- stays unseen past a threshold. seen_at = the mentioned user has opened the
-- channel since the mention; notified_at = the email digest already covered it.
CREATE TABLE IF NOT EXISTS message_mentions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id           UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id           UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mentioned_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mentioned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at              TIMESTAMPTZ,
  notified_at          TIMESTAMPTZ,
  UNIQUE (message_id, mentioned_user_id)
);
-- Hot path: "my unseen mentions" and the digest sweep (unseen + un-notified).
CREATE INDEX IF NOT EXISTS idx_mentions_user_unseen ON message_mentions (mentioned_user_id, created_at DESC) WHERE seen_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mentions_digest ON message_mentions (created_at) WHERE seen_at IS NULL AND notified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mentions_channel ON message_mentions (channel_id, mentioned_user_id) WHERE seen_at IS NULL;
GRANT ALL ON TABLE message_mentions TO brigata;
