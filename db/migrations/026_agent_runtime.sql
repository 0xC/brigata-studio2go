-- Runtime facts scraped from a bridge-backed agent's /health, so the owner can
-- see what code their agent is actually running (esp. bridge_rev, to know when a
-- redeploy/bridge-update is needed) instead of having to SSH + curl. Captured by
-- the 60s health poller (server/src/index.ts) on every successful probe; surfaced
-- on the agent endpoints (admin.ts). Distinct from last_seen_at (019, liveness)
-- and last_turn_* (017, per-turn outcome): these are the bridge's self-reported
-- runtime identity. Only ever populated for hosting IN ('pro_droplet','external').
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bridge_rev TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bridge_model TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bridge_auth_mode TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bridge_sdk_installed BOOLEAN;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bridge_public_ip TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bridge_health_at TIMESTAMPTZ;

GRANT ALL ON TABLE agents TO brigata;
