// The only cross-tenant path: the queue poller. Reads identifiers, never content.
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { dialect, affectedRows } from './client';
import { jobs, workspaces, sourceConnections, members, memberCredentials, oauthProviders } from './schema';

export type JobRow = typeof jobs.$inferSelect;

/** Every column the claim returns, in the order the mapper below reads them. */
const CLAIM_COLUMNS = sql`workspace_id, id, queue, status, payload, run_at, attempts, claimed_at, created_at`;

function toJobRow(r: any): JobRow | null {
  if (!r) return null;
  return {
    workspaceId: r.workspace_id, id: r.id, queue: r.queue, status: r.status,
    payload: r.payload, runAt: Number(r.run_at), attempts: Number(r.attempts),
    claimedAt: r.claimed_at == null ? null : Number(r.claimed_at),
    createdAt: Number(r.created_at),
  } as JobRow;
}

/**
 * Claim exactly one job, atomically. A read-then-update loses the race: two workers
 * both see the same queued row and both run it, which for the tracker queue means two
 * tasks for one confirmation. A single UPDATE ... RETURNING cannot be interleaved.
 *
 * PORTABILITY. The original selected the row by `rowid`, which exists only in
 * SQLite. The row is now identified by its real composite primary key
 * (workspace_id, id) through a row-value IN subquery, which SQLite (>= 3.15) and
 * Postgres both understand. On Postgres the inner SELECT additionally takes
 * FOR UPDATE SKIP LOCKED, which is how Postgres gets the same "no two workers
 * claim the same row" guarantee that SQLite gets for free from its single-writer
 * lock: without it, two concurrent claims block on each other and the second one
 * then updates zero rows.
 */
function claimQuery(queues: string[], now: number) {
  const list = sql.join(queues.map((q) => sql`${q}`), sql`, `);
  const skipLocked = dialect() === 'pg' ? sql` FOR UPDATE SKIP LOCKED` : sql``;
  return sql`
    UPDATE jobs SET status = 'running', attempts = attempts + 1, claimed_at = ${now}
    WHERE (workspace_id, id) IN (
      SELECT workspace_id, id FROM jobs
      WHERE status = 'queued' AND run_at <= ${now} AND queue IN (${list})
      ORDER BY run_at LIMIT 1${skipLocked}
    )
    RETURNING ${CLAIM_COLUMNS}
  `;
}

function staleQuery(cutoff: number) {
  const skipLocked = dialect() === 'pg' ? sql` FOR UPDATE SKIP LOCKED` : sql``;
  return dialect() === 'pg'
    ? sql`
      UPDATE jobs SET status = 'queued'
      WHERE (workspace_id, id) IN (
        SELECT workspace_id, id FROM jobs
        WHERE status = 'running' AND (claimed_at IS NULL OR claimed_at <= ${cutoff})${skipLocked}
      )
      RETURNING id`
    : sql`
      UPDATE jobs SET status = 'queued'
      WHERE status = 'running' AND (claimed_at IS NULL OR claimed_at <= ${cutoff})
      RETURNING id`;
}

/**
 * The synchronous API is better-sqlite3-only: .all()/.run() do not exist on the
 * node-postgres driver, whose query builders are promises. Rather than return a
 * silently-unawaited promise (a job claimed by nobody, a retry that never lands),
 * the SQLite-only entry points say so precisely and name their replacement.
 */
function assertSqliteSync(fn: string): void {
  if (dialect() === 'pg') {
    throw new Error(
      `${fn}() is synchronous and works on SQLite only; on Postgres call ${fn}Async(). ` +
      `src/worker.ts calls the synchronous form and must be switched over before ` +
      `DATABASE_URL may point at Postgres.`,
    );
  }
}

export function claimNextJob(db: Db, queues: string[]): JobRow | null {
  assertSqliteSync('claimNextJob');
  const rows = db.all(claimQuery(queues, Date.now())) as any[];
  return toJobRow(rows[0]);
}

/** The same claim, on either dialect. */
export async function claimNextJobAsync(db: Db, queues: string[]): Promise<JobRow | null> {
  const q = claimQuery(queues, Date.now());
  const rows = dialect() === 'pg' ? (await (db as any).execute(q)).rows : db.all(q);
  return toJobRow((rows as any[])[0]);
}

/**
 * A claim is fenced by the timestamp written by claimQuery(). A reaper may return
 * a dead worker's job to the queue and a successor may claim it before the old
 * worker's promise settles. The old holder must then affect zero rows: otherwise
 * it can mark the successor's work done or schedule its retry. `claimed_at` is
 * the portable per-claim token available on both SQLite and Postgres.
 */
function claimedJob(job: JobRow) {
  if (job.claimedAt == null) throw new Error('refusing to transition a job without a claim fence');
  return and(
    eq(jobs.workspaceId, job.workspaceId), eq(jobs.id, job.id),
    eq(jobs.status, 'running'), eq(jobs.claimedAt, job.claimedAt),
  );
}

export function finishJob(db: Db, job: JobRow, status: 'done' | 'failed' | 'dead_letter' = 'done'): boolean {
  assertSqliteSync('finishJob');
  return affectedRows(db.update(jobs).set({ status }).where(claimedJob(job)).run()) === 1;
}

