/**
 * tests/draft-expiry.test.ts — an unreviewed draft must not live forever.
 *
 * REVIEW.md M7. Drafts hold customer content (a title is the customer's own
 * words), and until `expires_at` landed nothing gave an unconfirmed one an end
 * date: anything nobody clicked simply accumulated, which quietly contradicts
 * the retention promise the website makes.
 *
 * The rules under test come from brief §1.5: every draft carries its own
 * deadline, only `pending` may transition, `expired` is terminal, and expiry
 * may never manufacture a Confirmation or a Task (ADR 0002 — `confirm()` is the
 * only thing allowed to create those, and expiry is not a human confirming).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { DAY_MS, DEFAULT_DRAFT_TTL_DAYS } from '../src/db/schema';
import { expireDrafts } from '../src/limits';

function freshDb() {
  return join(mkdtempSync(join(tmpdir(), 'seros-expiry-')), 'test.db');
}

/** A workspace with one confirmer and one pending draft. */
async function seed(workspaceId: string, draftOpts: { expiresAt?: number } = {}) {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await WorkspaceScope.ensure(db, workspaceId);
  await scope.addMember('u-1', 'Confirmer', 'confirmer');
  const msg = await scope.ingestMessage({
    channelId: 'C1', ts: `${Date.now()}.${Math.floor(Math.random() * 10000)}`,
    authorId: 'u-1', body: 'I will send the report on 2099-01-05',
  });
  const draftId = await scope.createDraft({
    sourceMessageId: msg.row.id, title: 'Send the report', outcome: 'Report sent',
    kind: 'commitment', confidence: 90, suggestedOwner: 'u-1',
    suggestedDueDate: '2099-01-05', provider: 'fake', ...draftOpts,
  });
  return { db, scope, draftId };
}

test('a new draft is stamped with a deadline', async () => {
  const { scope, draftId } = await seed('ws-expiry-stamp');
  const d = await scope.draft(draftId);

  // The deadline is stored per draft rather than inferred from created_at at sweep
  // time, so a future per-plan or per-workspace lifetime is a change at the point
  // of writing instead of a rewrite of the sweep query (brief §1.5).
  assert.ok(d?.expiresAt, 'the draft carries an expires_at');
  assert.equal(d!.expiresAt, d!.createdAt + DEFAULT_DRAFT_TTL_DAYS * DAY_MS);
});

test('an explicit deadline overrides the default', async () => {
  const soon = Date.now() + 60_000;
  const { scope, draftId } = await seed('ws-expiry-explicit', { expiresAt: soon });
  const d = await scope.draft(draftId);
  assert.equal(d!.expiresAt, soon, 'the caller\'s deadline wins over the 14-day default');
});

test('a draft past its deadline expires, and one inside it does not', async () => {
  const { db, scope, draftId } = await seed('ws-expiry-sweep');
  const d = await scope.draft(draftId);

  // A moment before the deadline: nothing should move. Without this the test would
  // pass just as well against a sweeper that expired everything unconditionally.
  const before = await expireDrafts(db, 'ws-expiry-sweep', { now: d!.expiresAt! - 1000 });
  assert.equal(before.counts.drafts_expired, 0, 'not yet past the deadline');
  assert.equal((await scope.draft(draftId))?.state, 'pending');

  const after = await expireDrafts(db, 'ws-expiry-sweep', { now: d!.expiresAt! + 1000 });
  assert.equal(after.counts.drafts_expired, 1);
  assert.deepEqual(after.draftIds, [draftId]);
  assert.equal((await scope.draft(draftId))?.state, 'expired');

  // Idempotent: `expired` is terminal, so a second sweep finds nothing to do.
  const again = await expireDrafts(db, 'ws-expiry-sweep', { now: d!.expiresAt! + 5000 });
  assert.equal(again.counts.drafts_expired, 0, 'expiry does not re-expire');
});

test('expiry never creates a confirmation or a task', async () => {
  const { db, scope, draftId } = await seed('ws-expiry-no-writes');
  const d = await scope.draft(draftId);

  const res = await expireDrafts(db, 'ws-expiry-no-writes', { now: d!.expiresAt! + 1000 });
  // ADR 0002: only a human confirming may produce these. A sweep that quietly
  // created a task would push unreviewed model output into a customer's tracker.
  assert.equal(res.confirmationsCreated, 0);
  assert.equal(res.tasksCreated, 0);
  assert.equal((await scope.taskRows(50)).length, 0, 'no task row exists');
});

test('an expired draft can no longer be confirmed', async () => {
  const { db, scope, draftId } = await seed('ws-expiry-terminal');
  const d = await scope.draft(draftId);
  await expireDrafts(db, 'ws-expiry-terminal', { now: d!.expiresAt! + 1000 });

  // The point of the whole feature: expiry has to actually close the door. If a
  // stale draft could still be confirmed, expiring it would be cosmetic.
  const res = await scope.confirm(draftId, 'confirmed', 'u-1');
  assert.equal(res.ok, false);
  assert.equal((res as any).reason, 'not_pending');
  assert.equal((await scope.taskRows(50)).length, 0);
});
