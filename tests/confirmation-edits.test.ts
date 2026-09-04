/**
 * The promise under test: an edit at confirm time is DATA, not a discard.
 *
 * `confirm(..., 'confirmed_with_edits', ...)` used to UPDATE the draft row in
 * place with the human's values. The draft is the only record of what the model
 * proposed, so that overwrite destroyed it — and afterwards "the model got it
 * right and the human agreed" and "the model got it wrong and the human rewrote
 * it" were the same two rows. Acceptance rate and owner accuracy, the numbers
 * ADR 0002 calls the product's only compounding data asset, were not computable.
 * REVIEW.md M6.
 *
 * These tests fail against the old in-place UPDATE: the first because the draft
 * comes back carrying the human's title, the second because there is no sidecar
 * row to read the human's values out of.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { TrackerService } from '../src/tracker/service';
import { FakeTrackerWriter } from '../src/tracker/fake';
import { tick } from '../src/worker';
import { deleteWorkspace } from '../src/retention';

const MODEL = {
  title: 'Send the report',
  outcome: 'Report sent',
  owner: 'u-1',
  due: '2099-01-05',
};
const HUMAN = {
  title: 'Send the Q3 revenue report to Finance',
  owner: 'u-2',
};

function freshDb() {
  return join(mkdtempSync(join(tmpdir(), 'seros-edits-')), 'test.db');
}

/** A pending draft carrying the model's proposal, plus two members to own it. */
async function seedDraft(db: any, workspaceId: string) {
  const scope = await WorkspaceScope.ensure(db, workspaceId);
  await scope.addMember('u-1', 'Confirmer', 'confirmer');
  await scope.addMember('u-2', 'Other Owner', 'owner');
  const msg = await scope.ingestMessage({
    channelId: 'C1', ts: `${Date.now()}.${Math.floor(Math.random() * 10000)}`, authorId: 'u-1',
    body: 'I will send the report on 2099-01-05',
  });
  const draftId = await scope.createDraft({
    sourceMessageId: msg.row.id, title: MODEL.title, outcome: MODEL.outcome,
    kind: 'commitment', confidence: 90, suggestedOwner: MODEL.owner,
    suggestedDueDate: MODEL.due, provider: 'fake',
  });
  return { scope, draftId };
}

async function drain(db: any) {
  for (let i = 0; i < 50; i++) { if (!(await tick(db))) return; }
}

test('an edit at confirm time leaves the model\'s draft intact', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  const { scope, draftId } = await seedDraft(db, 'ws-edit-keeps-draft');

  const res = await scope.confirm(draftId, 'confirmed_with_edits', 'u-1', {
    title: HUMAN.title, suggestedOwner: HUMAN.owner,
  });
  assert.equal(res.ok, true);

  // The model's proposal survives the human's correction, verbatim.
  const draft = await scope.draft(draftId);
  assert.equal(draft?.title, MODEL.title, 'the draft still says what the MODEL proposed');
  assert.equal(draft?.suggestedOwner, MODEL.owner, 'the model\'s owner was not overwritten');
  assert.equal(draft?.outcome, MODEL.outcome);
  assert.equal(draft?.state, 'confirmed');

  // ...and the human's values are recorded next to it, not on top of it.
  const job = await scope.writeJob((res as any).confirmationId);
  assert.equal(job?.edit?.title, HUMAN.title, 'the human\'s title is kept');
  assert.equal(job?.edit?.owner, HUMAN.owner);
  assert.equal(job?.edit?.editedFields, 'title,owner', 'exactly the fields that moved');
  // Untouched fields are NULL, so "left alone" is distinguishable from
  // "retyped to the same value".
  assert.equal(job?.edit?.outcome, null, 'an untouched field records no value');
  assert.equal(job?.edit?.dueDate, null);
});

test('the tracker receives what the human agreed to, not what the model proposed', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  const tracker = new FakeTrackerWriter();
  TrackerService.reset(tracker);

  const { scope, draftId } = await seedDraft(db, 'ws-edit-reaches-tracker');
  const res = await scope.confirm(draftId, 'confirmed_with_edits', 'u-1', {
    title: HUMAN.title, suggestedOwner: HUMAN.owner,
  });
  assert.equal(res.ok, true);
  await drain(db);

  assert.equal(tracker.writes.length, 1, 'one issue created');
  const written = tracker.writes[0]!;
  // The whole point: a human corrected the model, so the customer's tracker gets
  // the correction. Writing MODEL.title here would be the product being wrong in
  // the one place the customer actually looks.
  assert.equal(written.title, HUMAN.title);
  assert.equal(written.owner, HUMAN.owner);
  // Fields the human left alone still come from the model's draft.
  assert.equal(written.outcome, MODEL.outcome);
  assert.equal(written.dueDate, MODEL.due);

  // The tasks page shows the same agreed values.
  const row = (await scope.taskRows(10)).find((t: any) => t.id === (res as any).taskId);
  assert.equal(row?.title, HUMAN.title);
  assert.equal(row?.owner, HUMAN.owner);
  assert.equal(row?.due, MODEL.due);
});

test('deleting a workspace erases the human\'s edited values', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  const { scope, draftId } = await seedDraft(db, 'ws-edit-erasure');
  const res = await scope.confirm(draftId, 'confirmed_with_edits', 'u-1', {
    title: HUMAN.title, suggestedOwner: HUMAN.owner,
  });
  const confirmationId = (res as any).confirmationId;
  assert.ok((await scope.writeJob(confirmationId))?.edit, 'precondition: the edit exists');

  // An edited title is the customer's own words. deleteWorkspace() never names
  // this table — it deletes `confirmations` and relies on ON DELETE CASCADE — so
  // this test is what stands between a schema change and customer content
  // surviving a deletion request. (Brief invariant 25.)
  await deleteWorkspace(db, 'ws-edit-erasure');
  const left = await scope.writeJob(confirmationId);
  assert.equal(left, null, 'no confirmation, and no edit hanging off it');
});

test('a plain confirmation records no edit at all', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  const { scope, draftId } = await seedDraft(db, 'ws-no-edit');

  const res = await scope.confirm(draftId, 'confirmed', 'u-1');
  assert.equal(res.ok, true);

  // No row, rather than a row full of NULLs: "never offered an edit" and
  // "offered one and changed nothing" are different facts about the model.
  const job = await scope.writeJob((res as any).confirmationId);
  assert.equal(job?.edit, undefined, 'an unedited confirmation has no sidecar row');
  assert.equal(job?.agreed?.title, MODEL.title, 'the agreed values fall back to the draft');
  assert.equal(job?.agreed?.owner, MODEL.owner);
});
