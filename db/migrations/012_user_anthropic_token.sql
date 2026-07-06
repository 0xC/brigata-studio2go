-- Per-user Anthropic credential (closed-beta tenant attribution).
-- Stored opaquely; we accept either an OAuth subscription token (sk-ant-oat-...)
-- or an API key (sk-ant-api03-...) and route dispatch accordingly.
ALTER TABLE users ADD COLUMN IF NOT EXISTS anthropic_token TEXT;

GRANT ALL ON TABLE users TO brigata;
