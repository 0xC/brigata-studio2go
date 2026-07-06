-- Append-only authentication audit log: who signed in, who was denied, who
-- logged out — with IP + user-agent for a real access record. Becomes important
-- once the allowlist comes off and anyone with a Gmail can attempt sign-in.
-- This is auth metadata only (never message/subscriber content).

CREATE TABLE IF NOT EXISTS auth_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  email TEXT,
  google_sub TEXT,
  event TEXT NOT NULL,            -- 'login' | 'denied' | 'logout'
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_events_created ON auth_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_email ON auth_events (lower(email));

GRANT ALL ON TABLE auth_events TO brigata;
