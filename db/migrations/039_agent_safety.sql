-- Per-agent self-declared safety profile for the "rule of two" tracker.
-- Subscriber-declared because the riskiest capabilities (spends money, reads
-- inbound email) are wired up by the user on their own agent — we can't reliably
-- auto-detect them, and a false green on exactly those agents would be dangerous.
-- JSONB of declared booleans; the rule-of-two status is computed in the client.
-- agents is already GRANTed to the brigata runtime user (table-level grant covers
-- new columns), so no additional GRANT is needed here.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS safety_profile JSONB NOT NULL DEFAULT '{}'::jsonb;
