-- migrations/pg/0012_confirmation_edits.sql
-- Postgres mirror of migrations/0012_confirmation_edits.sql (the 1:1 edits
-- sidecar that keeps the model's draft and the human's final values apart).
-- Same table, same primary key, same cascading foreign key, same index;
-- created_at is BIGINT because it carries epoch milliseconds.
--
-- These columns hold customer content (a task title is the customer's words),
-- so they sit here in the tenant tables next to `drafts.title` and are NEVER
-- written to the audit log or a log line.

CREATE TABLE IF NOT EXISTS confirmation_edits (
  workspace_id    TEXT   NOT NULL REFERENCES workspaces(id),
  confirmation_id TEXT   NOT NULL,
  edited_fields   TEXT   NOT NULL,
  title           TEXT,
  outcome         TEXT,
  owner           TEXT,
  due_date        TEXT,
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, confirmation_id),
  FOREIGN KEY (workspace_id, confirmation_id)
    REFERENCES confirmations(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS confirmation_edits_ws
  ON confirmation_edits (workspace_id, confirmation_id);
