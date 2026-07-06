-- User preferences: layout, theme, rail widths, anything that should follow
-- the user across browsers and sessions.
ALTER TABLE users ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
