
/**
 * src/limits.ts — draft expiry (M7) and growth limits (M3).
 *
 * Implements IMPLEMENTATION-BRIEF §1.5 (the Draft state machine: only `pending` may
 * transition; `expired` is terminal), invariant 10 ("degrade toward doing nothing,
 * never toward acting without a human") and invariant 24's alerting shape.
 *
 * DESIGN NOTES / DELIBERATE LOCAL DEFINITIONS
 * -------------------------------------------
 * (a) Everything here goes through a `WorkspaceScope` (src/db/scope.ts): the scope is
 *     opened first — which refuses to exist for an unknown workspace — and its
 *     `workspaceId` is injected into every single WHERE clause below. Invariant 20.
 *     These helpers would normally live on WorkspaceScope, but scope.ts is owned by
 *     another agent right now, so they are defined locally instead (same choice, and
 *     the same reason, as src/retention.ts).
 *
 * (b) Brief §1.5 makes `Draft.expires_at` a required column; src/db/schema.ts has the
 *     `expired` enum value but no such column (finding M7), and schema.ts is not ours
 *     to edit. Expiry is therefore computed from `created_at + TTL`, with the TTL read
 *     from `SEROS_DRAFT_TTL_DAYS` (default 14 days). If and when an `expires_at` column
 *     appears on `drafts`, this file picks it up automatically — see
 *     `draftsHaveExpiresAt()` — and uses `COALESCE(expires_at, created_at + ttl)`, so
 *     a per-draft deadline wins and drafts written before the column existed still
 *     expire. Nothing here needs to change when the column lands.
 *
 * (c) Expiry is a STATE TRANSITION AND NOTHING ELSE. It updates `pending` -> `expired`
 *     and never touches `confirmations` or `tasks`: there is no insert into either
 *     table anywhere in this file, so an expiring draft cannot manufacture a write
 *     (ADR 0002, invariants 1-3). `WorkspaceScope.confirm()` already refuses any draft
 *     whose state is not `pending`, so an expired draft is unconfirmable by
 *     construction as well.
 *
 * (d) A cap that is hit REFUSES NEW WORK LOUDLY. It never drops, trims, or silently
 *     discards a row: the checking functions return a structured refusal, write an
 *     audit row with outcome `denied`, and leave the HTTP status to the caller
 *     (a suggested one is carried on the refusal).
 *
 * Nothing in this file ever writes customer content anywhere: audit details carry
 * counts, ids, limits and timestamps only (invariants 12/14).
 */

import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { openDb } from './db/client';
import { WorkspaceScope } from './db/scope';
import { drafts, jobs, workspaces } from './db/schema';
import { DAY_MS } from './retention';

type Db = ReturnType<typeof openDb>;

export { DAY_MS };

/** Brief §6 Q14 leaves `Draft.expires_at` duration open; 14 days is the decision. */
export const DEFAULT_DRAFT_TTL_DAYS = 14;
/** M3: queue depth per workspace. `queued` rows only — work not yet started. */
export const DEFAULT_MAX_QUEUED_JOBS = 10_000;
/** M3: unconfirmed drafts per workspace. */
export const DEFAULT_MAX_PENDING_DRAFTS = 5_000;

/** At most this many ids go into one audit row; the count is always exact. */
export const AUDIT_ID_SAMPLE = 50;

export type LimitKind = 'queued_jobs' | 'pending_drafts';
export const LIMIT_KINDS = ['queued_jobs', 'pending_drafts'] as const;

export interface LimitOptions {
  /** Injectable clock so TTL windows are testable without waiting 14 days. */
  now?: number;
  /** Overrides for the env-configured caps/TTL (tests, and per-plan overrides later). */
  maxQueuedJobs?: number;
  maxPendingDrafts?: number;
  ttlDays?: number;
  /** Which caps `enforceLimits` checks. Default: all of them, in LIMIT_KINDS order. */
  kinds?: readonly LimitKind[];
  /** Set false to check without writing the `denied` audit row (dashboards). */
  audit?: boolean;
}

// ---------------------------------------------------------------------------
// configuration — a bad value is a loud error, never a silently removed limit
// ---------------------------------------------------------------------------

