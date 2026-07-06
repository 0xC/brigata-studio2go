-- Group-chat UX: reply threading, per-channel agent response mode, reactions.
-- Backend half of the spec whose frontend Aria already shipped (app/src/Workspace.tsx).

-- Reply: which message this one is replying to. SET NULL if the parent is deleted
-- so a reply survives its parent's removal (just loses the quote).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_id);

-- Turn-taking: per-channel agent response mode.
--   auto    = composition-aware (1 human → ambient; 2+ humans → only @mention or
--             a reply to the agent's own message)
--   mention = agents respond ONLY to an explicit @mention
--   off     = agents never auto-respond
ALTER TABLE channels ADD COLUMN IF NOT EXISTS agent_response_mode TEXT NOT NULL DEFAULT 'auto';

-- Reactions: one row per (message, user, emoji). Toggle = insert/delete. The PK
-- is on three NOT NULL columns, which sidesteps the NULL-dedupe flaw in the draft
-- schema (a UNIQUE over a nullable column won't dedupe — NULLs aren't equal).
CREATE TABLE IF NOT EXISTS message_reactions (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_msg ON message_reactions(message_id);

GRANT ALL ON TABLE messages TO brigata;
GRANT ALL ON TABLE channels TO brigata;
GRANT ALL ON TABLE message_reactions TO brigata;
