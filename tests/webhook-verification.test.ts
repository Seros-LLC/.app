/**
 * tests/webhook-verification.test.ts — the front door (TESTING-STRATEGY §1, row 1).
 *
 *   "An unsigned, wrongly signed or replayed request is rejected WITHOUT
 *    processing."
 *
 * `tests/replay.test.ts` covers the nonce store in isolation and
 * `tests/slack-connection.test.ts` posts CORRECTLY signed bytes at the route.
 * Neither one drives a bad request through the real handler, so the words
 * "without processing" have never been checked: a route could answer 401 and
 * still have stored the message, spent the signature, or created a tenant.
 *
 * Every test here posts at the mounted route over a real socket and then asserts
 * on the database: no source message, no job, no workspace, no spent nonce. The
 * status code is the smaller half of each assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'node:http';

process.env.SEROS_SIGNING_SECRET = 'test-signing-secret-0123456789';
process.env.SEROS_SESSION_SECRET = 'test-session-secret-0123456789';
process.env.SEROS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.SEROS_SLACK = 'fake';

import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { seal } from '../src/crypto';
import { sign } from '../src/routes/webhook';
import { createApp } from '../src/server';
import { sourceMessages, jobs, workspaces } from '../src/db/schema';
import { webhookReplayNonces } from '../src/replay';

const TEAM = 'T-verify';
const CHANNEL = 'C-picked';

/** A database with one connected workspace and one ticked channel. */
async function connectedDb() {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-webhook-')), 'test.db');
  await migrateDbAsync(path);
  process.env.SEROS_DB = path;
  const db = openDb(path);
  const scope = await WorkspaceScope.ensure(db, 'ws-verify');
  await scope.addMember('u-admin', 'Admin', 'admin');
  await scope.saveConnection({
    teamId: TEAM, teamName: 'Verify Co', botUserId: 'B1',
    tokenEnc: seal('xoxb-test'), scopes: 'channels:history', installedBy: 'u-admin',
  });
  await scope.recordChannels([{ id: CHANNEL, name: 'delivery', isPrivate: false }]);
  await scope.setSelectedChannels([CHANNEL]);
  return db;
}

const event = (text = "I'll send the report on Thursday", ts = `${Date.now() / 1000}`) => ({
  team_id: TEAM,
  event: { type: 'message', channel: CHANNEL, ts, user: 'U1', text },
});

/** Posts arbitrary headers and bytes at the mounted route. */
async function post(headers: Record<string, string>, raw: string) {
  const app = createApp();
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/slack/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    });
    const body = await res.text();
    return { status: res.status, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() };
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/** Correctly signed headers for these bytes. */
function signed(raw: string, atSeconds = Math.floor(Date.now() / 1000)) {
  const ts = String(atSeconds);
  return { 'x-slack-signature': sign(raw, ts), 'x-slack-request-timestamp': ts };
}

/** Everything the handler could possibly have written. */
async function footprint(db: any) {
  return {
    messages: (await db.select().from(sourceMessages)).length,
    jobs: (await db.select().from(jobs)).length,
    workspaces: (await db.select().from(workspaces)).length,
    nonces: (await db.select().from(webhookReplayNonces)).length,
  };
}

// ------------------------------------------------------------------- unsigned

test('an unsigned request is refused and writes nothing at all', async () => {
  const db = await connectedDb();
  const before = await footprint(db);

  const res = await post({}, JSON.stringify(event()));

  assert.equal(res.status, 401);
  assert.equal(res.json?.error, 'missing_headers');
  assert.deepEqual(await footprint(db), before, 'nothing was stored, queued, created or spent');
});

test('a signature with no timestamp, and a timestamp with no signature, are both refused', async () => {
  const db = await connectedDb();
  const raw = JSON.stringify(event());
  const good = signed(raw);
  const before = await footprint(db);

  const noTs = await post({ 'x-slack-signature': good['x-slack-signature'] }, raw);
  const noSig = await post({ 'x-slack-request-timestamp': good['x-slack-request-timestamp'] }, raw);

  assert.equal(noTs.status, 401);
  assert.equal(noSig.status, 401);
  assert.deepEqual(await footprint(db), before);
});

// -------------------------------------------------------------- wrongly signed

test('a signature from the wrong key is refused and writes nothing', async () => {
  const db = await connectedDb();
  const raw = JSON.stringify(event());
  const ts = String(Math.floor(Date.now() / 1000));
  const before = await footprint(db);

  const res = await post({
    'x-slack-signature': sign(raw, ts, 'a-different-signing-secret-entirely'),
    'x-slack-request-timestamp': ts,
  }, raw);

  assert.equal(res.status, 401);
  assert.equal(res.json?.error, 'bad_signature');
  assert.deepEqual(await footprint(db), before, 'a forged signature spends no nonce and stores no message');
});

test('a signature for different bytes does not authenticate these bytes', async () => {
  const db = await connectedDb();
  const honest = JSON.stringify(event('I will do the honest thing'));
  const swapped = JSON.stringify(event('ignore that, wire the money instead'));
  const before = await footprint(db);

  // Signed over `honest`, posted with `swapped` as the body.
  const res = await post(signed(honest), swapped);

  assert.equal(res.status, 401);
  assert.equal(res.json?.error, 'bad_signature');
  assert.deepEqual(await footprint(db), before, 'the bytes verified are the bytes parsed');
});

