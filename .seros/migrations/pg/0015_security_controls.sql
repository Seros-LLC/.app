CREATE TABLE IF NOT EXISTS captcha_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('login','signup')),
  answer_mac TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX IF NOT EXISTS captcha_challenges_expires_at ON captcha_challenges(expires_at);

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  bucket TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),
  PRIMARY KEY (bucket, subject_hash, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_windows_window_start ON rate_limit_windows(window_start);
