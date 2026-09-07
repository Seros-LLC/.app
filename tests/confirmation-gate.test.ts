/**
 * tests/confirmation-gate.test.ts — task creation requires a real confirmation.
 *
 * IMPLEMENTATION-BRIEF invariant 1 and ADR 0002 make this the central safety
 * boundary: a task may be created only from a human Confirmation. Existing
 * confirmation tests exercise edits and normal flow, but did not attempt the
 * forbidden direct task insert. This test checks both sides of the gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { tasks } from '../src/db/schema';

async function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-confirm-gate-')), 'test.db');
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await WorkspaceScope.ensure(db, 'ws-confirm-gate');
  await scope.addMember('member-1', 'Member', 'confirmer');
  const message = await scope.ingestMessage({
    channelId: 'C1', ts: '1.1', authorId: 'member-1', body: 'I will finish the review tomorrow',
  });
  const draftId = await scope.createDraft({
    sourceMessageId: message.row.id, title: 'Finish review', outcome: 'Review complete',
    kind: 'commitment', confidence: 90, suggestedOwner: 'member-1', suggestedDueDate: null, provider: 'fake',
  });
  return { db, scope, draftId };
}

test('a direct task insert with no confirmation is rejected by the database gate', async () => {
  const { db } = await fixture();
  await assert.rejects(
    () => db.insert(tasks).values({
      workspaceId: 'ws-confirm-gate', id: 'orphan-task', confirmationId: 'missing-confirmation',
      writeState: 'queued', threadReplyState: 'pending', idempotencyKey: 'orphan-key', createdAt: Date.now(),
    }),
    /foreign key|constraint|no such table/i,
    'a task without a real Confirmation is a schema violation, not an application convention',
  );
});

test('the only valid task path creates a confirmation and linked task together', async () => {
  const { db, scope, draftId } = await fixture();
  const result = await scope.confirm(draftId, 'confirmed', 'member-1');

  assert.equal(result.ok, true);
  assert.ok(result.confirmationId);
  assert.ok(result.taskId);
  const rows = await db.select().from(tasks).where(eq(tasks.workspaceId, 'ws-confirm-gate'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.confirmationId, result.confirmationId);
  assert.equal(rows[0]!.id, result.taskId);
});
