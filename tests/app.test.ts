import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_PROVIDER = 'fake';          // deterministic, offline
process.env.SEROS_SIGNING_SECRET = 'test-secret';

const dir = mkdtempSync(join(tmpdir(), 'seros-test-'));
process.env.SEROS_DB = join(dir, 'test.db');

import { migrateDb, openDb } from '../src/db/client';
import { WorkspaceScope, UnknownWorkspace } from '../src/db/scope';
import { createApp } from '../src/server';
import { sign } from '../src/routes/webhook';
import { tick } from '../src/worker';
import { tasks, auditEvents } from '../src/db/schema';
import { eq } from 'drizzle-orm';

migrateDb();
const db = openDb();
const server = createApp().listen(0);
const port = (server.address() as any).port;
const url = (p: string) => `http://127.0.0.1:${port}${p}`;

function postEvent(text: string, opts: { secret?: string; ts?: string; team?: string } = {}) {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ team_id: opts.team ?? 'T-test', event: { type: 'message', channel: 'C1', ts: String(Math.random()), user: 'u-ana', text } });
  return fetch(url('/api/slack/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts,
               'x-slack-signature': sign(body, ts, opts.secret ?? 'test-secret') },
    body,
  });
}

test('health responds', async () => {
  const r = await fetch(url('/health'));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('webhook: valid signature is accepted', async () => {
  const r = await postEvent("I'll send the deck by Thursday.");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('webhook: wrong secret is rejected 401', async () => {
  const r = await postEvent('anything', { secret: 'wrong-secret' });
  assert.equal(r.status, 401);
});

test('webhook: stale timestamp is rejected 401', async () => {
  const r = await postEvent('anything', { ts: String(Math.floor(Date.now() / 1000) - 6000) });
  assert.equal(r.status, 401);
});

test('webhook: missing headers rejected 401', async () => {
  const r = await fetch(url('/api/slack/events'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
});

test('ingest is idempotent on (workspace, channel, ts)', () => {
  const s = WorkspaceScope.ensure(db, 'T-dedupe');
  const a = s.ingestMessage({ channelId: 'C1', ts: '111.1', authorId: 'u1', body: 'hello' });
  const b = s.ingestMessage({ channelId: 'C1', ts: '111.1', authorId: 'u1', body: 'hello' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.row.id, b.row.id);
});

test('worker turns a commitment into a pending draft', async () => {
  const s = WorkspaceScope.ensure(db, 'T-worker');
  const { row } = s.ingestMessage({ channelId: 'C1', ts: '222.2', authorId: 'u-ana', body: "I'll ship the billing fix by Friday." });
  s.enqueue('detect', { messageId: row.id });
  while (await tick(db)) { /* drain */ }
  const pending = s.pendingDrafts();
  assert.equal(pending.length, 1);
  assert.ok(pending[0]!.title.length > 0);
});

test('worker discards a non-commitment', async () => {
  const s = WorkspaceScope.ensure(db, 'T-nocommit');
  const { row } = s.ingestMessage({ channelId: 'C1', ts: '333.3', authorId: 'u-bo', body: 'Nice work on the release everyone.' });
  s.enqueue('detect', { messageId: row.id });
  while (await tick(db)) { /* drain */ }
  assert.equal(s.pendingDrafts().length, 0);
});

test('INVARIANT: a task cannot exist without a confirmation', async () => {
  const s = WorkspaceScope.ensure(db, 'T-invariant');
  s.addMember('u-me', 'Me');
  const { row } = s.ingestMessage({ channelId: 'C1', ts: '444.4', authorId: 'u-ana', body: "I'll fix the login bug tomorrow." });
  s.enqueue('detect', { messageId: row.id });
  while (await tick(db)) { /* drain */ }
  const draft = s.pendingDrafts()[0]!;

  // no confirmation yet -> no task row at all
  let all = db.select().from(tasks).where(eq(tasks.workspaceId, 'T-invariant')).all();
  assert.equal(all.length, 0);

  // the schema itself forbids it: confirmation_id is required and unique
  assert.throws(() => {
    db.insert(tasks).values({ workspaceId: 'T-invariant', id: 'x', confirmationId: null as any,
      writeState: 'queued', threadReplyState: 'pending', idempotencyKey: 'x', createdAt: Date.now() }).run();
  });

  const r = s.confirm(draft.id, 'confirmed', 'u-me');
  assert.equal(r.ok, true);
  all = db.select().from(tasks).where(eq(tasks.workspaceId, 'T-invariant')).all();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.confirmationId, (r as any).confirmationId);
});

test('confirm is single-shot; a second confirm is refused', async () => {
  const s = WorkspaceScope.ensure(db, 'T-once');
  s.addMember('u-me', 'Me');
  const { row } = s.ingestMessage({ channelId: 'C1', ts: '555.5', authorId: 'u-ana', body: "I'll review the PR by Monday." });
  s.enqueue('detect', { messageId: row.id });
  while (await tick(db)) {}
  const draft = s.pendingDrafts()[0]!;
  const first = s.confirm(draft.id, 'confirmed', 'u-me');
  const second = s.confirm(draft.id, 'confirmed', 'u-me');
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(db.select().from(tasks).where(eq(tasks.workspaceId, 'T-once')).all().length, 1);
});

test('tracker write is idempotent: draining twice creates one task', async () => {
  const s = WorkspaceScope.ensure(db, 'T-idem');
  s.addMember('u-me', 'Me');
  const { row } = s.ingestMessage({ channelId: 'C1', ts: '666.6', authorId: 'u-ana', body: "I'll send the invoice tomorrow." });
  s.enqueue('detect', { messageId: row.id });
  while (await tick(db)) {}
  const draft = s.pendingDrafts()[0]!;
  const r: any = s.confirm(draft.id, 'confirmed', 'u-me');
  while (await tick(db)) {}
  s.enqueue('tracker_write', { confirmationId: r.confirmationId });   // replay
  while (await tick(db)) {}
  const all = db.select().from(tasks).where(eq(tasks.workspaceId, 'T-idem')).all();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.writeState, 'created');
});

test('confirmation by an unknown member is refused', async () => {
  const s = WorkspaceScope.ensure(db, 'T-member');
  const { row } = s.ingestMessage({ channelId: 'C1', ts: '777.7', authorId: 'u-ana', body: "I'll update the docs by Wednesday." });
  s.enqueue('detect', { messageId: row.id });
  while (await tick(db)) {}
  const draft = s.pendingDrafts()[0]!;
  const r = s.confirm(draft.id, 'confirmed', 'u-ghost');
  assert.equal(r.ok, false);
  assert.equal((r as any).reason, 'no_such_member');
});

test('tenancy: a scope cannot see another workspace, and cannot be opened for a missing one', () => {
  const a = WorkspaceScope.ensure(db, 'T-a');
  const b = WorkspaceScope.ensure(db, 'T-b');
  const m = a.ingestMessage({ channelId: 'C1', ts: '888.8', authorId: 'u1', body: 'private to A' });
  assert.ok(a.messageById(m.row.id));
  assert.equal(b.messageById(m.row.id), undefined);
  assert.throws(() => WorkspaceScope.open(db, 'T-does-not-exist'), UnknownWorkspace);
});

test('audit log records the confirmation and never stores content', () => {
  const rows = db.select().from(auditEvents).where(eq(auditEvents.workspaceId, 'T-once')).all();
  assert.ok(rows.some((r) => r.event === 'draft.confirmed'));
  for (const r of rows) assert.ok(!/review the PR/i.test(r.detail ?? ''));
});

test.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
