-- Per-workspace display name. Each member can pick what they're called in a
-- given workspace; when null, the user's Google profile name is used.
-- Solves the duplicate-name problem in shared workspaces (e.g. one person
-- with two Google accounts that both render as "Chris Hager").

ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS display_name TEXT;

GRANT ALL ON TABLE workspace_members TO brigata;
