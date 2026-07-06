-- Custom domain (+ Let's Encrypt TLS) attached to a Pro agent's web publishing.
-- web_domain = the user's domain now serving the box; web_app_port = set when the
-- domain reverse-proxies a dynamic app the agent runs (NULL = static /var/www/html).
-- Columns on the existing agents table; existing grants cover new columns.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS web_domain   TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS web_app_port INTEGER;
