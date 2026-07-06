-- Agent Inbox / Task-handoff primitive — the concrete UX of the A2A pillar.
-- A Task = an addressed unit of work with a lifecycle and a reported result,
-- distinct from a chat message (it has an owning recipient, a state machine, and
-- an outcome). Sender is a human OR another agent; the same primitive powers
-- human->agent delegation and (leader-gated) agent->agent orchestration.
-- Scope: brigade/2026-06-06-cosimo-agent-inbox-task-handoff-scope.md
CREATE TABLE IF NOT EXISTS agent_tasks (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id     UUID REFERENCES channels(id) ON DELETE SET NULL,  -- originating / result-posting channel
  from_kind      TEXT NOT NULL CHECK (from_kind IN ('user','agent')),
  from_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  from_agent_id  UUID REFERENCES agents(id) ON DELETE SET NULL,
  to_agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,  -- the owning recipient
  title          TEXT NOT NULL,
  body_md        TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','delivered','in_progress','done','failed','declined','cancelled')),
  parent_task_id UUID REFERENCES agent_tasks(id) ON DELETE SET NULL,  -- delegation chains/trees
  depth          INT  NOT NULL DEFAULT 0,   -- chain depth, for the runaway/loop guard
  result_summary TEXT,
  result_doc_id  UUID REFERENCES documents(id) ON DELETE SET NULL,    -- result persisted as a doc
  error_message  TEXT,                                                -- failed/declined reason
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at   TIMESTAMPTZ,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_inbox  ON agent_tasks (workspace_id, to_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_sender ON agent_tasks (workspace_id, from_user_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_queued ON agent_tasks (to_agent_id) WHERE status = 'queued';

-- Standing rule: every new table GRANTs to the brigata runtime user inline,
-- or the server crashloops on 500s.
GRANT ALL ON TABLE agent_tasks TO brigata;
