
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleting','deleted')),
  retention_content_days INTEGER NOT NULL DEFAULT 30,
  daily_budget_cents INTEGER NOT NULL DEFAULT 0,
  monthly_budget_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','confirmer','viewer')),
  status TEXT NOT NULL CHECK(status IN ('invited','active','suspended','removed')),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS source_messages (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  channel_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT,
  body_hash TEXT NOT NULL,
  content_purged_at INTEGER,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, channel_id, ts),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS drafts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  provider TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('commitment','request','decision')),
  confidence INTEGER NOT NULL,
  suppressed_reason TEXT,
  suggested_due_date TEXT,
  suggested_owner TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed','rejected','expired','superseded')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, source_message_id) REFERENCES source_messages(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS confirmations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  draft_id TEXT NOT NULL,
  id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('confirmed','confirmed_with_edits','rejected')),
  surface TEXT NOT NULL CHECK(surface IN ('web','slack_action')),
  member_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, draft_id),
  FOREIGN KEY (workspace_id, draft_id)  REFERENCES drafts(workspace_id, id),
  FOREIGN KEY (workspace_id, member_id) REFERENCES members(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS tasks (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  write_state TEXT NOT NULL DEFAULT 'queued' CHECK(write_state IN ('queued','created','failed','needs_review')),
  thread_reply_state TEXT NOT NULL DEFAULT 'pending' CHECK(thread_reply_state IN ('pending','posted','skipped','failed')),
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, confirmation_id),
  FOREIGN KEY (workspace_id, confirmation_id) REFERENCES confirmations(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok','denied','failed')),
  detail TEXT,
  at INTEGER NOT NULL
);


CREATE TABLE IF NOT EXISTS jobs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  queue TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed','dead_letter')),
  payload TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);