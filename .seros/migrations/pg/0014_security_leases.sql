-- Security hardening: queue leases and tracker-write fencing.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claimed_at BIGINT;
CREATE INDEX IF NOT EXISTS jobs_running_claimed_at ON jobs (status, claimed_at);

ALTER TABLE task_writes ADD COLUMN IF NOT EXISTS claim_token TEXT;
