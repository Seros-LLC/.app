/**
 * tests/tenancy.test.ts — behavioral WorkspaceScope isolation.
 *
 * The static checker proves that application modules cannot import tenant tables
 * directly. It cannot prove that every scope query carries the right workspace
 * predicate, or that a join cannot leak a neighboring tenant. This test puts two
 * populated workspaces in one database and exercises the scope's read surface.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

process.env.SEROS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { seal } from '../src/crypto';

async function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-tenancy-')), 'test.db');
  await migrateDbAsync(path);
  const db = openDb(path);
  const a = await WorkspaceScope.ensure(db, 'ws-a');
  const b = await WorkspaceScope.ensure(db, 'ws-b');
  await a.addMember('member-a', 'Member A', 'confirmer');
  await b.addMember('member-b', 'Member B', 'confirmer');

  const messageA = await a.ingestMessage({
    channelId: 'C-shared-shape', ts: '100.1', authorId: 'member-a', body: 'private workspace A text',
  });
  const messageB = await b.ingestMessage({
    channelId: 'C-shared-shape', ts: '100.1', authorId: 'member-b', body: 'private workspace B text',
  });
  const pendingA = await a.createDraft({
    sourceMessageId: messageA.row.id, title: 'A pending title', outcome: 'A pending outcome',
    kind: 'commitment', confidence: 80, suggestedOwner: 'member-a', suggestedDueDate: null, provider: 'fake',
  });
  const pendingB = await b.createDraft({
    sourceMessageId: messageB.row.id, title: 'B pending title', outcome: 'B pending outcome',
    kind: 'commitment', confidence: 80, suggestedOwner: 'member-b', suggestedDueDate: null, provider: 'fake',
  });
  await a.setDraftReason(pendingA, 'A-only reason', 'reason-v1');
  await b.setDraftReason(pendingB, 'B-only reason', 'reason-v1');

  const confirmedA = await a.confirm(pendingA, 'confirmed', 'member-a');
  const confirmedB = await b.confirm(pendingB, 'confirmed', 'member-b');
  assert.equal(confirmedA.ok, true);
  assert.equal(confirmedB.ok, true);

  await a.recordChannels([
    { id: 'C-a', name: 'a-only', isPrivate: false },
    { id: 'C-common-looking', name: 'a-label', isPrivate: false },
  ]);
  await b.recordChannels([
    { id: 'C-b', name: 'b-only', isPrivate: false },
    { id: 'C-common-looking', name: 'b-label', isPrivate: false },
  ]);
  await a.setSelectedChannels(['C-a']);
  await b.setSelectedChannels(['C-b']);
  await a.saveConnection({
    teamId: 'T-a', teamName: 'Workspace A', botUserId: 'B-a', tokenEnc: seal('token-a'),
    scopes: 'channels:history', installedBy: 'member-a',
  });
  await b.saveConnection({
    teamId: 'T-b', teamName: 'Workspace B', botUserId: 'B-b', tokenEnc: seal('token-b'),
    scopes: 'channels:history', installedBy: 'member-b',
  });
  const pendingMessageA = await a.ingestMessage({
    channelId: 'C-pending', ts: '200.1', authorId: 'member-a', body: 'A pending-only message',
  });
  const pendingMessageB = await b.ingestMessage({
    channelId: 'C-pending', ts: '200.1', authorId: 'member-b', body: 'B pending-only message',
  });
  const pendingOnlyA = await a.createDraft({
    sourceMessageId: pendingMessageA.row.id, title: 'A still pending', outcome: 'A pending outcome',
    kind: 'request', confidence: 70, suggestedOwner: null, suggestedDueDate: null, provider: 'fake',
  });
  const pendingOnlyB = await b.createDraft({
    sourceMessageId: pendingMessageB.row.id, title: 'B still pending', outcome: 'B pending outcome',
    kind: 'request', confidence: 70, suggestedOwner: null, suggestedDueDate: null, provider: 'fake',
  });
  return { db, a, b, messageA: messageA.row, messageB: messageB.row, pendingA, pendingB, pendingOnlyA, pendingOnlyB,
    confirmedA: confirmedA.confirmationId!, confirmedB: confirmedB.confirmationId!,
    taskA: confirmedA.taskId!, taskB: confirmedB.taskId! };
}

function ids(rows: Array<{ id?: string; memberId?: string; workspaceId?: string }>) {
  return rows.map((r) => r.id ?? r.memberId ?? r.workspaceId).filter(Boolean);
}

test('every WorkspaceScope read path stays inside its workspace', async () => {
  const f = await fixture();

  // Content and queue reads.
  assert.equal((await f.a.messageById(f.messageB.id)), undefined);
  assert.equal((await f.b.messageById(f.messageA.id)), undefined);
  assert.equal((await f.a.draft(f.pendingB)), undefined);
  assert.equal((await f.b.draft(f.pendingA)), undefined);
  assert.deepEqual((await f.a.pendingDrafts()).map((d) => d.id), [f.pendingOnlyA]);
  assert.deepEqual((await f.b.pendingDrafts()).map((d) => d.id), [f.pendingOnlyB]);
  assert.deepEqual(await f.a.draftReasons([f.pendingA, f.pendingB]), { [f.pendingA]: 'A-only reason' });
  assert.deepEqual(await f.b.draftReasons([f.pendingA, f.pendingB]), { [f.pendingB]: 'B-only reason' });

  // Joins and task/confirmation lookups are scoped as well.
  assert.deepEqual((await f.a.taskRows()).map((r) => r.id), [f.taskA]);
  assert.deepEqual((await f.b.taskRows()).map((r) => r.id), [f.taskB]);
  assert.deepEqual((await f.a.recentTasks()).map((r) => r.id), [f.taskA]);
  assert.deepEqual((await f.b.recentTasks()).map((r) => r.id), [f.taskB]);
  assert.equal(await f.a.writeJob(f.confirmedB), null);
  assert.equal(await f.b.writeJob(f.confirmedA), null);

  // Identity and audit reads contain only the local member and local events.
  assert.deepEqual(ids(await f.a.roster()), ['member-a']);
  assert.deepEqual(ids(await f.b.roster()), ['member-b']);
  assert.equal((await f.a.member('member-b')), undefined);
  assert.equal((await f.b.member('member-a')), undefined);
  assert.equal((await f.a.auditRows()).every((r) => r.workspaceId === 'ws-a'), true);
  assert.equal((await f.b.auditRows()).every((r) => r.workspaceId === 'ws-b'), true);

  // Source configuration is tenant-local even when channel ids overlap.
  assert.equal((await f.a.connection())?.teamId, 'T-a');
  assert.equal((await f.b.connection())?.teamId, 'T-b');
  assert.deepEqual((await f.a.channels()).map((c) => c.channelId).sort(), ['C-a', 'C-common-looking']);
  assert.deepEqual((await f.b.channels()).map((c) => c.channelId).sort(), ['C-b', 'C-common-looking']);
  assert.deepEqual((await f.a.selectedChannels()).map((c) => c.channelId), ['C-a']);
  assert.deepEqual((await f.b.selectedChannels()).map((c) => c.channelId), ['C-b']);
  assert.equal(await f.a.isChannelSelected('C-b'), false);
  assert.equal(await f.b.isChannelSelected('C-a'), false);
});
