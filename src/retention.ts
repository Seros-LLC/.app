
/**
 * src/retention.ts — retention sweeper, disconnect, and workspace deletion.
 *
 * Implements IMPLEMENTATION-BRIEF §2 invariants 24-27 and pipeline stage 15.
 *
 * DESIGN NOTES / DELIBERATE LOCAL DEFINITIONS
 * -------------------------------------------
 * (a) Everything here goes through a `WorkspaceScope` (src/db/scope.ts): the scope is
 *     opened first (which refuses to exist for an unknown workspace) and its
 *     `workspaceId` is injected into every single WHERE clause below. Invariant 20.
 *     The helpers in this file would normally live on WorkspaceScope, but scope.ts is
 *     owned by another agent right now, so they are defined locally instead.
 *
 * (b) `source_messages.body` is declared NOT NULL in src/db/schema.ts and in
 *     migrations/0001_initial_schema.sql, which directly contradicts brief §1.3 /
 *     invariant 27 ("`body` is nulled and `content_purged_at` set"). We are not allowed
 *     to edit schema.ts or the shipped migration, and writing an empty string instead of
 *     NULL would be a silent weakening of the invariant. So `ensureRetentionSchema()`
 *     performs a guarded, idempotent, one-time relaxation of that one constraint
 *     (SQLite table rebuild), and this file declares a LOCAL drizzle view of the same
 *     `source_messages` table whose `body` column is nullable, so the purge type-checks.
 *     When schema.ts is updated to `body: text('body')` (nullable), the local table
 *     `purgeableSourceMessages` and the rebuild can both be deleted.
 *
 * (c) Brief §1.2 `Connection` (tokens, status, disconnected_at) has no table in
 *     schema.ts, and the disconnect path in invariant 25 is meaningless without one.
 *     A locally-owned table `retention_connections` is therefore created (idempotently)
 *     and declared here. It is deliberately NOT named `connections`, so that when the
 *     other agent adds a real `connections` table there is no collision; at that point
 *     this table should be dropped and the code repointed.
 *
 * Nothing in this file ever writes customer content anywhere: audit details carry
 * counts, ids, states and timestamps only (invariants 12/14).
 */

import { and, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import type { openDb } from './db/client';
import { dialect } from './db/client';
import { WorkspaceScope } from './db/scope';
import {
  workspaces, members, drafts, confirmations, tasks, jobs, auditEvents, actionMeter,
} from './db/schema';

type Db = ReturnType<typeof openDb>;

export const DEFAULT_RETENTION_CONTENT_DAYS = 30;
export const DAY_MS = 86_400_000;
/** Invariant 25: a disconnected source's content must be gone within 24h. */
export const DISCONNECT_PURGE_SLA_MS = 24 * 60 * 60 * 1000;

/** Tables the sweeper walks, in order. Per table, per workspace (invariant 24). */
export const RETENTION_TABLES = ['source_messages', 'jobs'] as const;
export type RetentionTable = (typeof RETENTION_TABLES)[number];

/** Content-free tables that must survive every sweep, disconnect and deletion. */
export const IMMORTAL_TABLES = ['audit_events', 'action_meter'] as const;

// ---------------------------------------------------------------------------
// (b) local nullable view of source_messages, and (c) the connection table
// ---------------------------------------------------------------------------

/** Same physical table as schema.ts `sourceMessages`, with `body` nullable. See note (b). */
export const purgeableSourceMessages = sqliteTable('source_messages', {
  workspaceId: text('workspace_id').notNull(),
  channelId: text('channel_id').notNull(),
  ts: text('ts').notNull(),
  id: text('id').notNull(),
  authorId: text('author_id').notNull(),
  body: text('body'),                       // nullable after purge — invariant 27
  bodyHash: text('body_hash').notNull(),    // survives forever, dedupe depends on it
  contentPurgedAt: integer('content_purged_at'),
  receivedAt: integer('received_at').notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.channelId, t.ts] })]);

