import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_PROVIDER = 'fake';
process.env.SEROS_SIGNING_SECRET = 'hardening-signing-secret-long';
process.env.SEROS_SESSION_SECRET = 'hardening-session-secret-long';
const dir = mkdtempSync(join(tmpdir(), 'seros-hard-'));
process.env.SEROS_DB = join(dir, 'hard.db');

import { migrateDb, openDb } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { claimNextJob, reapStaleJobs } from '../src/db/system';
import { tick } from '../src/worker';
import { tasks, auditEvents, jobs } from '../src/db/schema';
import { and, eq } from 'drizzle-orm';

migrateDb();
const db = openDb();
const scope = WorkspaceScope.ensure(db, 'hard', 'Hardening');
scope.addMember('u-me', 'Me', 'owner');

async function pendingDraft(text = "I'll send the report by 2030-01-01.") {
  const { row } = scope.ingestMessage({ channelId: 'C1', ts: String(Math.random()), authorId: 'u-me', body: text });
  scope.enqueue('detect', { messageId: row.id });
  while (await tick(db)) { /* drain */ }
  return scope.pendingDrafts()[0]!;
}

test('M9: the idempotency key is unique, enforced by the database', async () => {
  const d = await pendingDraft();
  const r: any = scope.confirm(d.id, 'confirmed', 'u-me');
  const t = db.select().from(tasks).where(eq(tasks.confirmationId, r.confirmationId)).get()!;
  assert.throws(() => {
    db.insert(tasks).values({
      workspaceId: 'hard', id: 'second', confirmationId: r.confirmationId,
      writeState: 'queued', threadReplyState: 'pending',
      idempotencyKey: t.idempotencyKey, createdAt: Date.now(),
    }).run();
  }, /UNIQUE/i);
});

test('M4: a job orphaned by a dead worker is returned to the queue, not stranded', () => {
  const id = scope.enqueue('detect', { messageId: 'nothing' });
  const claimed = claimNextJob(db, ['detect'])!;
  assert.equal(claimed.id, id);
  assert.equal(claimed.status, 'running');
  assert.equal(reapStaleJobs(db, 60_000, Date.now()), 0);          // lease still valid
  const reaped = reapStaleJobs(db, 60_000, Date.now() + 120_000);  // worker died
  assert.equal(reaped, 1);
  const row = db.select().from(jobs).where(and(eq(jobs.workspaceId, 'hard'), eq(jobs.id, id))).get()!;
  assert.equal(row.status, 'queued');
  db.delete(jobs).where(and(eq(jobs.workspaceId, 'hard'), eq(jobs.id, id))).run();
});

test('M6: editing on confirm records which fields moved, and no values', async () => {
  const d = await pendingDraft("I'll draft the summary.");
  scope.confirm(d.id, 'confirmed_with_edits', 'u-me', {
    title: 'A completely different title', outcome: d.outcome,
    suggestedOwner: d.suggestedOwner, suggestedDueDate: '2031-02-03',
  });
  const rows = db.select().from(auditEvents).where(eq(auditEvents.workspaceId, 'hard')).all();
  const edit = rows.find((r) => r.event === 'draft.edited');
  assert.ok(edit, 'an edit must be audited');
  assert.match(edit!.detail!, /title/);
  assert.match(edit!.detail!, /due_date/);
  assert.doesNotMatch(edit!.detail!, /completely different/);   // values never reach the audit log
});

test('M13: a nonsense detection threshold fails loudly instead of accepting everything', async () => {
  const before = process.env.SEROS_DETECT_THRESHOLD;
  process.env.SEROS_DETECT_THRESHOLD = 'high';
  const { row } = scope.ingestMessage({ channelId: 'C1', ts: String(Math.random()), authorId: 'u-me', body: 'Nice work everyone.' });
  scope.enqueue('detect', { messageId: row.id });
  await tick(db);                                   // the job fails rather than drafting
  const job = db.select().from(jobs).where(eq(jobs.workspaceId, 'hard')).all().find((j) => JSON.parse(j.payload).messageId === row.id)!;
  assert.notEqual(job.status, 'done');
  if (before === undefined) delete process.env.SEROS_DETECT_THRESHOLD; else process.env.SEROS_DETECT_THRESHOLD = before;
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
