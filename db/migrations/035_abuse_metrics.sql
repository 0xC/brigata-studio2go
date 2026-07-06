-- Box resource metrics + abuse flags per Pro agent, scraped by the fleet health
-- poller from the bridge /health. Drives root-abuse-detection monitoring + the
-- admin fleet view. Existing table grant covers new columns.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bridge_load_per_core REAL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bridge_mem_pct       INTEGER;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bridge_egress_bps    BIGINT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bridge_metrics_at    TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS abuse_flags          TEXT;
