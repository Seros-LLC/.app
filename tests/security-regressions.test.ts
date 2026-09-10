/** Regression tests for confirmed security findings from the 2026-09 audit. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_SESSION_SECRET = 'test-session-secret-security-123456';
process.env.SEROS_SIGNING_SECRET = 'test-signing-secret-security-123456';
process.env.CRON_SECRET = 'test-cron-secret-security-123456';

import { cronDrain } from '../src/routes/cron';
import { migrateDbAsync, openDb } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { claimNextJobAsync, finishJobAsync, reapStaleJobsAsync, retryJobAsync } from '../src/db/system';
import { callHttp } from '../src/provider/transports';
import type { CompleteRequest } from '../src/provider/types';

const HTTP_REQUEST: CompleteRequest = { system: 'Return JSON.', user: 'Return {"ok":true}.', tier: 'cheap', purpose: 'detect' };

async function seedConfirmedTask(db: any, workspaceId: string) {
  const scope = await WorkspaceScope.ensure(db, workspaceId);
  await scope.addMember('member-1', 'Member', 'confirmer');
  const msg = await scope.ingestMessage({ channelId: 'channel-1', ts: String(Date.now()), authorId: 'member-1', body: 'I will send the report' });
  const draftId = await scope.createDraft({
    sourceMessageId: msg.row.id, title: 'Send report', outcome: 'Report sent', kind: 'commitment', confidence: 90,
    suggestedOwner: 'member-1', suggestedDueDate: null, provider: 'fake',
  });
  const confirmed: any = await scope.confirm(draftId, 'confirmed', 'member-1');
  return { scope, taskId: confirmed.taskId as string };
}

test('a spoofed x-vercel-cron header never authorizes the cron endpoint', async () => {
  let status = 200;
  let body: unknown;
  const res: any = {
    status: (n: number) => { status = n; return res; },
    json: (v: unknown) => { body = v; return res; },
  };
  await cronDrain({ header: (name: string) => name === 'x-vercel-cron' ? 'anything' : '' } as any, res);
  assert.equal(status, 401);
  assert.deepEqual(body, { ok: false, error: 'unauthorised' });
});

test('an invalid job lease duration fails closed instead of reaping live jobs', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-security-')), 'test.db');
  await migrateDbAsync(path);
  const db = openDb(path);
  const previous = process.env.SEROS_JOB_LEASE_MS;
  process.env.SEROS_JOB_LEASE_MS = '-1';
  try {
    await assert.rejects(() => reapStaleJobsAsync(db), /SEROS_JOB_LEASE_MS/);
  } finally {
    if (previous === undefined) delete process.env.SEROS_JOB_LEASE_MS;
    else process.env.SEROS_JOB_LEASE_MS = previous;
  }
});

test('a running job is not reaped just because it waited in the queue before claim', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-security-')), 'test.db');
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await WorkspaceScope.ensure(db, 'ws-stale-regression');
  const id = await scope.enqueue('detect', { messageId: 'message-1' });
  const old = Date.now() - 3 * 60 * 60 * 1000;
  await db.run(require('drizzle-orm').sql`UPDATE jobs SET run_at = ${old} WHERE workspace_id = ${scope.workspaceId} AND id = ${id}`);

  const claimed = await claimNextJobAsync(db, ['detect']);
  assert.ok(claimed);
  assert.equal(await reapStaleJobsAsync(db), 0);
  assert.equal(await claimNextJobAsync(db, ['detect']), null);
});

test('a legacy running job without claimed_at is requeued during upgrade recovery', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-security-')), 'test.db');
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await WorkspaceScope.ensure(db, 'ws-legacy-job');
  const id = await scope.enqueue('detect', { messageId: 'message-1' });
  await db.run(require('drizzle-orm').sql`UPDATE jobs SET status = 'running', claimed_at = NULL WHERE workspace_id = ${scope.workspaceId} AND id = ${id}`);
  assert.equal(await reapStaleJobsAsync(db), 1);
  assert.ok(await claimNextJobAsync(db, ['detect']));
});

test('a stale task-write holder cannot release or complete its successor claim', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-security-')), 'test.db');
  await migrateDbAsync(path);
  const db = openDb(path);
  const { scope, taskId } = await seedConfirmedTask(db, 'ws-lease-regression');
  const first: any = await scope.claimTaskWrite(taskId, 1);
  assert.equal(first.state, 'claimed');
  await new Promise((resolve) => setTimeout(resolve, 3));
  const second: any = await scope.claimTaskWrite(taskId, 1);
  assert.equal(second.state, 'claimed');
  await scope.releaseTaskWrite(taskId, first.token);
  assert.equal(await scope.completeTaskWrite(taskId, first.token, { tracker: 'fake', externalId: 'stale', externalUrl: 'https://tracker.invalid/stale' }), false);
  const row: any = await scope.taskWrite(taskId);
  assert.equal(row?.state, 'claimed');
  assert.equal(row?.claimToken, second.token);
  const task = (await scope.recentTasks(10)).find((item: any) => item.id === taskId);
  assert.equal(task?.writeState, 'queued');
});

test('a reaped job holder cannot finish or retry its successor claim', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-security-')), 'test.db');
  await migrateDbAsync(path);
  const db = openDb(path);
  const scope = await WorkspaceScope.ensure(db, 'ws-job-fence');
  const id = await scope.enqueue('detect', { messageId: 'message-1' });
  const first = await claimNextJobAsync(db, ['detect']);
  assert.ok(first);
  await db.run(require('drizzle-orm').sql`UPDATE jobs SET claimed_at = ${Date.now() - 10_000} WHERE workspace_id = ${scope.workspaceId} AND id = ${id}`);
  assert.equal(await reapStaleJobsAsync(db, 1), 1);
  const second = await claimNextJobAsync(db, ['detect']);
  assert.ok(second);

  assert.equal(await finishJobAsync(db, first), false);
  assert.equal(await retryJobAsync(db, first), false);
  assert.equal(await finishJobAsync(db, second), true);
});

test('hosted provider requests refuse redirects after the allowed origin', async () => {
  const previousBase = process.env.SEROS_PROVIDER_BASE_URL;
  const previousKey = process.env.SEROS_PROVIDER_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.SEROS_PROVIDER_BASE_URL = 'https://provider.invalid/v1';
  process.env.SEROS_PROVIDER_API_KEY = 'test-key';
  let redirectMode: RequestRedirect | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    redirectMode = init?.redirect;
    return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
  }) as typeof fetch;
  try {
    await assert.rejects(() => callHttp(HTTP_REQUEST, 'test-model'));
    assert.equal(redirectMode, 'error');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBase === undefined) delete process.env.SEROS_PROVIDER_BASE_URL;
    else process.env.SEROS_PROVIDER_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.SEROS_PROVIDER_API_KEY;
    else process.env.SEROS_PROVIDER_API_KEY = previousKey;
  }
});
