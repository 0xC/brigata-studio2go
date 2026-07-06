-- Per-message agent turn duration (wall-clock ms for the SDK turn that
-- produced the message). NULL for user/system messages and for agent
-- messages created before this column existed.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS turn_ms INTEGER;
