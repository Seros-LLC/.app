-- 0011: the Slack connection, the channels the admin chose, and nothing else.
--
-- v0 reads Slack and writes one tracker (business/ROADMAP.md). Two facts have to
-- survive a restart for that to work: which Slack workspace this tenant is, and
-- which channels the admin agreed we may read. Both live here.
--
-- The bot token is stored encrypted (src/crypto.ts, AES-256-GCM). A token in
-- plaintext in a row is a token in plaintext in every backup.
--
-- No message content is stored in these tables. Channel names are workspace
-- metadata the admin chose to show us, not customer conversation.
CREATE TABLE IF NOT EXISTS source_connections (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  provider      TEXT NOT NULL DEFAULT 'slack' CHECK(provider IN ('slack')),
  team_id       TEXT NOT NULL,
  team_name     TEXT,
  bot_user_id   TEXT,
  token_enc     TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT '',
  installed_by  TEXT,
  installed_at  INTEGER NOT NULL,
  revoked_at    INTEGER,
  PRIMARY KEY (workspace_id, provider)
);

-- The webhook resolves a tenant from the Slack team id, so this must be unique
-- across tenants: two workspaces claiming one Slack team is how one customer's
-- messages end up in another customer's queue.
CREATE UNIQUE INDEX IF NOT EXISTS source_connections_team ON source_connections (provider, team_id);

CREATE TABLE IF NOT EXISTS source_channels (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  channel_id   TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  is_private   INTEGER NOT NULL DEFAULT 0,
  selected     INTEGER NOT NULL DEFAULT 0,
  selected_at  INTEGER,
  seen_at      INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, channel_id)
);

CREATE INDEX IF NOT EXISTS source_channels_selected ON source_channels (workspace_id, selected);
