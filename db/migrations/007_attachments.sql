CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('text', 'image', 'pdf', 'other')),
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX attachments_workspace_idx ON attachments (workspace_id);
CREATE INDEX attachments_message_idx ON attachments (message_id);
CREATE INDEX attachments_orphan_idx ON attachments (created_at) WHERE message_id IS NULL;
