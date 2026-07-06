-- Pro-tier ("external") agents run on a remote OpenClaw droplet. We talk to
-- them over HTTP webhooks instead of calling the Anthropic API in-process.
ALTER TABLE agents ADD COLUMN external_url TEXT;
ALTER TABLE agents ADD COLUMN external_token TEXT;

-- Fast lookup for inbound webhook auth.
CREATE INDEX idx_agents_external_token ON agents (external_token) WHERE external_token IS NOT NULL;