/**
 * M13's lesson, applied here: `Number('ten') = NaN` and every comparison against NaN
 * is false, which would silently delete the cap. A malformed limit is a crash at
 * configuration time instead.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function draftTtlDays(opts: LimitOptions = {}): number {
  return opts.ttlDays ?? positiveIntFromEnv('SEROS_DRAFT_TTL_DAYS', DEFAULT_DRAFT_TTL_DAYS);
}
export function maxQueuedJobs(opts: LimitOptions = {}): number {
  return opts.maxQueuedJobs ?? positiveIntFromEnv('SEROS_MAX_QUEUED_JOBS', DEFAULT_MAX_QUEUED_JOBS);
}
export function maxPendingDrafts(opts: LimitOptions = {}): number {
  return opts.maxPendingDrafts ?? positiveIntFromEnv('SEROS_MAX_PENDING_DRAFTS', DEFAULT_MAX_PENDING_DRAFTS);
}

// ---------------------------------------------------------------------------
// counting (per workspace, always scoped — invariant 20/22)
// ---------------------------------------------------------------------------

function countRows(db: Db, where: ReturnType<typeof and>, table: typeof jobs | typeof drafts): number {
  const row = table === jobs
    ? db.select({ n: sql<number>`count(*)` }).from(jobs).where(where).get()
    : db.select({ n: sql<number>`count(*)` }).from(drafts).where(where).get();
  return Number(row?.n ?? 0);
}

export function queuedJobCount(db: Db, workspaceId: string): number {
  const scope = WorkspaceScope.open(db, workspaceId);
  return countRows(db, and(
    eq(jobs.workspaceId, scope.workspaceId),
    eq(jobs.status, 'queued'),
  ), jobs);
}

export function pendingDraftCount(db: Db, workspaceId: string): number {
  const scope = WorkspaceScope.open(db, workspaceId);
  return countRows(db, and(
    eq(drafts.workspaceId, scope.workspaceId),
    eq(drafts.state, 'pending'),
  ), drafts);
}

export interface LimitCounts {
  workspaceId: string;
  at: number;
  counts: Record<LimitKind, number>;
  limits: Record<LimitKind, number>;
  /** Fraction of each cap already used, 0-1+ — the number to graph and alert on. */
  usage: Record<LimitKind, number>;
  /** Caps already at or past their limit right now. Empty is the healthy answer. */
  exceeded: LimitKind[];
}

/**
 * Report the caps before they bite. Read-only: it writes nothing, audits nothing, and
 * is safe to call from a dashboard or a health check on any schedule.
 */
export function workspaceLimitCounts(db: Db, workspaceId: string, opts: LimitOptions = {}): LimitCounts {
  const scope = WorkspaceScope.open(db, workspaceId);
  const now = opts.now ?? Date.now();
  const counts: Record<LimitKind, number> = {
    queued_jobs: queuedJobCount(db, scope.workspaceId),
    pending_drafts: pendingDraftCount(db, scope.workspaceId),
  };
  const limits: Record<LimitKind, number> = {
    queued_jobs: maxQueuedJobs(opts),
    pending_drafts: maxPendingDrafts(opts),
  };
  const usage: Record<LimitKind, number> = {
    queued_jobs: counts.queued_jobs / limits.queued_jobs,
    pending_drafts: counts.pending_drafts / limits.pending_drafts,
  };
  const exceeded = LIMIT_KINDS.filter((k) => counts[k] >= limits[k]);
  return { workspaceId: scope.workspaceId, at: now, counts, limits, usage, exceeded };
}

/** Every workspace, one row each. The only cross-tenant path here: counts, never content. */
export function allWorkspaceLimitCounts(db: Db, opts: LimitOptions = {}): LimitCounts[] {
  return db.select({ id: workspaces.id }).from(workspaces).all()
    .map((r) => workspaceLimitCounts(db, r.id, opts));
}

// ---------------------------------------------------------------------------
// M3 — growth limits: refuse new work loudly
// ---------------------------------------------------------------------------

export interface LimitAllowed {
  ok: true;
  workspaceId: string;
  kind: LimitKind | null;
  count: number;
  limit: number;
  at: number;
}

