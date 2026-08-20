
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_PROVIDER = 'fake';          // deterministic, offline
process.env.SEROS_SIGNING_SECRET = 'test-secret';

const dir = mkdtempSync(join(tmpdir(), 'seros-retention-test-'));
process.env.SEROS_DB = join(dir, 'test.db');

import { migrateDb, openDb } from '../src/db/client';
import { WorkspaceScope, UnknownWorkspace } from '../src/db/scope';
import { drafts, confirmations, tasks, auditEvents, actionMeter, workspaces, members } from '../src/db/schema';
import {
  DAY_MS, DISCONNECT_PURGE_SLA_MS, purgeableSourceMessages, retentionConnections,
  sweepWorkspace, sweepAllWorkspaces, registerConnection, connection, disconnectConnection,
  deleteWorkspace, ensureRetentionSchema,
} from '../src/retention';
import { and, eq } from 'drizzle-orm';

migrateDb();
const db = openDb();
ensureRetentionSchema(db);

const NOW = Date.now();
const daysLater = (n: number) => NOW + n * DAY_MS;

/** Read a source message back through the nullable view, always workspace-scoped. */
function msg(workspaceId: string, id: string) {
  return db.select().from(purgeableSourceMessages).where(and(
    eq(purgeableSourceMessages.workspaceId, workspaceId),
    eq(purgeableSourceMessages.id, id),
  )).get();
}
function auditFor(workspaceId: string, event: string) {
  return db.select().from(auditEvents).where(and(
    eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.event, event),
  )).all();
}
async function seedMessage(s: WorkspaceScope, channelId: string, ts: string, body: string) {
  const { row } = await s.ingestMessage({ channelId, ts, authorId: 'u-ana', body });
  return row;
}

test('retention: content is purged after the window and identifiers survive', async () => {
  const s = await WorkspaceScope.ensure(db, 'R-purge');
  const row = await seedMessage(s, 'C1', '100.1', 'the secret quarterly numbers are 42');
  const hashBefore = row.bodyHash;

  const r = await sweepWorkspace(db, 'R-purge', { now: daysLater(31) });
  assert.equal(r.counts.source_messages, 1);
  assert.equal(r.rowsPastWindowAfterSweep, 0);

  const after = msg('R-purge', row.id)!;
  assert.equal(after.body, null);                       // content nulled in place
  assert.ok(after.contentPurgedAt && after.contentPurgedAt > 0);
  assert.equal(after.bodyHash, hashBefore);             // dedupe still works
  assert.equal(after.id, row.id);                       // identifiers survive
  assert.equal(after.channelId, 'C1');
  assert.equal(after.ts, '100.1');
  assert.equal(after.authorId, 'u-ana');
  assert.equal(after.receivedAt, row.receivedAt);       // timestamps survive
});

test('retention: content is NOT purged before the window', async () => {
  const s = await WorkspaceScope.ensure(db, 'R-young');
  const row = await seedMessage(s, 'C1', '200.2', 'still inside the retention window');

  const r = await sweepWorkspace(db, 'R-young', { now: daysLater(29) });
  assert.equal(r.counts.source_messages, 0);

  const after = msg('R-young', row.id)!;
  assert.equal(after.body, 'still inside the retention window');
  assert.equal(after.contentPurgedAt, null);
});

test('retention: honours the per-workspace retentionContentDays policy', async () => {
  const s = await WorkspaceScope.ensure(db, 'R-policy');
  db.update(workspaces).set({ retentionContentDays: 7 }).where(eq(workspaces.id, 'R-policy')).run();
  const row = await seedMessage(s, 'C1', '300.3', 'short window content');

  const early = await sweepWorkspace(db, 'R-policy', { now: daysLater(6) });
  assert.equal(early.retentionContentDays, 7);
  assert.equal(early.counts.source_messages, 0);
  assert.equal(msg('R-policy', row.id)!.body, 'short window content');

  const late = await sweepWorkspace(db, 'R-policy', { now: daysLater(8) });
  assert.equal(late.counts.source_messages, 1);
  assert.equal(msg('R-policy', row.id)!.body, null);
});

