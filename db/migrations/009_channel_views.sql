-- Per-user last-seen timestamps per channel, for unread badges.
CREATE TABLE IF NOT EXISTS channel_views (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_views_user ON channel_views (user_id);

-- Studio runs as the `brigata` user; tables created as `postgres` deny access
-- without explicit grants and the service crashloops on 500s.
GRANT ALL ON TABLE channel_views TO brigata;
