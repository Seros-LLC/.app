/**
 * tests/retention-sweep.test.ts — the scheduled retention sweeper.
 *
 * sweepWorkspace() in src/retention.ts is stage 15 of the pipeline and the
 * enforcement point for the retention promise the website makes: once a source
 * message is past its workspace's content window its `body` is nulled in place
 * (invariant 27) while its `body_hash`, ids and timestamps survive so dedupe,
 * metrics and audit keep working; terminal queue rows past the window are
 * deleted; and a deleted workspace is skipped, not walked. deleteWorkspace() was
 * already covered (tests/confirmation-edits.test.ts), but the sweeper itself had
 * no direct test.
 *
 * The window is exercised by seeding normally (receivedAt ~ real now) and then
 * sweeping with an injected `now` shifted across the window, so no test has to
 * wait 30 days.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { jobs } from '../src/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  sweepWorkspace,
  sweepAllWorkspaces,
  DEFAULT_RETENTION_CONTENT_DAYS,
  DAY_MS,
} from '../src/retention';

async function freshDb() {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-sweep-')), 'test.db');
  await migrateDbAsync(path);
  return openDb(path);
}

/** A workspace with one member and one ingested message; returns its ids. */
async function seed(workspaceId: string) {
  const db = await freshDb();
  const scope = await WorkspaceScope.ensure(db, workspaceId);
  await scope.addMember('u-1', 'Author', 'confirmer');
  const msg = await scope.ingestMessage({
    channelId: 'C1', ts: `${Date.now()}.1`, authorId: 'u-1', body: 'the customer said this',
  });
  return { db, scope, messageId: msg.row.id };
}

/** A `now` far enough ahead that the default content window has closed. */
function pastWindow(): number {
  return Date.now() + (DEFAULT_RETENTION_CONTENT_DAYS + 10) * DAY_MS;
}

test('a message inside the content window keeps its body', async () => {
  const { db, scope, messageId } = await seed('ws-inside');
  const res = await sweepWorkspace(db, 'ws-inside', { now: Date.now() });

  assert.equal(res.skipped, false);
  assert.equal(res.counts.source_messages, 0, 'nothing purged inside the window');
  assert.equal(res.rowsPastWindowAfterSweep, 0);
  const row = await scope.messageById(messageId);
  assert.equal(row?.body, 'the customer said this', 'the body is untouched');
  assert.equal(row?.contentPurgedAt, null);
});

test('a message past the content window has its body nulled but its hash kept', async () => {
  const { db, scope, messageId } = await seed('ws-past');
  const before = await scope.messageById(messageId);
  const now = pastWindow();

  const res = await sweepWorkspace(db, 'ws-past', { now });
  assert.equal(res.skipped, false);
  assert.equal(res.counts.source_messages, 1, 'exactly the one message is purged');
  assert.equal(res.rowsPastWindowAfterSweep, 0, 'nothing left past the window');

  const row = await scope.messageById(messageId);
  assert.equal(row?.body, null, 'body is nulled (invariant 27)');
  assert.equal(typeof row?.contentPurgedAt, 'number', 'content_purged_at is stamped');
  assert.equal(row?.bodyHash, before?.bodyHash, 'body_hash survives for dedupe/metrics');
  assert.equal(row?.id, before?.id, 'ids survive');
  assert.equal(row?.receivedAt, before?.receivedAt, 'timestamps survive');
});

test('the sweep is idempotent: a second run purges nothing new', async () => {
  const { db, messageId } = await seed('ws-idem');
  const now = pastWindow();
  const first = await sweepWorkspace(db, 'ws-idem', { now });
  assert.equal(first.counts.source_messages, 1);

  const second = await sweepWorkspace(db, 'ws-idem', { now: now + 1000 });
  assert.equal(second.counts.source_messages, 0, 'already-purged rows are not re-counted');
  assert.equal(second.rowsPastWindowAfterSweep, 0);
  void messageId;
});

test('terminal jobs past the window are deleted; live jobs are left alone', async () => {
  const { db, scope } = await seed('ws-jobs');
  // enqueue() stamps createdAt = now(), so it is well before a past-window sweep.
  const liveId = await scope.enqueue('detect', { messageId: 'm-live' });
  const doneId = await scope.enqueue('detect', { messageId: 'm-done' });
  // mark one terminal by hand via the scope's db handle
  await db.update(jobs).set({ status: 'done' })
    .where(and(eq(jobs.workspaceId, 'ws-jobs'), eq(jobs.id, doneId)));

  const res = await sweepWorkspace(db, 'ws-jobs', { now: pastWindow() });
  assert.equal(res.counts.jobs, 1, 'only the terminal job is deleted');

  const remaining = await db.select().from(jobs).where(eq(jobs.workspaceId, 'ws-jobs'));
  const ids = remaining.map((r) => r.id);
  assert.ok(ids.includes(liveId), 'the queued job survives');
  assert.ok(!ids.includes(doneId), 'the done job is gone');
});

test('sweepWorkspace refuses an unknown workspace', async () => {
  const db = await freshDb();
  await assert.rejects(() => sweepWorkspace(db, 'no-such-ws', { now: Date.now() }));
});

test('sweepAllWorkspaces walks every workspace with its own policy', async () => {
  const { db } = await seed('ws-a');
  // add a second workspace on the same db
  const scopeB = await WorkspaceScope.ensure(db, 'ws-b');
  await scopeB.addMember('u-2', 'Author B', 'confirmer');
  await scopeB.ingestMessage({ channelId: 'C1', ts: `${Date.now()}.2`, authorId: 'u-2', body: 'b said this' });

  const results = await sweepAllWorkspaces(db, { now: pastWindow() });
  const ids = results.map((r) => r.workspaceId).sort();
  assert.deepEqual(ids, ['ws-a', 'ws-b']);
  assert.ok(results.every((r) => r.rowsPastWindowAfterSweep === 0));
  assert.equal(results.reduce((n, r) => n + r.counts.source_messages, 0), 2);
});
