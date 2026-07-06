-- Per-channel documents: each document optionally belongs to a channel.
-- NULL channel_id = workspace-level doc (the fallback "general" bucket and the
-- destination for docs orphaned when their channel is deleted).
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_documents_channel ON documents (workspace_id, channel_id);

-- Backfill: attach every existing doc to its workspace's #common channel so the
-- per-channel UI has somewhere to show them (instead of them all going NULL).
UPDATE documents d
SET channel_id = c.id
FROM channels c
WHERE c.workspace_id = d.workspace_id
  AND c.name = 'common'
  AND d.channel_id IS NULL;
