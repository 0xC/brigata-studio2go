-- Layered agent secrets: a secret can be WORKSPACE-level (shared by all the
-- workspace's agents) or AGENT-level (scoped to one agent, overrides workspace).
-- Workspace-level rows have agent_id IS NULL. Per-agent rows keep agent_id set.
ALTER TABLE agent_secrets ALTER COLUMN agent_id DROP NOT NULL;

-- Per-agent uniqueness is still the existing UNIQUE(agent_id, name) constraint.
-- Workspace-level rows (agent_id NULL) need their own uniqueness — NULLs are
-- distinct under a normal UNIQUE, so use a partial index on (workspace_id, name).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_secrets_ws_level
  ON agent_secrets (workspace_id, name) WHERE agent_id IS NULL;
