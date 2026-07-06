-- Stripe billing state on the user. We keep the Stripe customer + subscription
-- IDs and a denormalized status/period-end so entitlement checks never need a
-- round-trip to Stripe. The webhook (POST /api/billing/webhook) is the single
-- writer that keeps subscription_status / current_period_end in sync.
--
-- subscription_status mirrors Stripe's subscription.status verbatim
-- (active, trialing, past_due, canceled, incomplete, …) plus NULL for users
-- who have never started checkout (free tier).
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_period_end     TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id);

GRANT ALL ON TABLE users TO brigata;