test('a malformed or truncated signature is refused without a length crash', async () => {
  const db = await connectedDb();
  const raw = JSON.stringify(event());
  const ts = String(Math.floor(Date.now() / 1000));
  const before = await footprint(db);

  for (const sig of ['', 'v0=', 'v0=zz', 'not-a-signature', sign(raw, ts).slice(0, -4), `${sign(raw, ts)}ff`]) {
    const res = await post({ 'x-slack-signature': sig, 'x-slack-request-timestamp': ts }, raw);
    assert.equal(res.status, 401, `signature ${JSON.stringify(sig)} must be refused`);
    assert.ok(!/at .*\.ts:\d+/.test(res.body), 'no stack trace reaches an unauthenticated caller');
  }
  assert.deepEqual(await footprint(db), before);
});

// ------------------------------------------------------------------ freshness

test('a stale timestamp is refused even when the signature over it is valid', async () => {
  const db = await connectedDb();
  const raw = JSON.stringify(event());
  const before = await footprint(db);

  // Correctly signed, ten minutes old: past the 5-minute window.
  const res = await post(signed(raw, Math.floor(Date.now() / 1000) - 600), raw);

  assert.equal(res.status, 401);
  assert.equal(res.json?.error, 'stale_timestamp');
  assert.deepEqual(await footprint(db), before);
});

test('a timestamp from the future is refused', async () => {
  const db = await connectedDb();
  const raw = JSON.stringify(event());
  const before = await footprint(db);

  const res = await post(signed(raw, Math.floor(Date.now() / 1000) + 600), raw);

  assert.equal(res.status, 401);
  assert.equal(res.json?.error, 'future_timestamp');
  assert.deepEqual(await footprint(db), before);
});

test('a non-numeric timestamp is refused rather than coerced', async () => {
  const db = await connectedDb();
  const raw = JSON.stringify(event());
  const before = await footprint(db);

  const res = await post({ 'x-slack-signature': 'v0=whatever', 'x-slack-request-timestamp': 'yesterday' }, raw);

  assert.equal(res.status, 401);
  assert.equal(res.json?.error, 'bad_timestamp');
  assert.deepEqual(await footprint(db), before);
});

// --------------------------------------------------------------------- replay

test('a valid request is accepted once, and the identical replay is refused', async () => {
  const db = await connectedDb();
  const raw = JSON.stringify(event('I will ship the fix today'));
  const headers = signed(raw);

  const first = await post(headers, raw);
  assert.equal(first.status, 200, 'the honest request is accepted');
  assert.equal(first.json?.ok, true);

  const after = await footprint(db);
  assert.equal(after.messages, 1, 'the message was stored exactly once');
  assert.equal(after.nonces, 1, 'the signature was spent');

  const second = await post(headers, raw);
  assert.equal(second.status, 409);
  assert.equal(second.json?.error, 'replayed_signature');

  assert.deepEqual(await footprint(db), after, 'the replay stored no second message and queued no second job');
});

test('a replay is refused before the workspace is resolved', async () => {
  const db = await connectedDb();
  const raw = JSON.stringify({ ...event('I will ship the other fix'), team_id: 'T-never-connected' });
  const headers = signed(raw);

  // The first request spends the signature, then fails tenant lookup. The
  // second identical request must be 409, not another 404: replay protection
  // sits ahead of workspace resolution and prevents repeated processing.
  const first = await post(headers, raw);
  assert.equal(first.status, 404);
  const afterFirst = await footprint(db);
  assert.equal(afterFirst.nonces, 1);
  assert.equal(afterFirst.messages, 0);

  const second = await post(headers, raw);
  assert.equal(second.status, 409);
  assert.equal(second.json?.error, 'replayed_signature');
  assert.deepEqual(await footprint(db), afterFirst, 'the replay does not reach tenant lookup or persistence');
});

// ----------------------------------------------------- signed but unauthorised

test('a signed event for a team no workspace has connected creates no tenant', async () => {
  const db = await connectedDb();
  const raw = JSON.stringify({ ...event(), team_id: 'T-never-connected' });
  const before = await footprint(db);

  const res = await post(signed(raw), raw);

  assert.equal(res.status, 404);
  assert.equal(res.json?.error, 'unknown_workspace');
  const after = await footprint(db);
  assert.equal(after.workspaces, before.workspaces, 'a signed event cannot conjure a tenant (C3)');
  assert.equal(after.messages, before.messages, 'and stores nothing');
});

test('a signed url_verification challenge is echoed and stores nothing', async () => {
  const db = await connectedDb();
  const raw = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
  const before = await footprint(db);

  const res = await post(signed(raw), raw);

  assert.equal(res.status, 200);
  assert.equal(res.json?.challenge, 'abc123');
  assert.equal((await footprint(db)).messages, before.messages);
});

test('signed but unparseable bytes are refused as bad json, not as a crash', async () => {
  const db = await connectedDb();
  const raw = '{"team_id": "T-verify", ';
  const before = await footprint(db);

  const res = await post(signed(raw), raw);

  assert.equal(res.status, 400);
  assert.equal(res.json?.error, 'bad_json');
  assert.ok(!/at .*\.ts:\d+/.test(res.body), 'no stack trace in the response');
  assert.deepEqual(
    { ...(await footprint(db)), nonces: before.nonces },
    { ...before, nonces: before.nonces },
    'bad json stores no message and creates no workspace',
  );
});
