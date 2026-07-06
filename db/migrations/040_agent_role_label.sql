-- Editable role label shown under an agent's name on their card.
--
-- Previously the label was DERIVED at render time from the avatar's template
-- path (/avatars/templates/<role>.png -> "copywriter"), so it was frozen to the
-- archetype the agent was spun up as. Agents evolve — their role grows past the
-- starter archetype — so the owner needs to override the label with their own
-- text (e.g. "Opportunity Scout"). NULL/empty keeps the old derived behavior.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS role_label TEXT;
