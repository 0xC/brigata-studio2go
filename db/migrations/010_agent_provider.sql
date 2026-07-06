-- Per-agent cloud provider selection for Pro tier. 'hetzner' is the default
-- (cheaper, comparable specs, 5x more egress). 'digitalocean' available as
-- an advanced option (broader regions, 24/7 support). Standard agents (no
-- server) ignore this column.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'digitalocean';

-- 2026-05-22: flip default to hetzner. Existing rows keep their current value.
ALTER TABLE agents ALTER COLUMN provider SET DEFAULT 'hetzner';

GRANT ALL ON TABLE agents TO brigata;
