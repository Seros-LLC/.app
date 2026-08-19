-- M9: the idempotency key was documented as unique and enforced by nothing.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_key ON tasks (workspace_id, idempotency_key);

-- M4: a job claimed by a worker that then dies sat in 'running' forever. The
-- reaper needs to know when the claim was made, so record it.
CREATE INDEX IF NOT EXISTS jobs_status_runat ON jobs (status, run_at);
