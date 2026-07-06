-- Per-agent secrets: named credentials an agent can use (API keys, deploy tokens)
-- WITHOUT them ever passing through the chat transcript. Values are encrypted at
-- rest (AES-256-GCM via secrets.ts / INTEGRATION_SECRET_KEY) and injected into the
-- agent's runtime environment at turn time (Standard: SDK env; Pro: via the bridge),
-- never persisted in plaintext and never stored in `messages`.
CREATE TABLE IF NOT EXISTS agent_secrets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,            -- env var name, e.g. STRIPE_API_KEY (validated [A-Z_][A-Z0-9_]*)
  value_encrypted TEXT NOT NULL,            -- AES-256-GCM ciphertext; never returned to the browser
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, name)
);

CREATE INDEX IF NOT EXISTS idx_agent_secrets_agent ON agent_secrets (agent_id);

-- Standing rule: GRANT to the brigata runtime user inline or the server crashloops.
GRANT ALL ON TABLE agent_secrets TO brigata;
