-- Token-based invitations to shared workspaces. The inviter (owner or admin)
-- generates a token, shares it as a URL, the invitee signs in and accepts to
-- become a workspace_member.

CREATE TABLE workspace_invites (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    token               TEXT UNIQUE NOT NULL,
    email               TEXT,
    created_by_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
    accepted_at         TIMESTAMPTZ,
    accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_workspace_invites_workspace ON workspace_invites (workspace_id);

GRANT ALL ON TABLE workspace_invites TO brigata;
