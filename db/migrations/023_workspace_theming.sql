-- 023_workspace_theming.sql
-- Per-workspace visual identity: an optional theme override and emoji icon
-- surfaced in the workspace switcher so multi-workspace users can tell
-- workspaces apart at a glance.
--
-- theme: 'graphite' | 'ember' | 'atelier', nullable. NULL = inherit the
--   user's personal theme pref (validated app-side, stored as free text).
-- icon: short emoji string, nullable. NULL = fall back to first-letter badge.
-- No backfill: existing rows stay NULL and behave exactly as today.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS theme text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS icon text;

GRANT ALL ON TABLE workspaces TO brigata;
