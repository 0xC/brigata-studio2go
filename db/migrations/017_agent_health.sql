-- Per-agent turn-outcome health, so workspace owners can see when an agent
-- is failing instead of being blind to a silently broken agent.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_turn_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_turn_status TEXT;       -- 'ok' | 'error'
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_error_message TEXT;

GRANT ALL ON TABLE agents TO brigata;
