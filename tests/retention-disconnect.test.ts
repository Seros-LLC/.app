/**
 * tests/retention-disconnect.test.ts — disconnecting a source (invariant 25).
 *
 * disconnectConnection() in src/retention.ts must, in order: destroy the stored
 * tokens immediately; cancel queued/running detection work for that source;
 * move that source's PENDING drafts to `expired` (never `confirmed` — ADR 0002
 * says only a human confirming may create a Confirmation/Task, and expiry is not
 * that); purge that source's stored message content well inside the 24h SLA; and
 * write a counts-only audit event. It is idempotent. This path had no direct
 * test.
 *
 * These tests drive the real exported helpers (registerConnection /
 * disconnectConnection) against an on-disk SQLite database, with an injected
 * clock where a deadline matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import {
  registerConnection,
  disconnectConnection,
  connection,
  DISCONNECT_PURGE_SLA_MS,
} from '../src/retention';

async function freshDb() {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-disc-')), 'test.db');
  await migrateDbAsync(path);
  return openDb(path);
}

/**
 * A workspace with one member, one connection over channel C1, one ingested
 * message in C1, and one pending draft on that message.
 */
async function seed(workspaceId: string) {
  const db = await freshDb();
  const scope = await WorkspaceScope.ensure(db, workspaceId);
  await scope.addMember('u-1', 'Author', 'confirmer');
  const connId = await registerConnection(db, workspaceId, {
    kind: 'slack', provider: 'slack', externalAccountId: 'T-1',
    channelIds: ['C1'], accessToken: 'xoxb-secret', refreshToken: 'refresh-secret',
  });
  const msg = await scope.ingestMessage({
    channelId: 'C1', ts: `${Date.now()}.1`, authorId: 'u-1', body: 'I will send the report',
  });
  const draftId = await scope.createDraft({
    sourceMessageId: msg.row.id, title: 'Send the report', outcome: 'Report sent',
    kind: 'commitment', confidence: 90, suggestedOwner: 'u-1', suggestedDueDate: null,
    provider: 'fake',
  });
  return { db, scope, connId, messageId: msg.row.id, draftId };
}

test('disconnect destroys tokens, purges owned content, and reports it', async () => {
  const { db, scope, connId, messageId } = await seed('ws-disc');
  const now = 1_000_000_000_000;

  const res = await disconnectConnection(db, 'ws-disc', connId, { now });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.tokensDestroyed, true);
  assert.equal(res.messagesPurged, 1);
  assert.equal(res.contentPurgeComplete, true);
  assert.equal(res.purgeDueAt, now + DISCONNECT_PURGE_SLA_MS);

  // tokens really gone, status recorded
  const conn = await connection(db, 'ws-disc', connId);
  assert.equal(conn?.accessToken, null);
  assert.equal(conn?.refreshToken, null);
  assert.equal(conn?.status, 'disconnected');

  // the owned message body is purged
  const row = await scope.messageById(messageId);
  assert.equal(row?.body, null);
  assert.equal(typeof row?.contentPurgedAt, 'number');
});

test('disconnect expires the pending draft and never confirms it', async () => {
  const { db, scope, connId, draftId } = await seed('ws-disc-draft');
  const res = await disconnectConnection(db, 'ws-disc-draft', connId, { now: Date.now() });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(res.draftsExpired, 1);
  assert.equal(res.draftsConfirmed, 0, 'disconnect must never confirm a draft (ADR 0002)');

  const d = await scope.draft(draftId);
  assert.equal(d?.state, 'expired', 'the pending draft is expired, not confirmed');
});

test('disconnect is idempotent: a second call destroys nothing new', async () => {
  const { db, connId } = await seed('ws-disc-idem');
  const now = 1_000_000_000_000;
  const first = await disconnectConnection(db, 'ws-disc-idem', connId, { now });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const second = await disconnectConnection(db, 'ws-disc-idem', connId, { now: now + 5_000 });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.tokensDestroyed, false, 'no tokens left to destroy');
  assert.equal(second.messagesPurged, 0, 'content already purged');
  assert.equal(second.draftsExpired, 0, 'no pending drafts left');
  assert.equal(second.draftsConfirmed, 0);
  // the recorded purge deadline is stable across calls
  assert.equal(second.purgeDueAt, first.purgeDueAt);
});

test('disconnecting an unknown connection is refused without side effects', async () => {
  const { db } = await seed('ws-disc-unknown');
  const res = await disconnectConnection(db, 'ws-disc-unknown', 'no-such-conn', { now: Date.now() });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'unknown_connection');
});
