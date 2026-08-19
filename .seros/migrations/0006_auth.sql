-- 0006_auth.sql
-- The password-less member picker on /login was the known hole in the README: a
-- confirmation was attributable to whoever CLAIMED to be a member. This migration
-- gives a member something to prove.
--
-- WHY A NEW TABLE AND NOT `ALTER TABLE members ADD COLUMN`.
-- src/db/client.ts re-executes EVERY migration file on EVERY boot. SQLite has no
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and DDL cannot branch, so a bare
-- ALTER raises "duplicate column name" on the second boot and takes the app down
-- (the exact reasoning written into 0002_meter_cost.sql and 0005_audit_append_only.sql).
-- The pattern those two use is: create the table in its FULL shape under a NEW
-- name with CREATE TABLE IF NOT EXISTS, and stop using the old one.
--
-- `members` itself cannot be replaced that way: `confirmations` carries
--   FOREIGN KEY (workspace_id, member_id) REFERENCES members(workspace_id, id)
-- (0001), so a `members_v2` that new rows went into instead would leave every
-- confirmation failing its foreign key, and a DROP+RENAME rebuild is not
-- re-executable - on the second boot the rebuild would copy the OLD column list
-- back over the new one and silently destroy every password hash. So the five
-- per-member auth fields the brief asks for (password_hash, password_set_at,
-- failed_attempts, locked_until, last_login_at) live in a table of their own,
-- one row per member, keyed by (workspace_id, member_id) and deleted with the
-- member by ON DELETE CASCADE (so src/retention.ts erases credentials with the
-- workspace without knowing this table exists).
--
-- Every statement below is a no-op the second time it runs; there is no ALTER,
-- no DROP and no RENAME in this file, so N cold boots leave the same schema and
-- the same rows as one.
--
-- Content-free by construction: a credential is a hash, a timestamp and a count.
-- The hash is `scheme$params$salt$digest` (src/password.ts, scrypt, node:crypto
-- only); the invite token is stored ONLY as a SHA-256 hash, so the database never
-- holds anything that can be replayed as a credential.

CREATE TABLE IF NOT EXISTS member_credentials (
  workspace_id      TEXT    NOT NULL,
  member_id         TEXT    NOT NULL,

  -- sign-in identifier. Optional: a member may sign in with their member id.
  email             TEXT,

  -- `scrypt$N$r$p$<salt-b64>$<hash-b64>`. NULL means "no password set yet": that
  -- member cannot sign in until an invite is redeemed. The CHECK only insists on
  -- a leading version tag, so the parameters (or the scheme) can change later
  -- without a migration - every row carries the parameters it was made with.
  password_hash     TEXT    CHECK(password_hash IS NULL OR instr(password_hash, '$') > 1),
  password_set_at   INTEGER,

  -- lockout: N failures inside the window and the account is closed for a cooldown.
  failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
  locked_until      INTEGER,
  last_login_at     INTEGER,

  -- single-use, time-limited invite. Only the SHA-256 of the token is stored; the
  -- raw token is shown to the admin once and is not recoverable from this row.
  invite_token_hash TEXT,
  invite_issued_at  INTEGER,
  invite_expires_at INTEGER,
  invite_used_at    INTEGER,

  PRIMARY KEY (workspace_id, member_id),
  -- a credential belongs to a real member of that exact workspace, and dies with it
  FOREIGN KEY (workspace_id, member_id) REFERENCES members(workspace_id, id) ON DELETE CASCADE
);

-- Sign-in by email is a lookup on (workspace, email); the UNIQUE stops two members
-- of one workspace claiming the same address. Emails are stored lower-cased by
-- src/password.ts so the uniqueness is not case-dodgeable. NULLs stay distinct in
-- SQLite, so members without an email are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS member_credentials_email
  ON member_credentials (workspace_id, email);

-- Redeeming an invite is a lookup by token hash across the table (the holder of a
-- token does not tell us which workspace it belongs to), and a token hash may
-- never be shared by two rows.
CREATE UNIQUE INDEX IF NOT EXISTS member_credentials_invite
  ON member_credentials (invite_token_hash) WHERE invite_token_hash IS NOT NULL;