export async function finishJobAsync(db: Db, job: JobRow, status: 'done' | 'failed' | 'dead_letter' = 'done'): Promise<boolean> {
  const q = db.update(jobs).set({ status }).where(claimedJob(job));
  const result = dialect() === 'pg' ? await (q as any) : q.run();
  return affectedRows(result) === 1;
}

/** Bounded retry with backoff; dead-letter after maxAttempts. */
export function retryJob(db: Db, job: JobRow, maxAttempts = 5): boolean {
  assertSqliteSync('retryJob');
  if (job.attempts >= maxAttempts) return finishJob(db, job, 'dead_letter');
  return affectedRows(db.update(jobs).set({ status: 'queued', runAt: Date.now() + backoffMs(job) })
    .where(claimedJob(job)).run()) === 1;
}

export async function retryJobAsync(db: Db, job: JobRow, maxAttempts = 5): Promise<boolean> {
  if (job.attempts >= maxAttempts) return finishJobAsync(db, job, 'dead_letter');
  const q = db.update(jobs).set({ status: 'queued', runAt: Date.now() + backoffMs(job) })
    .where(claimedJob(job));
  const result = dialect() === 'pg' ? await (q as any) : q.run();
  return affectedRows(result) === 1;
}

function backoffMs(job: JobRow): number {
  return Math.min(30_000, 500 * 2 ** job.attempts);
}

export function listWorkspaces(db: Db) {
  assertSqliteSync('listWorkspaces');
  return db.select().from(workspaces).all();
}

export async function listWorkspacesAsync(db: Db) {
  const q = db.select().from(workspaces);
  return dialect() === 'pg' ? await (q as any) : q.all();
}

/**
 * M4: a job claimed by a worker that then died stayed `running` for ever, and the
 * confirmed write behind it never happened. Anything running longer than the lease
 * is assumed orphaned and returned to the queue, where the ordinary bounded retry
 * and dead-letter rules apply. Returning it is safe because every handler is
 * idempotent: the tracker write is conditional on its own state.
 */
export function reapStaleJobs(db: Db, leaseMs = leaseDefault(), now = Date.now()): number {
  assertSqliteSync('reapStaleJobs');
  const rows = db.all(staleQuery(now - leaseMs)) as any[];
  return reportReaped(rows.length);
}

export async function reapStaleJobsAsync(db: Db, leaseMs = leaseDefault(), now = Date.now()): Promise<number> {
  const q = staleQuery(now - leaseMs);
  const rows = dialect() === 'pg' ? (await (db as any).execute(q)).rows : db.all(q);
  return reportReaped((rows as any[]).length);
}

function leaseDefault() {
  const raw = process.env.SEROS_JOB_LEASE_MS;
  if (raw === undefined || raw === '') return 120_000;
  const leaseMs = Number(raw);
  if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > 24 * 60 * 60 * 1000) {
    throw new Error('SEROS_JOB_LEASE_MS must be a finite duration between 1ms and 24h');
  }
  return leaseMs;
}

function reportReaped(count: number): number {
  if (count) console.log(JSON.stringify({ level: 'warn', event: 'jobs.reaped', count }));
  return count;
}

/**
 * The tenant behind a Slack team id.
 *
 * This is the second cross-tenant read, and it belongs here for the same reason
 * the queue poller does: an inbound Slack event arrives with a team id and no
 * session, so something has to map that identifier to a workspace before a
 * WorkspaceScope can exist. It reads identifiers only - no channel, no author,
 * no message text - and it returns nothing for a revoked connection, so
 * disconnecting actually stops ingestion.
 */
export async function workspaceIdForSlackTeam(db: Db, teamId: string): Promise<string | null> {
  if (!teamId) return null;
  const rows = await db.select({ workspaceId: sourceConnections.workspaceId, revokedAt: sourceConnections.revokedAt })
    .from(sourceConnections)
    .where(and(eq(sourceConnections.provider, 'slack'), eq(sourceConnections.teamId, teamId)))
    .limit(1);
  const row = (rows as any[])[0];
  if (!row || row.revokedAt) return null;
  return row.workspaceId as string;
}


/**
 * Resolve a sign-in identity before a WorkspaceScope exists. This is deliberately
 * the only account-discovery path across tenants: it returns opaque identifiers,
 * never a roster or profile, and callers must still open the returned scope and
 * verify the credential or OAuth provider proof.
 */
export async function accountForEmail(db: Db, email: string): Promise<{ workspaceId: string; memberId: string } | null> {
  const rows = await db.select({ workspaceId: memberCredentials.workspaceId, memberId: memberCredentials.memberId })
    .from(memberCredentials)
    .innerJoin(members, and(eq(members.workspaceId, memberCredentials.workspaceId), eq(members.id, memberCredentials.memberId)))
    .where(and(eq(memberCredentials.email, email), eq(members.status, 'active')))
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

export async function accountForOAuth(db: Db, provider: 'google' | 'github', providerUserId: string): Promise<{ workspaceId: string; memberId: string } | null> {
  const rows = await db.select({ workspaceId: oauthProviders.workspaceId, memberId: oauthProviders.memberId })
    .from(oauthProviders)
    .innerJoin(members, and(eq(members.workspaceId, oauthProviders.workspaceId), eq(members.id, oauthProviders.memberId)))
    .where(and(eq(oauthProviders.provider, provider), eq(oauthProviders.providerUserId, providerUserId), eq(members.status, 'active')))
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}
