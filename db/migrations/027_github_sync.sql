-- GitHub document sync (open-format doc-sync primitive: Markdown over Git).
--
-- Two scopes:
--   1. github_app   — ONE platform-wide GitHub App's credentials, created once
--                     via GitHub's App-manifest flow. Secrets encrypted at rest
--                     (server/src/secrets.ts, INTEGRATION_SECRET_KEY).
--   2. integrations — per-workspace install lives in the existing integrations
--                     table as type='github' (installation_id + repo + branch +
--                     base_path in the config JSONB), same pattern as Discord/Matrix.
--
-- github_doc_links is the bidirectional bookkeeping: which document maps to which
-- repo file, plus the last-synced content hash (local) and blob sha (remote) so we
-- can detect what changed on each side and dedup our own webhook echoes.

CREATE TABLE IF NOT EXISTS github_app (
    id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- single row
    app_id         BIGINT NOT NULL,
    slug           TEXT NOT NULL,
    client_id      TEXT NOT NULL,
    client_secret  TEXT NOT NULL,   -- encrypted
    private_key    TEXT NOT NULL,   -- encrypted (PEM)
    webhook_secret TEXT NOT NULL,   -- encrypted
    html_url       TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS github_doc_links (
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    document_id     UUID REFERENCES documents(id) ON DELETE SET NULL,
    repo_path       TEXT NOT NULL,
    last_local_hash TEXT,           -- sha256 of last-synced body_md
    last_blob_sha   TEXT,           -- git blob sha of last-synced remote content
    deleted_remote  BOOLEAN NOT NULL DEFAULT FALSE,
    last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, repo_path)
);

CREATE INDEX IF NOT EXISTS idx_github_doc_links_doc
    ON github_doc_links (workspace_id, document_id);

GRANT ALL ON TABLE github_app TO brigata;
GRANT ALL ON TABLE github_doc_links TO brigata;
