-- Per-turn token + cost capture, so subscribers can see what their agents are
-- consuming (and so we can later enforce quotas / meter billing). One row per
-- agent model-turn. Token counts are always real; total_cost_usd is the model's
-- API-priced estimate — for OAuth-subscription credentials it's notional (the
-- turn draws from a flat subscription, not metered spend), but it's still the
-- best per-turn cost signal we have. `source` records where the turn was metered
-- so Pro/bridge usage (reported later) can be distinguished from in-backend
-- Standard-tier SDK turns.
CREATE TABLE usage_events (
    id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id           UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id               UUID REFERENCES agents(id)     ON DELETE SET NULL,
    channel_id             UUID REFERENCES channels(id)   ON DELETE SET NULL,
    user_id                UUID REFERENCES users(id)      ON DELETE SET NULL, -- human who triggered the turn
    model                  TEXT NOT NULL,
    input_tokens           BIGINT NOT NULL DEFAULT 0,
    output_tokens          BIGINT NOT NULL DEFAULT 0,
    cache_creation_tokens  BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens      BIGINT NOT NULL DEFAULT 0,
    total_cost_usd         NUMERIC(12,6) NOT NULL DEFAULT 0,
    num_turns              INTEGER,
    duration_ms            INTEGER,
    status                 TEXT NOT NULL DEFAULT 'ok',           -- ok | error
    source                 TEXT NOT NULL DEFAULT 'standard_sdk', -- standard_sdk | pro_bridge | studio
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_events_workspace_created ON usage_events (workspace_id, created_at DESC);
CREATE INDEX idx_usage_events_agent_created     ON usage_events (agent_id, created_at DESC);

GRANT ALL ON TABLE usage_events TO brigata;