test('retention: the sweep writes a retention.swept audit row carrying counts only', async () => {
  const s = await WorkspaceScope.ensure(db, 'R-audit');
  await seedMessage(s, 'C1', '400.4', 'salary review for Ana is confidential');

  const before = auditFor('R-audit', 'retention.swept').length;
  const r = await sweepWorkspace(db, 'R-audit', { now: daysLater(31) });
  const rows = auditFor('R-audit', 'retention.swept');
  assert.equal(rows.length, before + 1);

  const last = rows[rows.length - 1]!;
  assert.equal(last.outcome, 'ok');
  const detail = JSON.parse(last.detail!) as Record<string, number>;
  assert.equal(detail.source_messages_purged, 1);
  assert.equal(detail.retention_content_days, 30);
  assert.equal(detail.rows_past_window_after, 0);
  // counts only: every value is a number, and no customer content anywhere
  for (const v of Object.values(detail)) assert.equal(typeof v, 'number');
  assert.ok(!/salary|Ana|confidential/i.test(last.detail!));
  assert.equal(r.counts.source_messages, 1);
});

test('retention: audit rows and meter rows survive the sweep', async () => {
  const s = await WorkspaceScope.ensure(db, 'R-survive');
  await s.meter('detect', 'ok');
  await seedMessage(s, 'C1', '500.5', 'content that will be purged');
  const auditBefore = db.select().from(auditEvents).where(eq(auditEvents.workspaceId, 'R-survive')).all().length;
  const meterBefore = db.select().from(actionMeter).where(eq(actionMeter.workspaceId, 'R-survive')).all().length;

  await sweepWorkspace(db, 'R-survive', { now: daysLater(31) });

  const auditAfter = db.select().from(auditEvents).where(eq(auditEvents.workspaceId, 'R-survive')).all().length;
  const meterAfter = db.select().from(actionMeter).where(eq(actionMeter.workspaceId, 'R-survive')).all().length;
  assert.ok(auditAfter >= auditBefore);   // append-only, nothing removed
  assert.equal(meterAfter, meterBefore);  // content-free, untouched
  assert.equal(meterAfter, 1);
});

test('retention: sweeping twice changes nothing the second time (idempotent)', async () => {
  const s = await WorkspaceScope.ensure(db, 'R-idem');
  const row = await seedMessage(s, 'C1', '600.6', 'purge me exactly once');

  const first = await sweepWorkspace(db, 'R-idem', { now: daysLater(31) });
  const afterFirst = msg('R-idem', row.id)!;
  assert.equal(first.counts.source_messages, 1);

  const second = await sweepWorkspace(db, 'R-idem', { now: daysLater(32) });
  const afterSecond = msg('R-idem', row.id)!;

  assert.equal(second.counts.source_messages, 0);       // nothing left to do
  assert.equal(second.counts.jobs, 0);
  assert.deepEqual(afterSecond, afterFirst);            // byte-for-byte the same row
  assert.equal(afterSecond.contentPurgedAt, afterFirst.contentPurgedAt);
});

test('retention: sweepAllWorkspaces refuses an unknown workspace and covers known ones', async () => {
  await assert.rejects(() => sweepWorkspace(db, 'R-does-not-exist'), UnknownWorkspace);
  const results = await sweepAllWorkspaces(db, { now: NOW });
  assert.ok(results.length > 0);
  assert.ok(results.some((r) => r.workspaceId === 'R-purge'));
  for (const r of results) assert.equal(r.rowsPastWindowAfterSweep, 0);
});

