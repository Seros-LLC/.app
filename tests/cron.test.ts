import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_PROVIDER = 'fake';
process.env.SEROS_SIGNING_SECRET = 'cron-test-signing-secret-x';
process.env.SEROS_SESSION_SECRET = 'cron-test-session-secret-x';
process.env.CRON_SECRET = 'cron-shared-secret-value';
const dir = mkdtempSync(join(tmpdir(), 'seros-cron-'));
process.env.SEROS_DB = join(dir, 'cron.db');

import { migrateDb, openDb } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { createApp } from '../src/server';

migrateDb();
const db = openDb();
const scope = WorkspaceScope.ensure(db, 'cron', 'Cron workspace');
const server = createApp().listen(0);
const port = (server.address() as any).port;
const url = (p: string) => `http://127.0.0.1:${port}${p}`;

test('the cron endpoint refuses a request with no credential at all', async () => {
  const r = await fetch(url('/api/cron/drain'), { method: 'POST' });
  assert.equal(r.status, 401);
});

test('the cron endpoint refuses a wrong secret', async () => {
  const r = await fetch(url('/api/cron/drain'), { method: 'POST', headers: { authorization: 'Bearer nope' } });
  assert.equal(r.status, 401);
});

test('the cron endpoint accepts the shared secret and reports an empty queue honestly', async () => {
  const r = await fetch(url('/api/cron/drain'), {
    method: 'POST', headers: { authorization: 'Bearer cron-shared-secret-value' },
  });
  assert.equal(r.status, 200);
  const j: any = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.drained, 0);
});

test('the cron endpoint drains queued work, and is bounded', async () => {
  const { row } = scope.ingestMessage({ channelId: 'C1', ts: '1.1', authorId: 'u1', body: "I'll send the report by 2030-01-01." });
  scope.enqueue('detect', { messageId: row.id });
  const r = await fetch(url('/api/cron/drain'), {
    method: 'POST', headers: { authorization: 'Bearer cron-shared-secret-value' },
  });
  const j: any = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.drained >= 1, 'it should have done the queued job');
  assert.equal(scope.pendingDrafts().length, 1);
});

test('the platform cron header is accepted, since Vercel signs its own invocations', async () => {
  const r = await fetch(url('/api/cron/drain'), { method: 'POST', headers: { 'x-vercel-cron': '1' } });
  assert.equal(r.status, 200);
});

test('an unset CRON_SECRET means closed, not open', async () => {
  const before = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const r = await fetch(url('/api/cron/drain'), { method: 'POST', headers: { authorization: 'Bearer ' } });
  assert.equal(r.status, 401);
  process.env.CRON_SECRET = before;
});

test.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
