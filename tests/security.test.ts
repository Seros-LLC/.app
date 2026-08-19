import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_PROVIDER = 'fake';
process.env.SEROS_SIGNING_SECRET = 'sec-test-signing-secret-long';
process.env.SEROS_SESSION_SECRET = 'sec-test-session-secret-long';
process.env.SEROS_WORKSPACE = 'sec';
process.env.SEROS_ALLOW_PASSWORDLESS = '0';   // there is no password-less path left to disable
process.env.SEROS_SCRYPT_N = '4096';          // real scrypt, small enough for a suite that signs in often
const dir = mkdtempSync(join(tmpdir(), 'seros-sec-'));
process.env.SEROS_DB = join(dir, 'sec.db');

import { migrateDb, openDb } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { createApp } from '../src/server';
import { sign } from '../src/routes/webhook';
import { tick } from '../src/worker';
import { claimNextJob } from '../src/db/system';
import { tasks, confirmations } from '../src/db/schema';
import { MemberCredentials, hashPasswordSync } from '../src/password';
import { eq } from 'drizzle-orm';

migrateDb();
const db = openDb();
const scope = WorkspaceScope.ensure(db, 'sec', 'Security workspace');
scope.addMember('u-owner', 'Owner', 'owner');
scope.addMember('u-viewer', 'Viewer', 'viewer');

// A session costs a secret now. These two are the only members with one, and the
// password is what login() proves below; nothing else in this file changes.
const PASSWORDS: Record<string, string> = {
  'u-owner': 'owner-password-for-the-security-suite',
  'u-viewer': 'viewer-password-for-the-security-suite',
};
const credentials = MemberCredentials.for(db, scope);
for (const [id, pw] of Object.entries(PASSWORDS)) credentials.setPassword(id, hashPasswordSync(pw));

const server = createApp().listen(0);
const port = (server.address() as any).port;
const url = (p: string) => `http://127.0.0.1:${port}${p}`;

async function login(memberId: string): Promise<string> {
  const r = await fetch(url('/login'), {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identifier: memberId, password: PASSWORDS[memberId] ?? '' }).toString(),
  });
  assert.equal(r.status, 303, `sign-in for ${memberId} was refused`);
  const c = r.headers.get('set-cookie') ?? '';
  return c.split(';')[0]!;
}
async function tokenFrom(cookie: string): Promise<string> {
  const html = await (await fetch(url('/demo'), { headers: { cookie } })).text();
  return /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
}
async function makeDraft(): Promise<string> {
  const { row } = scope.ingestMessage({ channelId: 'C1', ts: String(Math.random()), authorId: 'u-owner', body: "I'll send the report by 2030-01-01." });
  scope.enqueue('detect', { messageId: row.id });
  while (await tick(db)) { /* drain */ }
  return scope.pendingDrafts()[0]!.id;
}

test('CRITICAL 1a: an anonymous request cannot reach the queue', async () => {
  const r = await fetch(url('/queue'), { redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/login');
});

test('CRITICAL 1b: an anonymous POST cannot confirm anything', async () => {
  const draftId = await makeDraft();
  const r = await fetch(url('/confirm'), {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
    body: new URLSearchParams({ draftId, decision: 'confirm' }).toString(),
  });
  assert.equal(r.status, 303);
  assert.equal(db.select().from(confirmations).where(eq(confirmations.draftId, draftId)).all().length, 0);
});

test('CRITICAL 1c: a session without a CSRF token is refused', async () => {
  const draftId = await makeDraft();
  const cookie = await login('u-owner');
  const r = await fetch(url('/confirm'), {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ draftId, decision: 'confirm' }).toString(),
  });
  assert.equal(r.status, 403);
  assert.equal(db.select().from(confirmations).where(eq(confirmations.draftId, draftId)).all().length, 0);
});

test('a forged CSRF token from another session is refused', async () => {
  const draftId = await makeDraft();
  const cookie = await login('u-owner');
  const other = await tokenFrom(await login('u-viewer'));
  const r = await fetch(url('/confirm'), {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ draftId, decision: 'confirm', csrf: other }).toString(),
  });
  assert.equal(r.status, 403);
});

test('a full, correct confirmation still works end to end', async () => {
  const draftId = await makeDraft();
  const cookie = await login('u-owner');
  const csrf = await tokenFrom(cookie);
  const r = await fetch(url('/confirm'), {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ draftId, decision: 'confirm', csrf }).toString(),
  });
  assert.equal(r.status, 303);
  const c = db.select().from(confirmations).where(eq(confirmations.draftId, draftId)).get();
  assert.ok(c);
  assert.equal(c!.memberId, 'u-owner');
});

