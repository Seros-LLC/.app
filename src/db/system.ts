// The only cross-tenant path: the queue poller. Reads identifiers, never content.
import { and, eq, lte, inArray } from 'drizzle-orm';
import type { openDb } from './client';
import { jobs, workspaces } from './schema';

type Db = ReturnType<typeof openDb>;
export type JobRow = typeof jobs.$inferSelect;

export function claimNextJob(db: Db, queues: string[]): JobRow | null {
  const job = db.select().from(jobs).where(and(
    eq(jobs.status, 'queued'), lte(jobs.runAt, Date.now()), inArray(jobs.queue, queues),
  )).orderBy(jobs.runAt).limit(1).get();
  if (!job) return null;
  db.update(jobs).set({ status: 'running', attempts: job.attempts + 1 })
    .where(and(eq(jobs.workspaceId, job.workspaceId), eq(jobs.id, job.id))).run();
  return { ...job, status: 'running', attempts: job.attempts + 1 };
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
