-- 0007_draft_reason.sql
-- The queue card carries a short, model-written reason for WHY a message was read
-- as a commitment, computed once at draft time and stored next to the draft.
--
-- WHY THIS IS A TABLE AND NOT `ALTER TABLE drafts ADD COLUMN reason`.
-- src/db/client.ts re-executes EVERY migration file on EVERY boot, SQLite has no
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and DDL cannot branch on anything, so
-- a bare ALTER raises "duplicate column name" on the SECOND boot and takes the app
-- down. 0002_meter_cost.sql and 0005_audit_append_only.sql both hit this and both
-- answered it the same way: create a table in its FULL shape, under a name that does
-- not exist yet, with CREATE TABLE IF NOT EXISTS, so the file is a no-op the second
-- time it runs.
--
-- Those two migrations could REPLACE the table they were widening (`action_meter`
-- and `audit_events` have no children). `drafts` does: `confirmations` holds
--   FOREIGN KEY (workspace_id, draft_id) REFERENCES drafts(workspace_id, id)
-- and tasks hang off confirmations, so re-creating `drafts` under a new name would
-- either orphan every confirmation or require dropping a table that live rows point
-- at, with `PRAGMA foreign_keys = ON` (src/db/client.ts sets it). Rebuilding `drafts`
-- in place on every boot would rewrite the whole table every boot and drop a
-- referenced table while children exist. Neither is acceptable for one nullable
-- field, so the field lives in a 1:1 sidecar keyed by the draft it belongs to.
-- Reading a draft with its reason is a join, and there is exactly one row per draft.
--
-- ON DELETE CASCADE is deliberate: src/retention.ts `deleteWorkspace` deletes drafts,
-- and a sidecar that refuses that delete would turn "delete my workspace" into a
-- foreign key error. The reason is derived data about a draft; when the draft goes,
-- it goes with it.
--
-- The reason IS derived from customer content, which is why it lives here in the
-- tenant tables next to `drafts.title` and never in `audit_log` or a log line.

CREATE TABLE IF NOT EXISTS draft_reasons (
  workspace_id    TEXT    NOT NULL REFERENCES workspaces(id),
  draft_id        TEXT    NOT NULL,
  -- One short sentence. The cap is enforced again in code (about 20 words), but a
  -- runaway model must not be able to write an essay into this table either.
  reason          TEXT    NOT NULL CHECK(length(reason) <= 200),
  -- Which prompt produced it, so a bad batch can be identified and a rollback is a
  -- flag flip, exactly as with the meter's prompt_version.
  prompt_version  TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, draft_id),
  FOREIGN KEY (workspace_id, draft_id) REFERENCES drafts(workspace_id, id) ON DELETE CASCADE
);

-- The queue page reads "the reasons for these drafts, in this workspace".
CREATE INDEX IF NOT EXISTS draft_reasons_ws ON draft_reasons (workspace_id, draft_id);
