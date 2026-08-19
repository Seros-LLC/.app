
-- 0003_replay_nonce.sql
-- H5: replay protection. A verified webhook signature may be spent exactly once
-- inside the replay window. Keyed by a hash of the signature only: this table
-- holds no body, no message text, no author, no workspace content.
CREATE TABLE IF NOT EXISTS webhook_replay_nonces (
  signature_hash TEXT PRIMARY KEY,
  request_ts INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_replay_nonces_expires_at
  ON webhook_replay_nonces (expires_at);
