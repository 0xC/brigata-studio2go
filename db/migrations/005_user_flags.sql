-- User flags: comp (exempt from billing) and admin (workspace owner of brigata.ai
-- itself; can manage comp flags, see admin tools later).
ALTER TABLE users ADD COLUMN is_comp BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;
