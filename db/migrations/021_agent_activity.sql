-- Append-only audit log of agent coordination activity (turns, handoffs).
-- Feeds the user-facing "traffic lights" + commit-style activity panel.
-- Content-free: summaries are metadata only, never message bodies.

CREATE TABLE IF NOT EXISTS agent_activity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  actor_kind TEXT NOT NULL,                                        -- 'agent' | 'human' | 'system'
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,                                            -- 'turn' | 'handoff' | ...
  summary TEXT,                                                    -- content-free one-liner
  target_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,   -- handoff receiver
  duration_ms INTEGER,
  status TEXT DEFAULT 'ok',
  context JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_activity_workspace_created
  ON agent_activity (workspace_id, created_at DESC);

GRANT ALL ON TABLE agent_activity TO brigata;
