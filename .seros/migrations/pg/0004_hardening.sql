-- migrations/pg/0004_hardening.sql
-- Postgres mirror of migrations/0004_hardening.sql.
-- M9: the idempotency key was documented as unique and enforced by nothing.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_key ON tasks (workspace_id, idempotency_key);

-- M4: the reaper needs to find claimed-and-stale jobs cheaply.
CREATE INDEX IF NOT EXISTS jobs_status_runat ON jobs (status, run_at);
