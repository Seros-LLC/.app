
-- 0002_meter_cost.sql
-- H3: the meter carries cost. Every model call now records workspace, purpose,
-- tier, model, prompt version, token counts and a cost priced at call time from
-- the versioned price table (src/provider/pricing.ts), so spend is attributable
-- to the thing it was spent on (brief 1.10) and the budget hard stop inside the
-- provider abstraction has something to compare against (invariant 18).
--
-- `action_meter` is owned by THIS migration: 0001 no longer creates it, so the
-- table is created once here in its full shape. That keeps the file idempotent
-- the way 0001 is - migrateDb() re-executes every migration on every boot, and
-- SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and no way to branch
-- on DDL, so a bare ALTER would raise "duplicate column name" on the second boot
-- and take the app down. Every statement below is a no-op the second time.
--
-- Contains no customer content by construction: ids, counts, prices, outcomes.

CREATE TABLE IF NOT EXISTS action_meter (
  workspace_id           TEXT    NOT NULL REFERENCES workspaces(id),
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose                TEXT    NOT NULL CHECK(purpose IN ('detect','draft','route','replay','other')),
  outcome                TEXT    NOT NULL CHECK(outcome IN ('ok','timeout','invalid_output','provider_error','budget_blocked')),
  at                     INTEGER NOT NULL,
  tier                   TEXT             CHECK(tier IS NULL OR tier IN ('cheap','standard','careful')),
  provider               TEXT,
  model                  TEXT,
  prompt_version         TEXT,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens    INTEGER NOT NULL DEFAULT 0,
  estimated_cost_micros  INTEGER NOT NULL DEFAULT 0,   -- priced at call time, versioned table
  price_table_version    TEXT,
  latency_ms             INTEGER,
  ref_type               TEXT,                          -- what the call was for ...
  ref_id                 TEXT,                          -- ... so cost attaches to a draft
  billable_action        INTEGER NOT NULL DEFAULT 1
);

-- Budget reads are "spend for this workspace since <timestamp>", on every call.
CREATE INDEX IF NOT EXISTS action_meter_ws_at ON action_meter (workspace_id, at);
CREATE INDEX IF NOT EXISTS action_meter_at    ON action_meter (at);
