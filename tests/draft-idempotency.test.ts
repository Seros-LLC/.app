/**
 * tests/draft-idempotency.test.ts — duplicate detect work must not duplicate a draft.
 *
 * REVIEW.md's former H5 path and TESTING-STRATEGY §1 both call out duplicate
 * drafts. Source-message dedupe and tracker-write idempotency were covered, but
 * two queued detect jobs for the same message still produced two random drafts.
 * This test drives the real worker twice, then checks durable rows and model spend.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

process.env.SEROS_PROVIDER = 'fake';

import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { actionMeter, drafts, jobs } from '../src/db/schema';
import { tick } from '../src/worker';

async function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-draft-idem-')), 'test.db');
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await WorkspaceScope.ensure(db, 'ws-draft-idem');
  await scope.addMember('u-1', 'One', 'confirmer');
  const message = await scope.ingestMessage({
    channelId: 'C1', ts: '1.1', authorId: 'u-1', body: 'I will send the report tomorrow',
  });
  return { db, scope, messageId: message.row.id };
}

test('duplicate detect jobs create one draft and do not spend a second model pass', async () => {
  const { db, scope, messageId } = await fixture();
  await scope.enqueue('detect', { messageId });
  await scope.enqueue('detect', { messageId });

  assert.equal(await tick(db), true);
  assert.equal(await tick(db), true);
  assert.equal(await tick(db), false, 'both duplicate jobs are consumed');

  const storedDrafts = await db.select().from(drafts).where(eq(drafts.workspaceId, 'ws-draft-idem'));
  assert.equal(storedDrafts.length, 1, 'the same source message has one draft');
  assert.equal(storedDrafts[0]!.id, await scope.draftForMessage(messageId)?.then((d) => d?.id));

  const storedJobs = await db.select().from(jobs).where(eq(jobs.workspaceId, 'ws-draft-idem'));
  assert.equal(storedJobs.filter((j) => j.status === 'done').length, 2);
  assert.equal(storedJobs.filter((j) => j.status !== 'done').length, 0);

  // One detect, one draft, one best-effort explain. The second detect job is
  // short-circuited by the existing draft and creates no additional meter rows.
  const meters = await db.select().from(actionMeter).where(eq(actionMeter.workspaceId, 'ws-draft-idem'));
  assert.equal(meters.length, 3, 'duplicate work does not make a second provider pass');
  const events = await scope.auditRows();
  assert.ok(events.some((e) => e.event === 'detect.deduplicated'), 'the skip is observable and auditable');
});

test('createDraft is idempotent for an existing source message', async () => {
  const { scope, messageId } = await fixture();
  const first = await scope.createDraft({
    sourceMessageId: messageId, title: 'First title', outcome: 'First outcome',
    kind: 'commitment', confidence: 80, suggestedOwner: null, suggestedDueDate: null, provider: 'fake',
  });
  const second = await scope.createDraft({
    sourceMessageId: messageId, title: 'Different duplicate', outcome: 'Different duplicate',
    kind: 'commitment', confidence: 20, suggestedOwner: null, suggestedDueDate: null, provider: 'fake',
  });
  assert.equal(second, first, 'the existing draft identity is returned');
  assert.equal((await scope.pendingDrafts()).length, 1);
});
