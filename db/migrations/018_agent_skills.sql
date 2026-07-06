-- Per-agent enabled skills. The catalog itself is code-defined (curated, vetted);
-- this column just stores which catalog skill ids an owner has toggled on for an
-- agent. Empty array = today's exact behavior (base tool set only).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS enabled_skills jsonb NOT NULL DEFAULT '[]'::jsonb;

GRANT ALL ON TABLE agents TO brigata;
