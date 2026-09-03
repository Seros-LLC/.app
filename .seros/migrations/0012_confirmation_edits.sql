-- 0012_confirmation_edits.sql
-- What the model proposed and what the human changed it to, kept apart.
--
-- Until now a `confirmed_with_edits` decision applied the human's values on top
-- of the draft with an UPDATE, in place. The draft row is the only record of
-- what the model actually said, so every edit destroyed it: afterwards nobody
-- could tell whether the model got it right and the human agreed, or the model
-- got it wrong and the human rewrote it. Those are opposite facts about model
-- quality and they were being stored identically.
--
-- ADR 0002 calls the confirm loop "the product's only compounding data asset",
-- and REVIEW.md M6 is explicit that edits and rejections are "data, not
-- discards". Acceptance rate and owner accuracy are not computable from a table
-- that has been overwritten. This is that finding's fix.
--
-- WHY A SIDECAR TABLE AND NOT `ALTER TABLE confirmations ADD COLUMN`.
-- The same reason 0007_draft_reason.sql gives: src/db/driver.ts re-executes
-- EVERY migration file on EVERY boot, SQLite has no
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and DDL cannot branch, so a bare
-- ALTER raises "duplicate column name" on the SECOND boot and takes the app
-- down. `confirmations` also has a child (`tasks` references it), so the
-- re-create-under-a-new-name trick that 0002 and 0005 used is not available
-- either. A 1:1 sidecar keyed by the confirmation is the shape this codebase
-- already settled on.
--
-- ON DELETE CASCADE for the same reason as draft_reasons: src/retention.ts
-- deletes confirmations, and a sidecar that refuses that delete would turn
-- "delete my workspace" into a foreign key error.
--
-- These columns hold customer content (a task title is the customer's words),
-- so they sit here in the tenant tables next to `drafts.title` and are NEVER
-- written to the audit log or a log line. The audit row records field NAMES
-- only, which is why `edited_fields` is safe there and the values are not.

CREATE TABLE IF NOT EXISTS confirmation_edits (
  workspace_id    TEXT    NOT NULL REFERENCES workspaces(id),
  confirmation_id TEXT    NOT NULL,
  -- Field names that differ from the draft, comma-separated: 'title,owner'.
  -- An empty string means the human was offered the edit form and changed
  -- nothing, which is a different fact from never having been offered it
  -- (no row at all).
  edited_fields   TEXT    NOT NULL,
  -- The values the human agreed to. NULL on any field the human did not
  -- change, so a reader can tell "unchanged" from "changed to the same thing".
  title           TEXT,
  outcome         TEXT,
  owner           TEXT,
  due_date        TEXT,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, confirmation_id),
  FOREIGN KEY (workspace_id, confirmation_id)
    REFERENCES confirmations(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS confirmation_edits_ws
  ON confirmation_edits (workspace_id, confirmation_id);