test('disconnect: tokens destroyed, pending drafts expired and never confirmed', async () => {
  const s = await WorkspaceScope.ensure(db, 'R-disc');
  await s.addMember('u-me', 'Me');
  const row = await seedMessage(s, 'C-slack', '700.7', "I'll ship the migration by Friday.");
  const draftId = await s.createDraft({
    sourceMessageId: row.id, title: 'Ship the migration', outcome: 'migration shipped',
    kind: 'commitment', confidence: 90, suggestedOwner: 'u-me', suggestedDueDate: null,
    provider: 'fake',
  });
  await s.enqueue('detect', { messageId: row.id });
  const connId = await registerConnection(db, 'R-disc', {
    kind: 'slack', provider: 'slack', externalAccountId: 'T-ext',
    channelIds: ['C-slack'], accessToken: 'xoxb-secret', refreshToken: 'xoxr-secret',
  });

  const r = await disconnectConnection(db, 'R-disc', connId, { now: NOW });
  assert.equal(r.ok, true);
  if (!r.ok) return;

  // tokens are gone from the row, immediately
  assert.equal(r.tokensDestroyed, true);
  const conn = await connection(db, 'R-disc', connId);
  if (!conn) throw new Error('no pg connection');
  assert.ok(conn.accessToken === null || conn.accessToken === undefined);
  assert.ok(conn.refreshToken === null || conn.refreshToken === undefined);
  assert.equal(conn.status, 'disconnected');
  assert.equal(conn.disconnectedAt, NOW);

  // pending drafts are CANCELLED as expired, never confirmed, never silently dropped
  assert.equal(r.draftsExpired, 1);
  assert.equal(r.draftsConfirmed, 0);
  const d = db.select().from(drafts).where(and(eq(drafts.workspaceId, 'R-disc'), eq(drafts.id, draftId))).get()!;
  assert.equal(d.state, 'expired');
  assert.equal(db.select().from(confirmations).where(eq(confirmations.workspaceId, 'R-disc')).all().length, 0);
  assert.equal(db.select().from(tasks).where(eq(tasks.workspaceId, 'R-disc')).all().length, 0);

  // queued detection work for that connection is cancelled
  assert.equal(r.jobsCancelled, 1);

  // and the disconnect is announced in the audit trail, counts only
  const evs = auditFor('R-disc', 'connection.disconnected');
  assert.equal(evs.length, 1);
  const detail = JSON.parse(evs[0]!.detail!) as Record<string, number>;
  assert.equal(detail.drafts_expired, 1);
  assert.equal(detail.drafts_confirmed, 0);
  assert.ok(!/migration/i.test(evs[0]!.detail!));
});

test("disconnect: that source's content is purged inside the 24h SLA, and is idempotent", async () => {
  const s = await WorkspaceScope.ensure(db, 'R-disc2');
  const mine = await seedMessage(s, 'C-gone', '800.8', 'content belonging to the disconnected source');
  const other = await seedMessage(s, 'C-stays', '801.8', 'content from a different connection');
  const connId = await registerConnection(db, 'R-disc2', {
    kind: 'slack', provider: 'slack', externalAccountId: 'T-ext2',
    channelIds: ['C-gone'], accessToken: 'xoxb-secret',
  });

  const r = await disconnectConnection(db, 'R-disc2', connId, { now: NOW });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.messagesPurged, 1);
  assert.equal(r.contentPurgeComplete, true);
  assert.equal(r.purgeDueAt, NOW + DISCONNECT_PURGE_SLA_MS);
  assert.ok(r.purgeDueAt - NOW <= DISCONNECT_PURGE_SLA_MS);

  const purged = msg('R-disc2', mine.id)!;
  assert.equal(purged.body, null);
  assert.ok(purged.contentPurgedAt);
  assert.equal(purged.bodyHash, mine.bodyHash);        // identifier survives disconnect
  // a different source in the same workspace is untouched
  assert.equal(msg('R-disc2', other.id)!.body, 'content from a different connection');

  // idempotent, and never a silent confirmation
  const again = await disconnectConnection(db, 'R-disc2', connId, { now: NOW + 1000 });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.messagesPurged, 0);
  assert.equal(again.draftsExpired, 0);
  assert.equal(again.draftsConfirmed, 0);
  assert.equal(again.tokensDestroyed, false);
  assert.deepEqual(msg('R-disc2', mine.id), purged);
});

test('disconnect: an unknown connection is refused explicitly, never silently confirmed', async () => {
  await WorkspaceScope.ensure(db, 'R-disc3');
  const r = await disconnectConnection(db, 'R-disc3', 'no-such-connection');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'unknown_connection');
  const evs = auditFor('R-disc3', 'connection.disconnected');
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.outcome, 'denied');
});

