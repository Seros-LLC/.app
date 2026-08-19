-- 0005_audit_append_only.sql
-- M11: the audit log was append-only by assertion only. Nothing stopped an
-- UPDATE or a DELETE, and the row was missing the fields the brief mandates
-- (§1.11 AuditEvent): actor_type, actor_id, object_type, object_id, request_id.
-- Without a request id an entry cannot be correlated to a log line (invariant
-- 12); without an actor "who did this" cannot distinguish a member from the
-- system or an operator.
--
-- WHY A NEW TABLE NAME. src/db/client.ts re-executes EVERY migration file on
-- EVERY boot, SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and DDL
-- cannot branch, so a bare ALTER raises "duplicate column name" on the second
-- boot and takes the app down. The pattern that boots N times cleanly is the one
-- 0002_meter_cost.sql used for `action_meter`: create the table in its FULL shape
-- under a NEW name with CREATE TABLE IF NOT EXISTS and stop using the old one.
-- `audit_log` is therefore the audit table from here on; `audit_events` (created
-- by 0001) is dead and is left in place only so an existing database can be read
-- once by the backfill below. Every statement in this file is a no-op the second
-- time it runs.
--
-- Content-free by construction (invariant 14): ids, names of fields, counts,
-- states, outcomes and timestamps only - never a value out of a customer message.

CREATE TABLE IF NOT EXISTS audit_log (
  workspace_id  TEXT    NOT NULL REFERENCES workspaces(id),
  -- brief §1.11 "id id monotonic": AUTOINCREMENT never reuses an id, so the
  -- sequence is strictly increasing for the life of the database.
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type    TEXT    NOT NULL DEFAULT 'system'
                        CHECK(actor_type IN ('member','system','operator')),
  actor_id      TEXT,
  event         TEXT    NOT NULL,               -- brief `action`, e.g. draft.confirmed
  object_type   TEXT,                           -- what it was done to ...
  object_id     TEXT,                           -- ... and which one
  outcome       TEXT    NOT NULL CHECK(outcome IN ('ok','denied','failed')),
  -- brief: `request_id` text req - correlates an audit row with the request log.
  -- Defaulted in the DATABASE so a row can never be written without one, even by
  -- a caller that forgot; a caller that has the real request id passes it.
  request_id    TEXT    NOT NULL DEFAULT (lower(hex(randomblob(8)))),
  -- brief: "field names, counts, states, never values from customer content", and
  -- "a schema-level check plus a test must prove `detail` cannot carry content
  -- fields". detail is a JSON object; the content-carrying key names are refused
  -- by the database itself. (`"body_hash":` and `"edited_fields":"title,..."` are
  -- deliberately NOT matched: the patterns pin the closing quote and the colon.)
  detail        TEXT    CHECK(
                          detail IS NULL OR (
                            detail LIKE '{%}'
                            AND detail NOT LIKE '%"body":%'
                            AND detail NOT LIKE '%"text":%'
                            AND detail NOT LIKE '%"title":%'
                            AND detail NOT LIKE '%"content":%'
                            AND detail NOT LIKE '%"message":%'
                            AND detail NOT LIKE '%"summary":%'
                            AND detail NOT LIKE '%"subject":%'
                            AND detail NOT LIKE '%"permalink":%'
                            AND detail NOT LIKE '%"email":%'
                            AND detail NOT LIKE '%"name":%'
                            AND detail NOT LIKE '%"snippet":%'
                            AND detail NOT LIKE '%"quote":%'
                            AND detail NOT LIKE '%"description":%'
                            AND detail NOT LIKE '%"comment":%'
                          )
                        ),
  at            INTEGER NOT NULL,               -- brief `occurred_at`
  -- a member actor is a real person: it must be identified (invariant: confirmations
  -- reference a Member). system and operator actors may have no id.
  CHECK(actor_type <> 'member' OR actor_id IS NOT NULL)
);

-- The audit page reads "this workspace, newest id first"; the correlation lookup
-- is "everything that happened under this request id" (invariant 12).
CREATE INDEX IF NOT EXISTS audit_log_ws_id   ON audit_log (workspace_id, id);
CREATE INDEX IF NOT EXISTS audit_log_request ON audit_log (request_id);
CREATE INDEX IF NOT EXISTS audit_log_at      ON audit_log (at);

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the DATABASE (M11): "mutable by nobody" (invariant 14).
-- Application code being wrong must not be enough to rewrite history, so the ban
-- lives below every ORM, every route and every job.
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is refused');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: DELETE is refused');
END;

-- ---------------------------------------------------------------------------
-- One-time backfill of any history already in the old table. Idempotent twice
-- over: the NOT EXISTS skips rows already carried across, and OR IGNORE drops a
-- legacy row that cannot satisfy the new content check rather than aborting the
-- boot. Ids are preserved, so AUTOINCREMENT continues above the highest one and
-- monotonicity survives the move. On a fresh database this copies nothing.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO audit_log (workspace_id, id, actor_type, event, outcome, detail, at)
SELECT a.workspace_id, a.id, 'system', a.event, a.outcome, a.detail, a.at
  FROM audit_events a
 WHERE NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.id = a.id);