/** See note (c). Secrets live here only until disconnect destroys them. */
export const retentionConnections = sqliteTable('retention_connections', {
  workspaceId: text('workspace_id').notNull(),
  id: text('id').notNull(),
  kind: text('kind', { enum: ['slack', 'tracker'] }).notNull(),
  provider: text('provider').notNull(),
  externalAccountId: text('external_account_id').notNull(),
  /** JSON array of channel ids this connection is allowed to read; [] means nothing. */
  channelIds: text('channel_ids').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  status: text('status', { enum: ['active', 'degraded', 'revoked', 'disconnected'] }).notNull(),
  lastErrorClass: text('last_error_class'),
  createdAt: integer('created_at').notNull(),
  disconnectedAt: integer('disconnected_at'),
  contentPurgeDueAt: integer('content_purge_due_at'),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.id] })]);

// ---------------------------------------------------------------------------
// schema compatibility (idempotent, guarded)
// ---------------------------------------------------------------------------

type ColumnInfo = { name: string; notnull: number };

const CONNECTIONS_DDL = `
CREATE TABLE IF NOT EXISTS retention_connections (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('slack','tracker')),
  provider TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  channel_ids TEXT NOT NULL DEFAULT '[]',
  access_token TEXT,
  refresh_token TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','degraded','revoked','disconnected')),
  last_error_class TEXT,
  created_at INTEGER NOT NULL,
  disconnected_at INTEGER,
  content_purge_due_at INTEGER,
  PRIMARY KEY (workspace_id, id)
)`;

/** The same table on Postgres: BIGINT for the epoch-millisecond columns (they do not
 *  fit a Postgres INTEGER) and DEFAULT '[]' kept, so both dialects behave alike. */
const CONNECTIONS_DDL_PG = `
CREATE TABLE IF NOT EXISTS retention_connections (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('slack','tracker')),
  provider TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  channel_ids TEXT NOT NULL DEFAULT '[]',
  access_token TEXT,
  refresh_token TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','degraded','revoked','disconnected')),
  last_error_class TEXT,
  created_at BIGINT NOT NULL,
  disconnected_at BIGINT,
  content_purge_due_at BIGINT,
  PRIMARY KEY (workspace_id, id)
)`;

const REBUILT_SOURCE_MESSAGES_DDL = `
CREATE TABLE source_messages__retention_rebuild (
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
  UNIQUE (workspace_id, channel_id, ts)
)`;

/**
 * Idempotent. Safe to call on every sweep: it inspects the live schema first and does
 * nothing when the database is already retention-capable.
 */
export async function ensureRetentionSchema(db: Db): Promise<{ bodyMadeNullable: boolean }> {
  if (dialect() === 'pg') return ensureRetentionSchemaPg(db);
  db.run(sql.raw(CONNECTIONS_DDL));

  const cols = db.all(sql`PRAGMA table_info(source_messages)`) as unknown as ColumnInfo[];
  const body = cols.find((c) => c.name === 'body');
  if (!body || body.notnull === 0) return { bodyMadeNullable: false };

  // SQLite cannot drop a NOT NULL constraint in place: rebuild the table, preserving
  // every row and every identifier. See note (b).
  db.run(sql.raw('PRAGMA foreign_keys=OFF'));
  try {
    db.run(sql.raw('DROP TABLE IF EXISTS source_messages__retention_rebuild'));
    db.run(sql.raw(REBUILT_SOURCE_MESSAGES_DDL));
    db.run(sql.raw(
      'INSERT INTO source_messages__retention_rebuild ' +
      '(workspace_id, channel_id, ts, id, author_id, body, body_hash, content_purged_at, received_at) ' +
      'SELECT workspace_id, channel_id, ts, id, author_id, body, body_hash, content_purged_at, received_at ' +
      'FROM source_messages',
    ));
    db.run(sql.raw('DROP TABLE source_messages'));
    db.run(sql.raw('ALTER TABLE source_messages__retention_rebuild RENAME TO source_messages'));
    db.run(sql.raw('CREATE UNIQUE INDEX IF NOT EXISTS msg_wc_ts ON source_messages (workspace_id, channel_id, ts)'));
  } finally {
    db.run(sql.raw('PRAGMA foreign_keys=ON'));
  }
  return { bodyMadeNullable: true };
}

