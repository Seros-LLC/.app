-- OAuth providers table
-- Allows members to sign in with Google or GitHub
CREATE TABLE IF NOT EXISTS oauth_providers (
  workspace_id text NOT NULL,
  member_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google', 'github')),
  provider_user_id text NOT NULL,
  email text,
  name text,
  created_at integer NOT NULL,
  PRIMARY KEY (workspace_id, provider, provider_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_workspace_member ON oauth_providers (workspace_id, member_id);

-- Index for looking up by provider
CREATE INDEX IF NOT EXISTS oauth_provider_lookup ON oauth_providers (workspace_id, provider, provider_user_id);
