
// src/db/schema.ts
// Drizzle ORM schema for multi-tenant Seros app
import { sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';   // M11: database-side default for audit request ids

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status', { enum: ['active','suspended','deleting','deleted'] }).notNull().default('active'),
  retentionContentDays: integer('retention_content_days').notNull().default(30),
  dailyBudgetCents: integer('daily_budget_cents').notNull().default(0),
  monthlyBudgetCents: integer('monthly_budget_cents').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const members = sqliteTable('members', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  id: text('id').notNull(),
  name: text('name').notNull(),
  role: text('role', { enum: ['owner','admin','confirmer','viewer'] }).notNull(),
  status: text('status', { enum: ['invited','active','suspended','removed'] }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.id] })]);

// What a member uses to PROVE they are that member (migration 0006_auth.sql, which
// owns this table). One row per member, created lazily the first time a credential
// or an invite is issued. It is a separate table rather than five more columns on
// `members` because src/db/client.ts re-executes every migration on every boot and
// SQLite cannot add a column conditionally - 0006's header carries the full
// argument, including why replacing `members` would break the confirmations foreign
// key. ON DELETE CASCADE ties a credential's life to its member's, so deleting a
// workspace (src/retention.ts) erases the credentials with it.
//
// Content-free by construction: a hash, a salt, timestamps and a failure count.
// `password_hash` is `scrypt$N$r$p$<salt-b64>$<hash-b64>` (src/password.ts) and the
// invite token is stored ONLY as its SHA-256, so nothing here can be replayed as a
// credential if the database leaks.
export const memberCredentials = sqliteTable('member_credentials', {
  workspaceId: text('workspace_id').notNull(),
  memberId: text('member_id').notNull(),
  email: text('email'),
  passwordHash: text('password_hash'),
  passwordSetAt: integer('password_set_at'),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: integer('locked_until'),
  lastLoginAt: integer('last_login_at'),
  inviteTokenHash: text('invite_token_hash'),
  inviteIssuedAt: integer('invite_issued_at'),
  inviteExpiresAt: integer('invite_expires_at'),
  inviteUsedAt: integer('invite_used_at'),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.memberId] })]);

export const sourceMessages = sqliteTable('source_messages', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  channelId: text('channel_id').notNull(),
  ts: text('ts').notNull(),
  id: text('id').notNull(), // unique = (workspace, channel, ts)
  authorId: text('author_id').notNull(),
  body: text('body'),                 // NULL once purged; identifiers survive
  bodyHash: text('body_hash').notNull(),
  contentPurgedAt: integer('content_purged_at'),
  receivedAt: integer('received_at').notNull(),
}, (t)=>[
  primaryKey({columns:[t.workspaceId,t.channelId,t.ts]}),
  uniqueIndex('msg_wc_ts').on(t.workspaceId,t.channelId,t.ts),
]);

export const drafts = sqliteTable('drafts', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  id: text('id').notNull(),
  sourceMessageId: text('source_message_id').notNull().references(() => sourceMessages.id),
  title: text('title').notNull(),
  outcome: text('outcome').notNull(),
  kind: text('kind', { enum:['commitment','request','decision'] }).notNull(),
  confidence: integer('confidence').notNull(),
  suppressedReason: text('suppressed_reason'),
  suggestedDueDate: text('suggested_due_date'),
  suggestedOwner: text('suggested_owner'),
  state: text('state', { enum:['pending','confirmed','rejected','expired','superseded'] }).notNull().default('pending'),
  provider: text('provider'),
  createdAt: integer('created_at').notNull(),
}, (t)=>[
  primaryKey({columns:[t.workspaceId,t.id]})
]);

// The model-written "why this was read as a commitment", one row per draft
// (migration 0007_draft_reason.sql, which owns this table and explains why it is a
// sidecar rather than a column on `drafts`: `confirmations` holds a foreign key to
// `drafts`, so the "new table under a new name" trick 0002 and 0005 used cannot be
// applied to `drafts` itself, and SQLite has no ADD COLUMN IF NOT EXISTS). Tenant
// owned and derived from customer content: reachable ONLY through WorkspaceScope,
// exactly like `drafts`.
export const draftReasons = sqliteTable('draft_reasons', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  draftId: text('draft_id').notNull(),
  reason: text('reason').notNull(),
  promptVersion: text('prompt_version').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t)=>[
  primaryKey({columns:[t.workspaceId,t.draftId]})
]);