export interface LimitRefused {
  ok: false;
  workspaceId: string;
  /** Which cap refused. */
  kind: LimitKind;
  /** Stable machine-readable reason for the caller and for the audit row. */
  reason: 'queued_jobs_limit' | 'pending_drafts_limit';
  count: number;
  limit: number;
  /** Suggested HTTP status. The CALLER decides what to send; this is advice. */
  suggestedStatus: 429;
  /** True: the customer can retry once the queue drains or drafts are confirmed. */
  retryable: true;
  /** Human-readable, content-free. Safe to log and safe to return to a client. */
  message: string;
  at: number;
}

export type LimitDecision = LimitAllowed | LimitRefused;

const REASON: Record<LimitKind, LimitRefused['reason']> = {
  queued_jobs: 'queued_jobs_limit',
  pending_drafts: 'pending_drafts_limit',
};

function refuse(scope: WorkspaceScope, kind: LimitKind, count: number, limit: number,
                now: number, shouldAudit: boolean): LimitRefused {
  if (shouldAudit) {
    // outcome `denied`: the request was refused, on purpose, and we say so. Counts only.
    scope.audit('limit.refused', 'denied', {
      limit_kind: kind, reason: REASON[kind], count, limit, at: now,
    });
  }
  return {
    ok: false, workspaceId: scope.workspaceId, kind, reason: REASON[kind], count, limit,
    suggestedStatus: 429, retryable: true,
    message: `workspace ${scope.workspaceId} is at its ${kind} limit (${count}/${limit}); new work refused`,
    at: now,
  };
}

/** M3: refuse to queue more work once the queue is at its cap. Never drops a row. */
export function checkQueuedJobs(db: Db, workspaceId: string, opts: LimitOptions = {}): LimitDecision {
  const scope = WorkspaceScope.open(db, workspaceId);
  const now = opts.now ?? Date.now();
  const limit = maxQueuedJobs(opts);
  const count = queuedJobCount(db, scope.workspaceId);
  if (count >= limit) return refuse(scope, 'queued_jobs', count, limit, now, opts.audit !== false);
  return { ok: true, workspaceId: scope.workspaceId, kind: 'queued_jobs', count, limit, at: now };
}

/** M3: refuse to create more drafts once the confirm queue is at its cap. */
export function checkPendingDrafts(db: Db, workspaceId: string, opts: LimitOptions = {}): LimitDecision {
  const scope = WorkspaceScope.open(db, workspaceId);
  const now = opts.now ?? Date.now();
  const limit = maxPendingDrafts(opts);
  const count = pendingDraftCount(db, scope.workspaceId);
  if (count >= limit) return refuse(scope, 'pending_drafts', count, limit, now, opts.audit !== false);
  return { ok: true, workspaceId: scope.workspaceId, kind: 'pending_drafts', count, limit, at: now };
}

const CHECKS: Record<LimitKind, (db: Db, workspaceId: string, opts: LimitOptions) => LimitDecision> = {
  queued_jobs: checkQueuedJobs,
  pending_drafts: checkPendingDrafts,
};

/**
 * THE ENTRY POINT. Call before accepting new work for a workspace:
 *
 *   const decision = enforceLimits(db, workspaceId);
 *   if (!decision.ok) return res.status(decision.suggestedStatus).json({ ok: false, error: decision.reason });
 *
 * Returns the FIRST refusal (queue depth first, then draft backlog), or an allowance.
 * Refusals are audited with outcome `denied`; allowances write nothing.
 */
export function enforceLimits(db: Db, workspaceId: string, opts: LimitOptions = {}): LimitDecision {
  const scope = WorkspaceScope.open(db, workspaceId);
  const now = opts.now ?? Date.now();
  const kinds = opts.kinds ?? LIMIT_KINDS;
  let last: LimitDecision = { ok: true, workspaceId: scope.workspaceId, kind: null, count: 0, limit: 0, at: now };
  for (const kind of kinds) {
    const decision = CHECKS[kind](db, scope.workspaceId, { ...opts, now });
    if (!decision.ok) return decision;
    last = decision;
  }
  return last;
}

// ---------------------------------------------------------------------------
// M7 — draft expiry
// ---------------------------------------------------------------------------

type ColumnInfo = { name: string };

/** See note (b): true once someone adds the column the brief asks for. */
export function draftsHaveExpiresAt(db: Db): boolean {
  const cols = db.all(sql`PRAGMA table_info(drafts)`) as unknown as ColumnInfo[];
  return cols.some((c) => c.name === 'expires_at');
}

