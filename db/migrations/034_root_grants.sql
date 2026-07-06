-- Audit trail of root-privilege grants on managed Pro boxes. Append-only: one row
-- each time an owner enables root, capturing who accepted, which ToS version, and
-- the source IP — the consent record behind the managed-root middle-ground.
CREATE TABLE IF NOT EXISTS root_grants (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  tos_version   TEXT NOT NULL,
  accepted_ip   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_root_grants_agent ON root_grants (agent_id);
GRANT ALL ON TABLE root_grants TO brigata;
