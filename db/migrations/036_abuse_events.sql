-- Durable log of abuse alerts so the admin view shows that an alert HAPPENED,
-- not just the (transient) live flag — which clears the moment the spike ends.
CREATE TABLE IF NOT EXISTS abuse_events (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  signal       TEXT NOT NULL,        -- cpu | egress | lockout
  detail       TEXT,                 -- e.g. "load/core 2.97, egress 0.2 MB/s"
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_abuse_events_agent ON abuse_events (agent_id, created_at DESC);
GRANT ALL ON TABLE abuse_events TO brigata;
