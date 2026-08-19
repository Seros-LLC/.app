// The only cross-tenant path: the queue poller. Reads identifiers, never content.
import { and, eq, sql } from 'drizzle-orm';
import type { openDb } from './client';
import { jobs, workspaces } from './schema';

type Db = ReturnType<typeof openDb>;
export type JobRow = typeof jobs.$inferSelect;

/**
 * Claim exactly one job, atomically. A read-then-update loses the race: two workers
 * both see the same queued row and both run it, which for the tracker queue means two
 * tasks for one confirmation. A single UPDATE ... RETURNING cannot be interleaved.
 */
export function claimNextJob(db: Db, queues: string[]): JobRow | null {
  const list = sql.join(queues.map((q) => sql`${q}`), sql`, `);
  const rows = db.all(sql`
    UPDATE jobs SET status = 'running', attempts = attempts + 1
    WHERE rowid = (
      SELECT rowid FROM jobs
      WHERE status = 'queued' AND run_at <= ${Date.now()} AND queue IN (${list})
      ORDER BY run_at LIMIT 1
    )
    RETURNING workspace_id, id, queue, status, payload, run_at, attempts, created_at
  `) as any[];
  const r = rows[0];
  if (!r) return null;
  return {
    workspaceId: r.workspace_id, id: r.id, queue: r.queue, status: r.status,
    payload: r.payload, runAt: r.run_at, attempts: r.attempts, createdAt: r.created_at,
  } as JobRow;
}

export function finishJob(db: Db, job: JobRow, status: 'done' | 'failed' | 'dead_letter' = 'done') {
  db.update(jobs).set({ status })
    .where(and(eq(jobs.workspaceId, job.workspaceId), eq(jobs.id, job.id))).run();
}

/** Bounded retry with backoff; dead-letter after maxAttempts. */
export function retryJob(db: Db, job: JobRow, maxAttempts = 5) {
  if (job.attempts >= maxAttempts) return finishJob(db, job, 'dead_letter');
  const backoff = Math.min(30_000, 500 * 2 ** job.attempts);
  db.update(jobs).set({ status: 'queued', runAt: Date.now() + backoff })
    .where(and(eq(jobs.workspaceId, job.workspaceId), eq(jobs.id, job.id))).run();
}

export function listWorkspaces(db: Db) {
  return db.select().from(workspaces).all();
}


/**
 * M4: a job claimed by a worker that then died stayed `running` for ever, and the
 * confirmed write behind it never happened. Anything running longer than the lease
 * is assumed orphaned and returned to the queue, where the ordinary bounded retry
 * and dead-letter rules apply. Returning it is safe because every handler is
 * idempotent: the tracker write is conditional on its own state.
 */
export function reapStaleJobs(db: Db, leaseMs = Number(process.env.SEROS_JOB_LEASE_MS || 120_000), now = Date.now()): number {
  const rows = db.all(sql`
    UPDATE jobs SET status = 'queued'
    WHERE status = 'running' AND run_at <= ${now - leaseMs}
    RETURNING id
  `) as any[];
  if (rows.length) {
    console.log(JSON.stringify({ level: 'warn', event: 'jobs.reaped', count: rows.length }));
  }
  return rows.length;
}
