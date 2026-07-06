-- Brigata Workspace initial schema
-- Run with: psql $DATABASE_URL -f db/migrations/001_initial.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users (human identities, Google OAuth)
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    google_sub      TEXT UNIQUE NOT NULL,
    email           TEXT UNIQUE NOT NULL,
    name            TEXT,
    avatar_url      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ
);

-- Workspaces (one per subscriber)
CREATE TABLE workspaces (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    owner_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    plan            TEXT NOT NULL DEFAULT 'solo',  -- solo | crew | brigade
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Workspace memberships (humans; schema supports >1 even though v1 UI doesn't)
CREATE TABLE workspace_members (
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'owner', -- owner | admin | member | guest
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

-- Agents (AI members of a workspace)
CREATE TABLE agents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    avatar          TEXT,                         -- emoji or url
    model           TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    soul_md         TEXT NOT NULL DEFAULT '',
    mission_md      TEXT NOT NULL DEFAULT '',
    identity_md     TEXT NOT NULL DEFAULT '',
    hosting         TEXT NOT NULL DEFAULT 'standard', -- standard | pro_droplet | external
    droplet_id      TEXT,                         -- DO droplet id when hosting='pro_droplet'
    status          TEXT NOT NULL DEFAULT 'offline', -- online | offline | error
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent SOUL version history
CREATE TABLE agent_versions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    soul_md         TEXT NOT NULL,
    mission_md      TEXT NOT NULL,
    identity_md     TEXT NOT NULL,
    saved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    saved_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Channels (per workspace)
CREATE TABLE channels (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    topic           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name)
);

-- Which agents are in which channels
CREATE TABLE channel_agents (
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, agent_id)
);

-- Messages
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sender_kind     TEXT NOT NULL,                -- 'user' | 'agent' | 'system'
    sender_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    sender_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    body            TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'native', -- native | discord | telegram
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_channel_created ON messages (channel_id, created_at DESC);

-- Documents (interactive living docs: markdown + state sidecar)
CREATE TABLE documents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    body_md         TEXT NOT NULL DEFAULT '',
    state           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- element_id -> value (checkbox booleans for v1)
    owner_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Document version history (for revert)
CREATE TABLE document_versions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    body_md         TEXT NOT NULL,
    state           JSONB NOT NULL,
    saved_by_kind   TEXT NOT NULL,                -- 'user' | 'agent'
    saved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    saved_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    saved_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-document agent access grants
CREATE TABLE document_agent_acls (
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    can_read        BOOLEAN NOT NULL DEFAULT TRUE,
    can_write       BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (document_id, agent_id)
);

-- Integrations (Discord, Telegram, etc.)
CREATE TABLE integrations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,                -- 'discord' | 'telegram' | ...
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL DEFAULT 'inactive',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessions (for OAuth)
CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
