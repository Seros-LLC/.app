-- migrations/pg/0006_auth.sql
-- Postgres mirror of migrations/0006_auth.sql (member credentials).
-- Same table, same keys, same CHECKs, same two unique indexes including the
-- partial one on the invite token hash. Differences, all forced by the dialect:
--   * SQLite instr(x,'$') becomes Postgres strpos(x,'$'): same 1-based answer.
--   * every epoch-millisecond column is BIGINT (see pg/0001_schema.sql).
-- NULLs are distinct in a Postgres unique index exactly as in SQLite, so members
-- without an email are unaffected by member_credentials_email.
--
-- Content-free by construction: a credential is a hash, a timestamp and a count.

CREATE TABLE IF NOT EXISTS member_credentials (
  workspace_id      TEXT    NOT NULL,
  member_id         TEXT    NOT NULL,
  email             TEXT,
  password_hash     TEXT    CHECK(password_hash IS NULL OR strpos(password_hash, '$') > 1),
  password_set_at   BIGINT,
  failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
  locked_until      BIGINT,
  last_login_at     BIGINT,
  invite_token_hash TEXT,
  invite_issued_at  BIGINT,
  invite_expires_at BIGINT,
  invite_used_at    BIGINT,
  PRIMARY KEY (workspace_id, member_id),
  FOREIGN KEY (workspace_id, member_id) REFERENCES members(workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS member_credentials_email
  ON member_credentials (workspace_id, email);

CREATE UNIQUE INDEX IF NOT EXISTS member_credentials_invite
  ON member_credentials (invite_token_hash) WHERE invite_token_hash IS NOT NULL;