export const confirmations = sqliteTable('confirmations', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  draftId: text('draft_id').notNull().references(() => drafts.id),
  id: text('id').notNull(), // confirmation id
  decision: text('decision', { enum:['confirmed','confirmed_with_edits','rejected'] }).notNull(),
  surface: text('surface', { enum:['web','slack_action'] }).notNull(),
  memberId: text('member_id').notNull().references(() => members.id),
  createdAt: integer('created_at').notNull(),
}, (t)=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  uniqueIndex('uniq_confirm_draft').on(t.workspaceId,t.draftId)
]);

export const tasks = sqliteTable('tasks', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  id: text('id').notNull(),
  confirmationId: text('confirmation_id').notNull().references(() => confirmations.id), // 1:1 with confirmation
  writeState: text('write_state', { enum:['queued','created','failed','needs_review'] }).notNull().default('queued'),
  threadReplyState: text('thread_reply_state', { enum:['pending','posted','skipped','failed'] }).notNull().default('pending'),
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t)=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  uniqueIndex('uniq_confirm_task').on(t.workspaceId,t.confirmationId)
]);

// M11: the audit row is the brief's AuditEvent (§1.11) and lives in `audit_log`,
// owned by migration 0005_audit_append_only.sql. That migration also installs the
// BEFORE UPDATE / BEFORE DELETE triggers that RAISE(ABORT), so append-only holds
// in the database even when application code is wrong, and a CHECK that refuses a
// `detail` carrying a content-bearing field name. The old `audit_events` table is
// dead; 0005 carries its rows across. Every field added here has a default, so the
// existing four-argument insert in WorkspaceScope.audit still compiles and works:
// actor_type falls back to `system` and request_id is generated by the database.
// Content-free by construction: ids, field names, counts, states, timestamps.
export const auditEvents = sqliteTable('audit_log', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  id: integer('id').primaryKey({autoIncrement:true}),          // monotonic (AUTOINCREMENT)
  actorType: text('actor_type', { enum:['member','system','operator'] }).notNull().default('system'),
  actorId: text('actor_id'),                                   // required when actorType is 'member'
  event: text('event').notNull(),                              // brief `action`
  objectType: text('object_type'),                             // what it was done to ...
  objectId: text('object_id'),                                 // ... and which one
  outcome: text('outcome', { enum:['ok','denied','failed'] }).notNull(),
  requestId: text('request_id').notNull().default(sql`(lower(hex(randomblob(8))))`),
  detail: text('detail'),                                      // JSON: field names, counts, states
  at: integer('at').notNull(),                                 // brief `occurred_at`
});

// The meter row is the cost record (migration 0002_meter_cost.sql, which owns
// this table). Every added column has a default, so the old four-field insert in
// WorkspaceScope.meter still compiles and still works. Contains no customer
// content by construction: ids, counts, prices, outcomes.
export const actionMeter = sqliteTable('action_meter', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  id: integer('id').primaryKey({autoIncrement:true}),
  purpose: text('purpose', { enum:['detect','draft','route','replay','other'] }).notNull(),
  outcome: text('outcome', { enum:['ok','timeout','invalid_output','provider_error','budget_blocked'] }).notNull(),
  at: integer('at').notNull(),
  tier: text('tier', { enum:['cheap','standard','careful'] }),
  provider: text('provider'),
  model: text('model'),
  promptVersion: text('prompt_version'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
  estimatedCostMicros: integer('estimated_cost_micros').notNull().default(0),
  priceTableVersion: text('price_table_version'),
  latencyMs: integer('latency_ms'),
  refType: text('ref_type'),
  refId: text('ref_id'),
  billableAction: integer('billable_action').notNull().default(1),
});

  export const jobs = sqliteTable('jobs', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  id: text('id').notNull(),
  queue: text('queue').notNull(),
  status: text('status', { enum:['queued','running','done','failed','dead_letter'] }).notNull().default('queued'),
  payload: text('payload').notNull(),
  runAt: integer('run_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  }, (t)=>[
    primaryKey({columns:[t.workspaceId,t.id]})
  ]);

// ---------------------------------------------------------------------------
// Embeddings table – stores a dense vector (as base64‑encoded Float32Array) for
// searchable objects such as drafts, tasks, or source messages.
// object_type limited to a small whitelist; no foreign‑key constraints keep the
// schema simple. Primary key (workspace_id, object_id) guarantees a single
// embedding per object.
// ---------------------------------------------------------------------------
export const embeddings = sqliteTable('embeddings', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  objectId: text('object_id').notNull(),
  objectType: text('object_type', { enum: ['draft', 'task', 'source_message'] }).notNull(),
  // Vector stored as base64 text – SQLite does not have a native BLOB type in the
  // drizzle sqlite core, and base64 works fine for our modest data size.
  vector: text('vector').notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.objectId] })]);