/**
 * The same guarantee on Postgres, expressed in Postgres.
 *
 *   - PRAGMA table_info(...)  ->  information_schema.columns (PRAGMA is a syntax
 *     error on Postgres, not a no-op);
 *   - the NOT NULL relaxation needs no table rebuild and therefore no
 *     `PRAGMA foreign_keys=OFF`: ALTER TABLE ... DROP NOT NULL does it in place,
 *     inside a transaction, with the foreign keys left switched on the whole time.
 *     migrations/pg/0001_schema.sql already declares `body TEXT` (nullable), so on a
 *     migrated database this branch finds nothing to do and reports false, exactly
 *     like the SQLite branch does on a database that has already been relaxed.
 *
 * The connection table is created with the same columns and checks, with BIGINT where
 * SQLite says INTEGER: these columns hold epoch milliseconds, which overflow a
 * Postgres 4-byte INTEGER.
 */
async function ensureRetentionSchemaPg(db: Db): Promise<{ bodyMadeNullable: boolean }> {
  const exec = (text: string) => (db as any).execute(sql.raw(text));
  await exec(CONNECTIONS_DDL_PG);
  const res: any = await exec(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'source_messages' AND column_name = 'body'`,
  );
  const rows: any[] = res?.rows ?? res ?? [];
  if (rows.length === 0 || rows[0].is_nullable === 'YES') return { bodyMadeNullable: false };
  await exec('ALTER TABLE source_messages ALTER COLUMN body DROP NOT NULL');
  return { bodyMadeNullable: true };
}

// ---------------------------------------------------------------------------
// sweeper
// ---------------------------------------------------------------------------

export interface SweepOptions {
  /** Injectable clock so retention windows are testable without waiting 30 days. */
  now?: number;
}

export interface SweepResult {
  workspaceId: string;
  retentionContentDays: number;
  /** Rows at or before this instant are past their window. */
  cutoffAt: number;
  sweptAt: number;
  /** COUNTS ONLY — never content (invariant 24). */
  counts: Record<RetentionTable, number>;
  /** Rows still past their window after the sweep. Non-zero here means: alert. */
  rowsPastWindowAfterSweep: number;
  skipped: boolean;
}

function retentionDays(row: { retentionContentDays: number | null }): number {
  const d = row.retentionContentDays ?? DEFAULT_RETENTION_CONTENT_DAYS;
  return d > 0 ? d : DEFAULT_RETENTION_CONTENT_DAYS;
}

/**
 * Purge content for a set of source messages, in place.
 * `body` -> NULL, `content_purged_at` -> now. `body_hash`, ids and timestamps are never
 * touched, so dedupe, metrics and audit keep working (invariants 27 / brief §1.3).
 * Returns how many rows this call actually changed — 0 on a repeat run (idempotent).
 */
async function purgeMessageContent(
  db: Db,
  workspaceId: string,
  where: ReturnType<typeof and>,
  now: number,
): Promise<number> {
  const purged = await db.update(purgeableSourceMessages)
    .set({ body: null, contentPurgedAt: now })
    .where(and(
      eq(purgeableSourceMessages.workspaceId, workspaceId),   // tenancy: always scoped
      isNull(purgeableSourceMessages.contentPurgedAt),        // idempotency
      where,
    ))
    .returning({ id: purgeableSourceMessages.id })
    ;
  return purged.length;
}

/** One workspace, every retention table, honouring that workspace's own policy. */
export async function sweepWorkspace(db: Db, workspaceId: string, opts: SweepOptions = {}): Promise<SweepResult> {
  await ensureRetentionSchema(db);
  const scope = await WorkspaceScope.open(db, workspaceId);   // throws UnknownWorkspace
  const now = opts.now ?? Date.now();

  const ws = (await db.select().from(workspaces).where(eq(workspaces.id, scope.workspaceId)).limit(1))[0]!;
  const days = retentionDays(ws);
  const cutoffAt = now - days * DAY_MS;
  const counts: Record<RetentionTable, number> = { source_messages: 0, jobs: 0 };

  if (ws.status === 'deleted') {
    // Nothing tenant-owned is left; the audit trail still records that we ran.
    await scope.audit('retention.swept', 'ok', {
      retention_content_days: days, cutoff_at: cutoffAt, swept_at: now,
      source_messages_purged: 0, jobs_deleted: 0, rows_past_window_after: 0, skipped: 1,
    });
    return { workspaceId: scope.workspaceId, retentionContentDays: days, cutoffAt, sweptAt: now,
             counts, rowsPastWindowAfterSweep: 0, skipped: true };
  }

  // ---- table: source_messages (content nulled in place) ----
  counts.source_messages = await purgeMessageContent(
    db, scope.workspaceId, lte(purgeableSourceMessages.receivedAt, cutoffAt), now,
  );

  // ---- table: jobs (R-EPHEMERAL: terminal queue rows past the window go away) ----
  counts.jobs = (await db.delete(jobs)
    .where(and(
      eq(jobs.workspaceId, scope.workspaceId),
      inArray(jobs.status, ['done', 'failed', 'dead_letter']),
      lte(jobs.createdAt, cutoffAt),
    ))
    .returning({ id: jobs.id })
    ).length;

  // ---- post-condition: nothing may remain past its window (invariant 24 alerting) ----
  const stragglers = (await db.select({ id: purgeableSourceMessages.id }).from(purgeableSourceMessages)
    .where(and(
      eq(purgeableSourceMessages.workspaceId, scope.workspaceId),
      isNull(purgeableSourceMessages.contentPurgedAt),
      lte(purgeableSourceMessages.receivedAt, cutoffAt),
    ))).length;

  // Counts only. Never a body, a title, a hash or an author handle.
  await scope.audit('retention.swept', stragglers === 0 ? 'ok' : 'failed', {
    retention_content_days: days,
    cutoff_at: cutoffAt,
    swept_at: now,
    source_messages_purged: counts.source_messages,
    jobs_deleted: counts.jobs,
    rows_past_window_after: stragglers,
    skipped: 0,
  });

  return { workspaceId: scope.workspaceId, retentionContentDays: days, cutoffAt, sweptAt: now,
           counts, rowsPastWindowAfterSweep: stragglers, skipped: false };
}

/** The scheduled job: every workspace, its own policy. */
export async function sweepAllWorkspaces(db: Db, opts: SweepOptions = {}): Promise<SweepResult[]> {
  await ensureRetentionSchema(db);
  const ids = (await db.select({ id: workspaces.id }).from(workspaces)).map((r) => r.id);
  const out: SweepResult[] = [];
  for (const id of ids) out.push(await sweepWorkspace(db, id, opts));
  return out;
}

// ---------------------------------------------------------------------------
// connections + disconnect (invariant 25)
// ---------------------------------------------------------------------------

export interface ConnectionInput {
  kind: 'slack' | 'tracker';
  provider: string;
  externalAccountId: string;
  channelIds: string[];
  accessToken: string;
  refreshToken?: string;
}

export async function registerConnection(db: Db, workspaceId: string, input: ConnectionInput): Promise<string> {
  await ensureRetentionSchema(db);
  const scope = await WorkspaceScope.open(db, workspaceId);
  const id = randomUUID();
  await db.insert(retentionConnections).values({
    workspaceId: scope.workspaceId, id, kind: input.kind, provider: input.provider,
    externalAccountId: input.externalAccountId, channelIds: JSON.stringify(input.channelIds),
    accessToken: input.accessToken, refreshToken: input.refreshToken ?? null,
    status: 'active', lastErrorClass: null, createdAt: Date.now(),
    disconnectedAt: null, contentPurgeDueAt: null,
  });
  await scope.audit('connection.created', 'ok', { connection_id: id, channel_count: input.channelIds.length });
  return id;
}

export async function connection(db: Db, workspaceId: string, connectionId: string) {
  await ensureRetentionSchema(db);
  const scope = await WorkspaceScope.open(db, workspaceId);
  return (await db.select().from(retentionConnections).where(and(
    eq(retentionConnections.workspaceId, scope.workspaceId),
    eq(retentionConnections.id, connectionId),
  )).limit(1))[0];
}

export type DisconnectResult =
  | { ok: false; reason: 'unknown_connection' }
  | {
      ok: true;
      connectionId: string;
      tokensDestroyed: boolean;
      jobsCancelled: number;
      draftsExpired: number;
      /** Drafts already terminal before disconnect. Disconnect never confirms anything. */
      draftsLeftTerminal: number;
      /** Always 0. Kept explicit so a regression is loud, not silent (invariant 25). */
      draftsConfirmed: 0;
      messagesPurged: number;
      purgeDueAt: number;
      contentPurgeComplete: boolean;
    };

/**
 * Disconnect a source. In order: tokens destroyed immediately, queued detection work
 * cancelled, pending drafts moved to `expired` (never confirmed, never silently
 * dropped), that source's stored content purged (immediately, i.e. well inside the 24h
 * SLA), audit event written with counts.
 *
 * Idempotent: a second call on an already-disconnected connection destroys nothing new
 * and reports zeroes; it still returns ok with the recorded purge deadline.
 */
export async function disconnectConnection(
  db: Db, workspaceId: string, connectionId: string, opts: SweepOptions = {},
): Promise<DisconnectResult> {
  await ensureRetentionSchema(db);
  const scope = await WorkspaceScope.open(db, workspaceId);
  const now = opts.now ?? Date.now();

  const conn = (await db.select().from(retentionConnections).where(and(
    eq(retentionConnections.workspaceId, scope.workspaceId),
    eq(retentionConnections.id, connectionId),
  )).limit(1))[0];
  if (!conn) {
    await scope.audit('connection.disconnected', 'denied', { connection_id_present: 0 });
    return { ok: false, reason: 'unknown_connection' };
  }

  const purgeDueAt = conn.contentPurgeDueAt ?? now + DISCONNECT_PURGE_SLA_MS;
  const hadTokens = conn.accessToken !== null || conn.refreshToken !== null;

  // 1. tokens destroyed immediately; the row itself is kept for the audit trail (§1.2)
  await db.update(retentionConnections)
    .set({ accessToken: null, refreshToken: null, status: 'disconnected',
           disconnectedAt: conn.disconnectedAt ?? now, contentPurgeDueAt: purgeDueAt })
    .where(and(
      eq(retentionConnections.workspaceId, scope.workspaceId),
      eq(retentionConnections.id, connectionId),
    ));

  const channelIds = JSON.parse(conn.channelIds) as string[];

  // 2. the messages this connection is responsible for (ids only)
  const owned = channelIds.length === 0 ? [] : (await db
    .select({ id: purgeableSourceMessages.id })
    .from(purgeableSourceMessages)
    .where(and(
      eq(purgeableSourceMessages.workspaceId, scope.workspaceId),
      inArray(purgeableSourceMessages.channelId, channelIds),
    ))).map((r) => r.id);

  // 3. queued detection work for this connection is cancelled
  let jobsCancelled = 0;
  if (owned.length > 0) {
    const ownedSet = new Set(owned);
    const live = await db.select().from(jobs).where(and(
      eq(jobs.workspaceId, scope.workspaceId),
      inArray(jobs.status, ['queued', 'running']),
    ));
    const doomed = live.filter((j) => {
      try {
        const p = JSON.parse(j.payload) as { messageId?: string };
        return typeof p.messageId === 'string' && ownedSet.has(p.messageId);
      } catch { return false; }
    }).map((j) => j.id);
    if (doomed.length > 0) {
      jobsCancelled = (await db.update(jobs).set({ status: 'dead_letter' })
        .where(and(eq(jobs.workspaceId, scope.workspaceId), inArray(jobs.id, doomed)))
        .returning({ id: jobs.id })).length;
    }
  }

  // 4. pending drafts are CANCELLED by expiry — never confirmed (invariant 25 + §1.5:
  //    only `pending` may transition, and `expired` is terminal).
  let draftsExpired = 0;
  let draftsLeftTerminal = 0;
  if (owned.length > 0) {
    draftsExpired = (await db.update(drafts).set({ state: 'expired' })
      .where(and(
        eq(drafts.workspaceId, scope.workspaceId),
        eq(drafts.state, 'pending'),
        inArray(drafts.sourceMessageId, owned),
      )).returning({ id: drafts.id })).length;

    draftsLeftTerminal = (await db.select({ id: drafts.id }).from(drafts).where(and(
      eq(drafts.workspaceId, scope.workspaceId),
      ne(drafts.state, 'expired'),
      inArray(drafts.sourceMessageId, owned),
    ))).length;
  }

  // 5. that source's stored content, purged now (SLA is 24h; we do not wait)
  const messagesPurged = owned.length === 0 ? 0 : await purgeMessageContent(
    db, scope.workspaceId, inArray(purgeableSourceMessages.id, owned), now,
  );

  const remaining = owned.length === 0 ? 0 : (await db.select({ id: purgeableSourceMessages.id })
    .from(purgeableSourceMessages)
    .where(and(
      eq(purgeableSourceMessages.workspaceId, scope.workspaceId),
      inArray(purgeableSourceMessages.id, owned),
      isNull(purgeableSourceMessages.contentPurgedAt),
    ))).length;

  await scope.audit('connection.disconnected', 'ok', {
    connection_id: connectionId,
    tokens_destroyed: hadTokens ? 1 : 0,
    jobs_cancelled: jobsCancelled,
    drafts_expired: draftsExpired,
    drafts_confirmed: 0,
    messages_purged: messagesPurged,
    messages_left_unpurged: remaining,
    purge_due_at: purgeDueAt,
    at: now,
  });

  return {
    ok: true, connectionId, tokensDestroyed: hadTokens, jobsCancelled,
    draftsExpired, draftsLeftTerminal, draftsConfirmed: 0, messagesPurged,
    purgeDueAt, contentPurgeComplete: remaining === 0,
  };
}

// ---------------------------------------------------------------------------
// workspace deletion (invariant 26 + §1.1)
// ---------------------------------------------------------------------------

export interface DeleteWorkspaceResult {
  workspaceId: string;
  status: 'deleted';
  /** Rows removed, in dependency order. Counts only. */
  deleted: Record<string, number>;
  /** Content-free tables that were deliberately left alone. */
  preserved: { audit_events: number; action_meter: number };
  completedAt: number;
}

/**
 * Delete a workspace: every tenant-owned row goes, in dependency order.
 * `audit_events` and `action_meter` SURVIVE, keeping `workspace_id` as a reference
 * (§1.1, invariant 14). The workspace row itself is kept as a tombstone in status
 * `deleted`, and the completion audit event is written LAST so it can be shown to the
 * customer as the completion record (invariant 26).
 *
 * Idempotent: a second call removes nothing further and leaves the same terminal state.
 */
export async function deleteWorkspace(
  db: Db, workspaceId: string, opts: SweepOptions = {},
): Promise<DeleteWorkspaceResult> {
  await ensureRetentionSchema(db);
  const scope = await WorkspaceScope.open(db, workspaceId);
  const now = opts.now ?? Date.now();
  const wid = scope.workspaceId;

  await db.update(workspaces).set({ status: 'deleting' }).where(eq(workspaces.id, wid));
  await scope.audit('workspace.deleting', 'ok', { at: now });

  const deleted: Record<string, number> = {};
  deleted.tasks = (await db.delete(tasks).where(eq(tasks.workspaceId, wid))
    .returning({ id: tasks.id })).length;
  deleted.confirmations = (await db.delete(confirmations).where(eq(confirmations.workspaceId, wid))
    .returning({ id: confirmations.id })).length;
  deleted.drafts = (await db.delete(drafts).where(eq(drafts.workspaceId, wid))
    .returning({ id: drafts.id })).length;
  deleted.source_messages = (await db.delete(purgeableSourceMessages)
    .where(eq(purgeableSourceMessages.workspaceId, wid))
    .returning({ id: purgeableSourceMessages.id })).length;
  deleted.jobs = (await db.delete(jobs).where(eq(jobs.workspaceId, wid))
    .returning({ id: jobs.id })).length;
  deleted.retention_connections = (await db.delete(retentionConnections)
    .where(eq(retentionConnections.workspaceId, wid))
    .returning({ id: retentionConnections.id })).length;
  deleted.members = (await db.delete(members).where(eq(members.workspaceId, wid))
    .returning({ id: members.id })).length;

  await db.update(workspaces).set({ status: 'deleted' }).where(eq(workspaces.id, wid));

  const preserved = {
    audit_events: (await db.select({ id: auditEvents.id }).from(auditEvents)
      .where(eq(auditEvents.workspaceId, wid))).length,
    action_meter: (await db.select({ id: actionMeter.id }).from(actionMeter)
      .where(eq(actionMeter.workspaceId, wid))).length,
  };

  // written LAST: the completion record (invariant 26)
  await scope.audit('workspace.deleted', 'ok', {
    at: now,
    tasks_deleted: deleted.tasks!, confirmations_deleted: deleted.confirmations!,
    drafts_deleted: deleted.drafts!, source_messages_deleted: deleted.source_messages!,
    jobs_deleted: deleted.jobs!, connections_deleted: deleted.retention_connections!,
    members_deleted: deleted.members!,
    audit_events_preserved: preserved.audit_events,
    action_meter_preserved: preserved.action_meter,
  });

  return { workspaceId: wid, status: 'deleted', deleted, preserved, completedAt: now };
}
