/**
 * The promise under test: a confirmed task reaches the customer's tracker
 * exactly once, and nothing claims it exists until the tracker says so.
 *
 * The worker used to set write_state='created' BEFORE calling the tracker, so a
 * failed call produced a task that claimed to exist in a tracker it had never
 * reached, and the retry returned early on 'created'. The second test is that
 * bug; it fails against the old ordering.
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

function freshDb() {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-tracker-')), 'test.db');
  return path;
}

async function seedConfirmedTask(db: any, workspaceId: string) {
  const scope = await WorkspaceScope.ensure(db, workspaceId);
  await scope.addMember('u-1', 'Confirmer', 'confirmer');
  const msg = await scope.ingestMessage({
    channelId: 'C1', ts: `${Date.now()}.${Math.floor(Math.random() * 10000)}`, authorId: 'u-1',
    body: 'I will send the report on 2099-01-05',
  });
  const draftId = await scope.createDraft({
    sourceMessageId: msg.row.id, title: 'Send the report', outcome: 'Report sent',
    kind: 'commitment', confidence: 90, suggestedOwner: 'u-1',
    suggestedDueDate: '2099-01-05', provider: 'fake',
  });
  const res = await scope.confirm(draftId, 'confirmed', 'u-1');
  assert.equal(res.ok, true);
  return { scope, confirmationId: (res as any).confirmationId as string, taskId: (res as any).taskId as string };
}

async function drain(db: any) {
  for (let i = 0; i < 50; i++) { if (!(await tick(db))) return; }
}

test('a confirmed task is written to the tracker exactly once', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  const tracker = new FakeTrackerWriter();
  TrackerService.reset(tracker);

  const { scope, taskId } = await seedConfirmedTask(db, 'ws-happy');
  await drain(db);

  assert.equal(tracker.writes.length, 1, 'one issue created');
  const task = (await scope.recentTasks(10)).find((t: any) => t.id === taskId);
  assert.equal(task?.writeState, 'created');
  const write = await scope.taskWrite(taskId);
  assert.equal(write?.state, 'done');
  assert.ok(write?.externalId, 'the external id is recorded, not assumed');

  await drain(db);
  assert.equal(tracker.writes.length, 1, 'no duplicate on a second pass');
});

test('a failed tracker call leaves the task unwritten, and the retry delivers it', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  const tracker = new FakeTrackerWriter();
  tracker.failFor(1);                       // the first attempt hits an outage
  TrackerService.reset(tracker);

  const { scope, taskId, confirmationId } = await seedConfirmedTask(db, 'ws-outage');
  await drain(db);                          // first attempt fails and is requeued

  let task = (await scope.recentTasks(10)).find((t: any) => t.id === taskId);
  assert.equal(task?.writeState, 'queued', 'a failed call never claims the task exists');
  assert.equal(await scope.claimTaskWrite(taskId, 0), 'claimed', 'the claim was released for the retry');
  await scope.releaseTaskWrite(taskId);

  // The real retry is the queue's backoff, which is deliberately in the future;
  // this is that same job, run now.
  await scope.enqueue('tracker_write', { confirmationId });
  await drain(db);
  task = (await scope.recentTasks(10)).find((t: any) => t.id === taskId);
  assert.equal(task?.writeState, 'created', 'the retry delivered the task');
  assert.equal(tracker.writes.length, 1, 'delivered once, not twice');
});

test('the claim stops a second worker writing the same task', async () => {
  const path = freshDb();
  await migrateDbAsync(path);
  const db = openDb(path);
  TrackerService.reset(new FakeTrackerWriter());

  const { scope, taskId } = await seedConfirmedTask(db, 'ws-race');
  assert.equal(await scope.claimTaskWrite(taskId), 'claimed');
  assert.equal(await scope.claimTaskWrite(taskId), 'busy', 'a live claim is exclusive');

  await scope.completeTaskWrite(taskId, { tracker: 'fake', externalId: 'X-1', externalUrl: 'https://tracker.invalid/X-1' });
  assert.equal(await scope.claimTaskWrite(taskId), 'done', 'a finished write is never re-attempted');
});
