import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_PROVIDER = 'fake';
process.env.SEROS_SIGNING_SECRET = 'sec-test-signing-secret-long';
process.env.SEROS_SESSION_SECRET = 'sec-test-session-secret-long';
process.env.SEROS_WORKSPACE = 'sec';
process.env.SEROS_ALLOW_PASSWORDLESS = '0';
process.env.SEROS_SCRYPT_N = '4096';
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

const PASSWORDS: Record<string, string> = {
  'u-owner': 'owner-password-for-the-security-suite',
  'u-viewer': 'viewer-password-for-the-security-suite',
};

// Opening the workspace, adding a member and writing a credential are all async
// (they are promises on Postgres) and this file is CommonJS, so the fixtures are
// a module-level promise that every caller awaits rather than a floating
// top-level statement that may not have landed yet.
const fixturesReady = (async () => {
  const scope = await WorkspaceScope.ensure(db, 'sec', 'Security workspace');
  await scope.addMember('u-owner', 'Owner', 'owner');
  await scope.addMember('u-viewer', 'Viewer', 'viewer');
  const credentials = MemberCredentials.for(db, scope);
  for (const [id, pw] of Object.entries(PASSWORDS)) await credentials.setPassword(id, hashPasswordSync(pw));
  return scope;
})();

const server = createApp().listen(0);
const port = (server.address() as any).port;
const url = (p: string) => `http://127.0.0.1:${port}${p}`;

async function login(username: string): Promise<string> {
  await fixturesReady;
  const password = PASSWORDS[username];
  if (!password) throw new Error(`no fixture password for ${username}`);
  const res = await fetch(url('/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identifier: username, password }),
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  return cookie.split(';')[0] ?? '';
}

async function tokenFrom(cookie: string): Promise<string> {
  const res = await fetch(url('/login'), { headers: { cookie } });
  const html = await res.text();
  return /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
}

test('CRITICAL 3: a signed event for an unknown workspace cannot conjure a tenant', async () => {
  await fixturesReady;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ team_id: 'T-victim-corp', event: { type: 'message', channel: 'C1', ts: '1.1', user: 'u', text: "I'll do it" } });
  const r = await fetch(url('/api/slack/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts,
               'x-slack-signature': sign(body, ts, 'sec-test-signing-secret-long') },
    body,
  });
  assert.equal(r.status, 404);
  await assert.rejects(() => WorkspaceScope.open(db, 'T-victim-corp'));
});

test.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });