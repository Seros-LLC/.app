/**
 * tests/pg-dialect.test.ts — the Postgres lane.
 *
 * The rest of the suite runs on SQLite, where every raw query goes through
 * `db.all()`. Production runs on Postgres, where the same code takes the
 * `(db as any).execute(...)` branch — a branch no test ever executed. That gap
 * let four call sites ship a result shape that does not exist on postgres-js:
 * drizzle's postgres-js driver returns the Result array itself, NOT a
 * node-postgres `{ rows }` object, so `.rows` is `undefined` and the next
 * property access throws.
 *
 * These tests exercise the REAL exported functions against a REAL Postgres.
 * They are skipped unless SEROS_PG_TEST_URL points at a disposable database:
 *
 *   podman run -d --rm --name seros-pgtest -e POSTGRES_PASSWORD=serostest \
 *     -e POSTGRES_DB=seros_test -p 55433:5432 docker.io/library/postgres:16-alpine
 *   export SEROS_PG_TEST_URL=postgresql://postgres:serostest@127.0.0.1:55433/seros_test
 *
 * Skipping when unset keeps `npm test` runnable with no container, but CI and
 * `npm run verify:pg` must set it: a green SQLite suite is not evidence that
 * production works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const PG_URL = process.env.SEROS_PG_TEST_URL;
const skip = PG_URL ? false : 'SEROS_PG_TEST_URL is not set (no disposable Postgres available)';

process.env.SEROS_SESSION_SECRET = 'test-session-secret-pg-dialect-123456';
process.env.SEROS_SIGNING_SECRET = 'test-signing-secret-pg-dialect-123456';
process.env.SEROS_RESET_SECRET = 'test-reset-secret-pg-dialect-123456';
process.env.SEROS_PROVIDER = 'fake';
process.env.SEROS_TRACKER = 'fake';
if (PG_URL) process.env.DATABASE_URL = PG_URL;

import { migrateDbAsync, openDb, closeDb, dialect } from '../src/db/client';
import { admitRateLimit } from '../src/security-controls';
import { issueCaptcha, consumeCaptcha } from '../src/captcha';
import { claimNextJobAsync, reapStaleJobsAsync } from '../src/db/system';
import { WorkspaceScope } from '../src/db/scope';

let ready: Promise<void> | null = null;
/** One migration for the whole file; every test then works on unique keys. */
const withDb = async () => {
  ready ??= migrateDbAsync().then(() => undefined);
  await ready;
  return openDb();
};

/** Unique per test, so tests never collide in a shared database. */
const uniq = (label: string) => `${label}-${crypto.randomBytes(6).toString('hex')}`;

test('the driver actually selects Postgres for this lane', { skip }, async () => {
  await withDb();
  assert.equal(dialect(), 'pg', 'this file must exercise the pg branch, not SQLite');
});

test('the rate limiter admits up to the maximum and then blocks, on Postgres', { skip }, async () => {
  const db = await withDb();
  const bucket = uniq('probe');
  const subject = '203.0.113.9';

  const verdicts: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    verdicts.push((await admitRateLimit(db, bucket, subject, 3, 60_000)).admitted);
  }

  assert.deepEqual(verdicts, [true, true, true, false, false],
    'a max of 3 must admit exactly 3 and then refuse');
});

test('the rate limiter counts each subject separately, on Postgres', { skip }, async () => {
  const db = await withDb();
  const bucket = uniq('per-subject');

  assert.equal((await admitRateLimit(db, bucket, '198.51.100.1', 1, 60_000)).admitted, true);
  assert.equal((await admitRateLimit(db, bucket, '198.51.100.1', 1, 60_000)).admitted, false,
    'the same subject must exhaust its own window');
  assert.equal((await admitRateLimit(db, bucket, '198.51.100.2', 1, 60_000)).admitted, true,
    'a different subject must not inherit another subject\'s exhausted window');
});

test('a correct CAPTCHA answer is accepted once and never again, on Postgres', { skip }, async () => {
  const db = await withDb();
  const ip = '203.0.113.44';
  const challenge = await issueCaptcha(db, 'login', ip);

  const correct = String(challenge.num1 + challenge.num2);
  assert.equal(await consumeCaptcha(db, challenge.id, correct, 'login', ip), true,
    'the right answer must be accepted');
  assert.equal(await consumeCaptcha(db, challenge.id, correct, 'login', ip), false,
    'a spent challenge must not be replayable');
});

test('a wrong CAPTCHA answer is refused and leaves the challenge usable, on Postgres', { skip }, async () => {
  const db = await withDb();
  const ip = '203.0.113.45';
  const challenge = await issueCaptcha(db, 'login', ip);

  assert.equal(await consumeCaptcha(db, challenge.id, '-1', 'login', ip), false,
    'a wrong answer must be refused');
  assert.equal(await consumeCaptcha(db, challenge.id, String(challenge.num1 + challenge.num2), 'login', ip), true,
    'a wrong guess must not burn the challenge');
});

test('the worker claims a queued job, and only one worker gets it, on Postgres', { skip }, async () => {
  const db = await withDb();
  const queue = uniq('q');
  const workspaceId = uniq('ws');
  const scope = await WorkspaceScope.ensure(db, workspaceId);
  await scope.enqueue(queue, { probe: true });

  const first = await claimNextJobAsync(db, [queue]);
  assert.ok(first, 'a queued job must be claimable on Postgres');
  assert.equal(first!.queue, queue);

  const second = await claimNextJobAsync(db, [queue]);
  assert.equal(second, null, 'a claimed job must not be handed to a second worker');
});

test('reaping stale jobs returns a count rather than throwing, on Postgres', { skip }, async () => {
  const db = await withDb();
  const reaped = await reapStaleJobsAsync(db);
  assert.equal(typeof reaped, 'number',
    'the cron endpoint calls this first: if it throws, the queue never drains');
});

test.after(async () => { await closeDb(); });
