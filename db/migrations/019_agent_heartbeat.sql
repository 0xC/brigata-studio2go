-- Liveness heartbeat for external/pro_droplet agents. The bridge pings
-- /api/agent-webhook/heartbeat on an interval; the server records last_seen_at.
-- A sweep marks an agent 'offline' once its heartbeat goes stale, so the UI can
-- show a real offline state instead of a stuck "thinking" indicator. Distinct
-- from last_turn_* (017), which is per-turn outcome rather than liveness.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

GRANT ALL ON TABLE agents TO brigata;
