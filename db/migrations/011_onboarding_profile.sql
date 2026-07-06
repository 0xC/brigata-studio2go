-- Persist each user's onboarding wizard answers + derived persona so we
-- can (a) skip re-prompting on subsequent sign-ins, (b) re-seed their
-- workspace based on the answers, (c) tailor UI affordances later.
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_profile jsonb;

GRANT ALL ON TABLE users TO brigata;
