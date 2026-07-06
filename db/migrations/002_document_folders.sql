-- Document organization: optional folder path + pin flag.
-- Folder is a free-form slash-separated string ("deploys/runbooks") — no
-- separate folders table for v1; folders exist by virtue of being referenced.

ALTER TABLE documents ADD COLUMN folder TEXT;
ALTER TABLE documents ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX idx_documents_folder ON documents (workspace_id, folder);
