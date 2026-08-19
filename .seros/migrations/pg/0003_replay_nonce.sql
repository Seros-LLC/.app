-- migrations/pg/0003_replay_nonce.sql
-- Postgres mirror of migrations/0003_replay_nonce.sql.
-- H5: a verified webhook signature may be spent exactly once inside the replay
-- window. Keyed by a hash of the signature only: no body, no text, no author.
CREATE TABLE IF NOT EXISTS webhook_replay_nonces (
  signature_hash TEXT   PRIMARY KEY,
  request_ts     BIGINT NOT NULL,
  seen_at        BIGINT NOT NULL,
  expires_at     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_replay_nonces_expires_at
  ON webhook_replay_nonces (expires_at);
