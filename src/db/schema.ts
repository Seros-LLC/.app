
// src/db/schema.ts
// Drizzle ORM schema for multi-tenant Seros app
import { sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  sourceMessageId: text('source_message_id').notNull(),
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

export const confirmations = sqliteTable('confirmations', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  draftId: text('draft_id').notNull(),
  id: text('id').notNull(), // confirmation id
  decision: text('decision', { enum:['confirmed','confirmed_with_edits','rejected'] }).notNull(),
  surface: text('surface', { enum:['web','slack_action'] }).notNull(),
  memberId: text('member_id').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t)=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  uniqueIndex('uniq_confirm_draft').on(t.workspaceId,t.draftId)
]);

export const tasks = sqliteTable('tasks', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  id: text('id').notNull(),
  confirmationId: text('confirmation_id').notNull(), // 1:1 with confirmation
  writeState: text('write_state', { enum:['queued','created','failed','needs_review'] }).notNull().default('queued'),
  threadReplyState: text('thread_reply_state', { enum:['pending','posted','skipped','failed'] }).notNull().default('pending'),
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t)=>[
  primaryKey({columns:[t.workspaceId,t.id]}),
  uniqueIndex('uniq_confirm_task').on(t.workspaceId,t.confirmationId)
]);

export const auditEvents = sqliteTable('audit_events', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  id: integer('id').primaryKey({autoIncrement:true}),
  event: text('event').notNull(),
  outcome: text('outcome', { enum:['ok','denied','failed'] }).notNull(),
  detail: text('detail'),
  at: integer('at').notNull(),
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
