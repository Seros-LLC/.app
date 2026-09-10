/**
 * tests/pg-affected-rows.test.ts — does a conditional write report its row count
 * correctly on Postgres?
 *
 * `affectedRows()` reads `changes` (better-sqlite3) or `rowCount`
 * (node-postgres). Drizzle's postgres-js driver reports neither: an UPDATE
 * without RETURNING comes back as a postgres-js Result carrying `count`.
 *
 * Every caller uses this number as the verdict of a conditional write — "did I
 * win this claim?", "did I finish the job I still hold?" — so a wrong answer is
 * not a wrong log line. It silently converts success into failure across the
 * queue and the confirmation claim, on the only dialect production uses.
 *
 * Skipped unless SEROS_PG_TEST_URL is set; see tests/pg-dialect.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const PG_URL = process.env.SEROS_PG_TEST_URL;
const skip = PG_URL ? false : 'SEROS_PG_TEST_URL is not set (no disposable Postgres available)';

process.env.SEROS_SESSION_SECRET = 'test-session-secret-pg-affected-123456';
process.env.SEROS_SIGNING_SECRET = 'test-signing-secret-pg-affected-123456';
process.env.SEROS_RESET_SECRET = 'test-reset-secret-pg-affected-123456';
process.env.SEROS_PROVIDER = 'fake';
process.env.SEROS_TRACKER = 'fake';
if (PG_URL) process.env.DATABASE_URL = PG_URL;

import { migrateDbAsync, openDb, closeDb } from '../src/db/client';
import { claimNextJobAsync, finishJobAsync, retryJobAsync } from '../src/db/system';
import { WorkspaceScope } from '../src/db/scope';

let ready: Promise<void> | null = null;
const withDb = async () => {
  ready ??= migrateDbAsync().then(() => undefined);
  await ready;
  return openDb();
};
const uniq = (label: string) => `${label}-${crypto.randomBytes(6).toString('hex')}`;

/** A workspace with exactly one queued job, claimed and ready to be finished. */
async function claimedJob(db: any, queue: string) {
  const scope = await WorkspaceScope.ensure(db, uniq('ws'));
  await scope.enqueue(queue, { probe: true });
  const job = await claimNextJobAsync(db, [queue]);
  assert.ok(job, 'setup: the job must be claimable');
  return job!;
}

test('a claimed job comes back with its identifying fields intact, on Postgres', { skip }, async () => {
  const db = await withDb();
  const queue = uniq('fields');
  const scope = await WorkspaceScope.ensure(db, uniq('ws'));
  await scope.enqueue(queue, { probe: true });

  const job = await claimNextJobAsync(db, [queue]);
  assert.ok(job, 'setup: the job must be claimable');

  // postgres-js is opened with `transform: postgres.camel`, so a raw RETURNING
  // yields camelCase keys. Reading snake_case off that row silently produces
  // undefined, and a claim with no claimedAt cannot be fenced, finished, or
  // retried — the job stays `running` for ever.
  assert.equal(typeof job!.workspaceId, 'string', 'the claim must carry its workspace');
  assert.equal(typeof job!.claimedAt, 'number', 'the claim fence must survive the round trip');
  assert.equal(typeof job!.createdAt, 'number', 'createdAt must survive the round trip');
  assert.equal(typeof job!.runAt, 'number', 'runAt must survive the round trip');
  assert.equal(job!.queue, queue);
});

test('finishing a job the worker holds reports success, on Postgres', { skip }, async () => {
  const db = await withDb();
  const job = await claimedJob(db, uniq('finish'));

  assert.equal(await finishJobAsync(db, job, 'done'), true,
    'a worker that finishes the job it holds must be told the write landed');
});

test('a job cannot be finished twice, on Postgres', { skip }, async () => {
  const db = await withDb();
  const job = await claimedJob(db, uniq('twice'));

  assert.equal(await finishJobAsync(db, job, 'done'), true);
  assert.equal(await finishJobAsync(db, job, 'done'), false,
    'the fencing claim must refuse a second finish for the same lease');
});

test('retrying a job the worker holds reports success, on Postgres', { skip }, async () => {
  const db = await withDb();
  const job = await claimedJob(db, uniq('retry'));

  assert.equal(await retryJobAsync(db, job), true,
    'a failed attempt must be requeued, or the job is lost');
});

test.after(async () => { await closeDb(); });