export interface ExpiryResult {
  workspaceId: string;
  ttlDays: number;
  /** Drafts created at or before this instant are past their window. */
  cutoffAt: number;
  expiredAt: number;
  /** COUNTS ONLY. */
  counts: { drafts_expired: number; pending_remaining: number };
  /** Ids of the drafts this call moved to `expired`. Ids are metadata, not content. */
  draftIds: string[];
  /** Always 0, and asserted: expiry may never create a write (ADR 0002). */
  confirmationsCreated: 0;
  tasksCreated: 0;
}

/**
 * M7: a `pending` draft nobody confirmed inside the window becomes `expired`.
 *
 * `pending` -> `expired` only (brief §1.5: only `pending` may transition, and all four
 * other states are terminal), so a confirmed, rejected or superseded draft is never
 * touched and an expired draft can never become confirmed. No Confirmation and no Task
 * is created — this function contains no insert into either table.
 *
 * Idempotent: the second run finds nothing pending past the cutoff, changes no rows,
 * and writes no audit row.
 */
export function expireDrafts(db: Db, workspaceId: string, opts: LimitOptions = {}): ExpiryResult {
  const scope = WorkspaceScope.open(db, workspaceId);   // throws UnknownWorkspace
  const now = opts.now ?? Date.now();
  const ttlDays = draftTtlDays(opts);
  const ttlMs = ttlDays * DAY_MS;
  const cutoffAt = now - ttlMs;

  // A per-draft `expires_at` wins where it exists; otherwise created_at + TTL. Note (b).
  const pastWindow = draftsHaveExpiresAt(db)
    ? sql`COALESCE(${sql.raw('expires_at')}, ${drafts.createdAt} + ${ttlMs}) <= ${now}`
    : lte(drafts.createdAt, cutoffAt);

  const expired = db.update(drafts).set({ state: 'expired' })
    .where(and(
      eq(drafts.workspaceId, scope.workspaceId),   // tenancy: always scoped
      eq(drafts.state, 'pending'),                 // idempotency + §1.5 transition rule
      pastWindow,
    ))
    .returning({ id: drafts.id })
    .all()
    .map((r) => r.id);

  const pendingRemaining = pendingDraftCount(db, scope.workspaceId);

  if (expired.length > 0) {
    const sample = expired.slice(0, AUDIT_ID_SAMPLE);
    // Counts and ids only. Never a title, an outcome, an owner or a due date.
    scope.audit('draft.expired', 'ok', {
      ttl_days: ttlDays,
      cutoff_at: cutoffAt,
      expired_at: now,
      drafts_expired: expired.length,
      pending_remaining: pendingRemaining,
      confirmations_created: 0,     // explicit so a regression is loud, not silent
      tasks_created: 0,
      draft_ids: sample.join(','),
      draft_ids_omitted: expired.length - sample.length,
    });
  }

  return {
    workspaceId: scope.workspaceId, ttlDays, cutoffAt, expiredAt: now,
    counts: { drafts_expired: expired.length, pending_remaining: pendingRemaining },
    draftIds: expired, confirmationsCreated: 0, tasksCreated: 0,
  };
}

/** The scheduled job: every workspace, one pass. */
export function expireDraftsAllWorkspaces(db: Db, opts: LimitOptions = {}): ExpiryResult[] {
  const ids = db.select({ id: workspaces.id }).from(workspaces).all().map((r) => r.id);
  return ids.map((id) => expireDrafts(db, id, opts));
}

/**
 * Convenience for the maintenance loop: expire first (which frees pending-draft
 * headroom), then report where every workspace stands against its caps.
 */
export function runMaintenance(db: Db, opts: LimitOptions = {}): {
  expired: ExpiryResult[];
  counts: LimitCounts[];
} {
  const expired = expireDraftsAllWorkspaces(db, opts);
  return { expired, counts: allWorkspaceLimitCounts(db, opts) };
}

/** Jobs already queued for a workspace, ids only — used by the CLI and by tests. */
export function queuedJobIds(db: Db, workspaceId: string, statuses: readonly ('queued' | 'running')[] = ['queued']): string[] {
  const scope = WorkspaceScope.open(db, workspaceId);
  return db.select({ id: jobs.id }).from(jobs)
    .where(and(eq(jobs.workspaceId, scope.workspaceId), inArray(jobs.status, [...statuses])))
    .all().map((r) => r.id);
}
