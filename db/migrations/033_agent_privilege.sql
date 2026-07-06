-- Per-agent run privilege on its Pro box: 'standard' (non-root, default) or 'root'
-- (opt-in full box control, driven via the root co-location manager). Existing
-- grants on agents cover the new column.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS bridge_privilege TEXT NOT NULL DEFAULT 'standard';
