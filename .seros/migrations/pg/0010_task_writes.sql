-- 0010: the tracker write becomes two-phase, and honest.
--
-- Before this migration `tasks.write_state` was set to 'created' BEFORE the
-- external call. A failed call therefore left a task that claimed to exist in
-- the customer's tracker and could never be retried: handleTrackerWrite returns
-- early on write_state='created'. A confirmed task silently never arrived.
--
-- The claim now lives in a sidecar row instead of a new write_state value,
-- because tasks.write_state carries a CHECK constraint in 0001 and SQLite
-- cannot alter one without rebuilding the table. tasks.write_state='created'
-- now means exactly one thing: the issue exists in the tracker, and we hold its
-- id. The lease makes the claim recoverable after a worker dies mid-write.
CREATE TABLE IF NOT EXISTS task_writes (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id      TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'claimed' CHECK(state IN ('claimed','done')),
  tracker      TEXT,
  external_id  TEXT,
  external_url TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  claimed_at   BIGINT  NOT NULL,
  completed_at BIGINT,
  PRIMARY KEY (workspace_id, task_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS task_writes_state ON task_writes (workspace_id, state, claimed_at);