test('workspace deletion: tenant rows go, audit trail and meter stay, status is deleted', async () => {
  const s = await WorkspaceScope.ensure(db, 'R-del');
  await s.addMember('u-me', 'Me');
  await s.meter('draft', 'ok');
  const row = await seedMessage(s, 'C1', '900.9', 'delete this workspace content');
  const draftId = await s.createDraft({
    sourceMessageId: row.id, title: 'Delete me', outcome: 'gone', kind: 'commitment',
    confidence: 80, suggestedOwner: 'u-me', suggestedDueDate: null, provider: 'fake',
  });
  const confirmed = await s.confirm(draftId, 'confirmed', 'u-me');
  assert.equal(confirmed.ok, true);
  await registerConnection(db, 'R-del', {
    kind: 'slack', provider: 'slack', externalAccountId: 'T-del',
    channelIds: ['C1'], accessToken: 'xoxb-secret',
  });
  const auditBefore = db.select().from(auditEvents).where(eq(auditEvents.workspaceId, 'R-del')).all();
  const meterBefore = db.select().from(actionMeter).where(eq(actionMeter.workspaceId, 'R-del')).all();
  assert.ok(auditBefore.length > 0);
  assert.equal(meterBefore.length, 1);

  const r = await deleteWorkspace(db, 'R-del', { now: NOW });
  assert.equal(r.status, 'deleted');
  assert.equal(r.deleted.source_messages, 1);
  assert.equal(r.deleted.drafts, 1);
  assert.equal(r.deleted.confirmations, 1);
  assert.equal(r.deleted.tasks, 1);
  assert.equal(r.deleted.members, 1);
  assert.equal(r.deleted.retention_connections, 1);

  // tenant content and rows are gone
  assert.equal(msg('R-del', row.id), undefined);
  assert.equal(db.select().from(drafts).where(eq(drafts.workspaceId, 'R-del')).all().length, 0);
  assert.equal(db.select().from(confirmations).where(eq(confirmations.workspaceId, 'R-del')).all().length, 0);
  assert.equal(db.select().from(tasks).where(eq(tasks.workspaceId, 'R-del')).all().length, 0);
  assert.equal(db.select().from(members).where(eq(members.workspaceId, 'R-del')).all().length, 0);
  assert.equal(db.select().from(retentionConnections).where(eq(retentionConnections.workspaceId, 'R-del')).all().length, 0);

  // the audit trail and the meter survive, including the pre-deletion history
  const auditAfter = db.select().from(auditEvents).where(eq(auditEvents.workspaceId, 'R-del')).all();
  const meterAfter = db.select().from(actionMeter).where(eq(actionMeter.workspaceId, 'R-del')).all();
  assert.ok(auditAfter.length > auditBefore.length);
  for (const before of auditBefore) assert.ok(auditAfter.some((a) => a.id === before.id && a.event === before.event));
  assert.deepEqual(meterAfter, meterBefore);

  // completion record is written LAST and carries counts only
  const last = auditAfter[auditAfter.length - 1]!;
  assert.equal(last.event, 'workspace.deleted');
  const detail = JSON.parse(last.detail!) as Record<string, number>;
  assert.equal(detail.source_messages_deleted, 1);
  assert.equal(detail.audit_events_preserved, auditAfter.length - 1);
  assert.ok(!/delete this workspace content/i.test(last.detail!));

  // the workspace row itself remains, in status 'deleted'
  const ws = db.select().from(workspaces).where(eq(workspaces.id, 'R-del')).get()!;
  assert.equal(ws.status, 'deleted');
});

test('workspace deletion: deleting twice is idempotent and other tenants are untouched', async () => {
  const neighbour = await WorkspaceScope.ensure(db, 'R-neighbour');
  const kept = await seedMessage(neighbour, 'C1', '950.9', 'a different tenant, still here');
  const s = await WorkspaceScope.ensure(db, 'R-del2');
  await seedMessage(s, 'C1', '951.9', 'doomed content');

  await deleteWorkspace(db, 'R-del2', { now: NOW });
  const again = await deleteWorkspace(db, 'R-del2', { now: NOW + 1 });
  for (const n of Object.values(again.deleted)) assert.equal(n, 0);
  assert.equal(db.select().from(workspaces).where(eq(workspaces.id, 'R-del2')).get()!.status, 'deleted');

  // a sweep over a deleted workspace is a no-op that still records that it ran
  const swept = await sweepWorkspace(db, 'R-del2', { now: daysLater(60) });
  assert.equal(swept.skipped, true);
  assert.equal(swept.counts.source_messages, 0);
  assert.ok(auditFor('R-del2', 'retention.swept').length >= 1);

  // the neighbouring tenant is completely unaffected
  assert.equal(msg('R-neighbour', kept.id)!.body, 'a different tenant, still here');
  assert.equal(db.select().from(workspaces).where(eq(workspaces.id, 'R-neighbour')).get()!.status, 'active');
});

test.after(() => { rmSync(dir, { recursive: true, force: true }); });
