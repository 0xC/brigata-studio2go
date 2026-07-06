-- Newbie demo mode: per-user allotment for the platform-funded "try a quick demo
-- first" onboarding path. A tokenless user can run a capped number of agent turns
-- on Brigata's own Anthropic key (Haiku) before connecting their own Claude. One
-- row per user, created when they start a demo. The cap is enforced as
-- messages_used >= 8 OR tokens_used >= 60000 (whichever first). `converted` flips
-- true when they later connect their own Claude credential — the funnel metric.
-- Per-turn spend is still recorded in usage_events tagged source='demo'.
CREATE TABLE demo_credits (
    user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    messages_used  INTEGER     NOT NULL DEFAULT 0,
    tokens_used    BIGINT      NOT NULL DEFAULT 0,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    converted      BOOLEAN     NOT NULL DEFAULT false,
    converted_at   TIMESTAMPTZ
);

GRANT ALL ON TABLE demo_credits TO brigata;
