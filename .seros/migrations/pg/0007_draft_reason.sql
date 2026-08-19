-- migrations/pg/0007_draft_reason.sql
-- Postgres mirror of migrations/0007_draft_reason.sql (the 1:1 reason sidecar).
-- Same table, same primary key, same cascading foreign key, same length cap and
-- the same index; created_at is BIGINT because it carries epoch milliseconds.
--
-- The reason IS derived from customer content, which is why it lives here in the
-- tenant tables next to `drafts.title` and never in `audit_log` or a log line.

CREATE TABLE IF NOT EXISTS draft_reasons (
  workspace_id   TEXT   NOT NULL REFERENCES workspaces(id),
  draft_id       TEXT   NOT NULL,
  reason         TEXT   NOT NULL CHECK(length(reason) <= 200),
  prompt_version TEXT   NOT NULL,
  created_at     BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, draft_id),
  FOREIGN KEY (workspace_id, draft_id) REFERENCES drafts(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS draft_reasons_ws ON draft_reasons (workspace_id, draft_id);