test('a viewer may look but may not confirm', async () => {
  const draftId = await makeDraft();
  const cookie = await login('u-viewer');
  const csrf = await tokenFrom(cookie);
  const r = await fetch(url('/confirm'), {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ draftId, decision: 'confirm', csrf }).toString(),
  });
  assert.equal(r.status, 403);
  assert.equal(db.select().from(confirmations).where(eq(confirmations.draftId, draftId)).all().length, 0);
});

test('CRITICAL 3: a signed event for an unknown workspace cannot conjure a tenant', async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ team_id: 'T-victim-corp', event: { type: 'message', channel: 'C1', ts: '1.1', user: 'u', text: "I'll do it" } });
  const r = await fetch(url('/api/slack/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts,
               'x-slack-signature': sign(body, ts, 'sec-test-signing-secret-long') },
    body,
  });
  assert.equal(r.status, 404);
  assert.throws(() => WorkspaceScope.open(db, 'T-victim-corp'));
});

test('CRITICAL 4: the bytes that are verified are the bytes that are parsed', async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const signed = JSON.stringify({ team_id: 'sec', event: { type: 'message', channel: 'C9', ts: '9.9', user: 'u', text: 'signed body' } });
  // sign one body, send a different one
  const r = await fetch(url('/api/slack/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts,
               'x-slack-signature': sign(signed, ts, 'sec-test-signing-secret-long') },
    body: 'text=unsigned+body&team_id=sec',
  });
  assert.equal(r.status, 401);
});

test('CRITICAL 5a: a task with a dangling confirmation id is refused by the database', () => {
  assert.throws(() => {
    db.insert(tasks).values({
      workspaceId: 'sec', id: 'orphan', confirmationId: 'does-not-exist',
      writeState: 'queued', threadReplyState: 'pending', idempotencyKey: 'x', createdAt: Date.now(),
    }).run();
  }, /FOREIGN KEY/i);
});

test('CRITICAL 5b: a confirmation by a non-member is refused by the database', () => {
  assert.throws(() => {
    db.insert(confirmations).values({
      workspaceId: 'sec', draftId: 'whatever', id: 'c-bad', decision: 'confirmed',
      surface: 'web', memberId: 'service-account', createdAt: Date.now(),
    }).run();
  }, /FOREIGN KEY/i);
});

test('CRITICAL 2: two claimants never receive the same job', () => {
  const id = scope.enqueue('detect', { messageId: 'nope' });
  const a = claimNextJob(db, ['detect']);
  const b = claimNextJob(db, ['detect']);
  assert.ok(a);
  assert.equal(a!.id, id);
  assert.equal(b, null);
});

test('L2: a decision that is neither confirm nor reject is rejected, not treated as confirm', async () => {
  const draftId = await makeDraft();
  const cookie = await login('u-owner');
  const csrf = await tokenFrom(cookie);
  const r = await fetch(url('/confirm'), {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ draftId, decision: 'banana', csrf }).toString(),
  });
  assert.equal(r.status, 400);
  assert.equal(db.select().from(confirmations).where(eq(confirmations.draftId, draftId)).all().length, 0);
});

test('L1: the same person confirming twice gets the same confirmation, not an error', async () => {
  const draftId = await makeDraft();
  const cookie = await login('u-owner');
  const csrf = await tokenFrom(cookie);
  const body = new URLSearchParams({ draftId, decision: 'confirm', csrf }).toString();
  const headers = { 'content-type': 'application/x-www-form-urlencoded', cookie };
  const first = await fetch(url('/confirm'), { method: 'POST', redirect: 'manual', headers, body });
  const second = await fetch(url('/confirm'), { method: 'POST', redirect: 'manual', headers, body });
  assert.equal(first.status, 303);
  assert.equal(second.status, 303);                        // a double-click is not an error
  assert.match(second.headers.get('location')!, /Already%20confirmed/);
  assert.equal(db.select().from(confirmations).where(eq(confirmations.draftId, draftId)).all().length, 1);
  assert.equal(db.select().from(tasks).where(eq(tasks.workspaceId, 'sec')).all()
    .filter((t) => t.confirmationId === db.select().from(confirmations).where(eq(confirmations.draftId, draftId)).get()!.id).length, 1);
});

test('the rate limiter actually blocks a flood', async () => {
  let blocked = 0;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(url('/login'), {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ memberId: 'u-owner' }).toString(),
    });
    if (r.status === 429) blocked++;
  }
  assert.ok(blocked > 0, 'expected some requests to be rate limited');
});

test.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
