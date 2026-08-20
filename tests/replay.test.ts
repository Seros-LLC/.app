/**
 * H5 — replay protection.
 *
 * The old defence was a 5 minute timestamp window and nothing else, so the same
 * signed bytes could be resent all window long and each replay produced a fresh
 * message, job and draft. These tests pin the nonce store that closes it.
 *
 * src/routes/webhook.ts is not touched here: this file mounts its own tiny
 * Express app that verifies the signature exactly the way the real route does
 * and then calls checkAndRecordReplay(), so the HTTP behaviour is real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

process.env.SEROS_PROVIDER = 'fake';
process.env.SEROS_SIGNING_SECRET = 'replay-test-signing-secret-long';
process.env.SEROS_SESSION_SECRET = 'replay-test-session-secret-long';
const dir = mkdtempSync(join(tmpdir(), 'seros-replay-'));
process.env.SEROS_DB = join(dir, 'replay.db');

import express from 'express';
import Database from 'better-sqlite3';
import { migrateDb, openDb } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { sign } from '../src/routes/webhook';
import {
  checkAndRecordReplay, pruneReplayNonces, replayNonceCount,
  hashSignature, webhookReplayNonces, REPLAY_WINDOW_SEC,
} from '../src/replay';

migrateDb();
const db = openDb();
// async on both drivers now, so the workspace is a module-level promise the
// request handler awaits (this file is CommonJS: no top-level await).
const scopeReady = WorkspaceScope.ensure(db, 'replay-ws', 'Replay workspace');

const MAX_AGE_SEC = 300;
const SECRET_TEXT = "I'll wire the payment to the new account tomorrow";

/**
 * The real route's verification, plus the one line this task exists to justify.
 * Deliberately a copy: the parent owns src/routes/webhook.ts.
 */
const app = express();
app.post('/api/slack/events', express.raw({ type: '*/*', limit: '128kb' }), async (req, res) => {
  const raw: string = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const sig = req.header('x-slack-signature');
  const ts = req.header('x-slack-request-timestamp');
  if (!sig || !ts) return res.status(401).json({ ok: false, error: 'missing_headers' });
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return res.status(401).json({ ok: false, error: 'bad_timestamp' });
  if (Date.now() / 1000 - tsNum > MAX_AGE_SEC) return res.status(401).json({ ok: false, error: 'stale_timestamp' });
  const expected = Buffer.from(sign(raw, ts));
  const given = Buffer.from(sig);
  if (expected.length !== given.length) return res.status(401).json({ ok: false, error: 'bad_signature' });
  if (!crypto.timingSafeEqual(expected, given)) return res.status(401).json({ ok: false, error: 'bad_signature' });

  // ---- the wiring under test ----
  if (!(await checkAndRecordReplay(db, sig, tsNum)).fresh) {
    return res.status(409).json({ ok: false, error: 'replayed_signature' });
  }

  const b = JSON.parse(raw);
  const ev = b.event ?? b;
  const scope = await scopeReady;
  const { row, created } = await scope.ingestMessage({
    channelId: ev.channel, ts: String(ev.ts), authorId: ev.user, body: String(ev.text ?? ''),
  });
  return res.json({ ok: true, messageId: row.id, deduped: !created });
});

const server = app.listen(0);
const port = (server.address() as any).port;
test.after(() => server.close());

type Signed = { body: string; headers: Record<string, string> };
function signedRequest(text: string, evTs?: string): Signed {
  const body = JSON.stringify({
    team_id: 'replay-ws',
    event: { channel: 'C-replay', ts: evTs ?? String(Math.random()), user: 'u-attacker', text },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sign(body, ts),
    },
  };
}
const post = (r: Signed) =>
  fetch(`http://127.0.0.1:${port}/api/slack/events`, { method: 'POST', headers: r.headers, body: r.body });

/** Direct row count, read through a second connection so nothing is cached. */
function rawTable(): Array<Record<string, unknown>> {
  const raw = new Database(process.env.SEROS_DB!, { readonly: true });
  const rows = raw.prepare('SELECT * FROM webhook_replay_nonces').all() as Array<Record<string, unknown>>;
  raw.close();
  return rows;
}
function sourceMessageCount(): number {
  const raw = new Database(process.env.SEROS_DB!, { readonly: true });
  const n = (raw.prepare('SELECT count(*) AS n FROM source_messages').get() as { n: number }).n;
  raw.close();
  return n;
}

test('H5a: the first signed request is accepted and an identical replay is refused', async () => {
  const req = signedRequest(SECRET_TEXT, 'ev-1.0001');
  const before = sourceMessageCount();

  const first = await post(req);
  assert.equal(first.status, 200);
  assert.equal((await first.json() as any).ok, true);

  for (let i = 0; i < 3; i++) {
    const replayed = await post(req); // the exact same bytes and the exact same signature
    assert.ok(replayed.status === 401 || replayed.status === 409,
      `replay must be refused, got ${replayed.status}`);
    assert.equal((await replayed.json() as any).error, 'replayed_signature');
  }

  // the whole point: three replays no longer multiply into three messages
  assert.equal(sourceMessageCount(), before + 1);
});

test('H5b: two different signed requests both succeed', async () => {
  const a = signedRequest('Different message A, I will send the report.', 'ev-2.0001');
  const b = signedRequest('Different message B, I will book the room.', 'ev-2.0002');
  assert.notEqual(a.headers['x-slack-signature'], b.headers['x-slack-signature']);

  const ra = await post(a);
  const rb = await post(b);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  assert.notEqual((await ra.json() as any).messageId, (await rb.json() as any).messageId);
});

test('H5c: a fresh signature is recorded once and refused thereafter (unit level)', async () => {
  const sig = 'v0=' + crypto.randomBytes(32).toString('hex');
  const ts = Math.floor(Date.now() / 1000);
  const first = await checkAndRecordReplay(db, sig, ts);
  assert.equal(first.fresh, true);
  assert.equal(first.reason, undefined);
  assert.equal((await checkAndRecordReplay(db, sig, ts)).fresh, false);
  assert.equal((await checkAndRecordReplay(db, sig, ts)).reason, 'replayed_signature');
});

test('H5d: an empty signature or an unusable timestamp is never fresh', async () => {
  assert.deepEqual((await checkAndRecordReplay(db, '', 1)).reason, 'missing_signature');
  assert.deepEqual((await checkAndRecordReplay(db, 'v0=abc', Number.NaN)).reason, 'bad_timestamp');
});

test('H5e: expired entries are pruned, pruning is idempotent, and the store stays bounded', async () => {
  const now = Date.now();
  const long_ago = now - (REPLAY_WINDOW_SEC * 1000) - 60_000;

  // 200 signatures seen well outside the window
  for (let i = 0; i < 200; i++) {
    const sig = 'v0=' + crypto.randomBytes(32).toString('hex');
    assert.equal((await checkAndRecordReplay(db, sig, Math.floor(long_ago / 1000), long_ago)).fresh, true);
  }
  assert.ok(await replayNonceCount(db) >= 200);

  const removed = await pruneReplayNonces(db, now);
  assert.ok(removed >= 200, `expected >=200 pruned, got ${removed}`);
  // idempotent: a second prune with the same clock removes nothing and throws nothing
  assert.equal(await pruneReplayNonces(db, now), 0);
  assert.equal(await pruneReplayNonces(db, now), 0);

  // an expired signature is spendable again — the store is a window, not a ledger
  const old_sig = 'v0=' + crypto.randomBytes(32).toString('hex');
  const t0 = now - (REPLAY_WINDOW_SEC * 1000) - 10_000;
  assert.equal((await checkAndRecordReplay(db, old_sig, Math.floor(t0 / 1000), t0)).fresh, true);
  assert.equal((await checkAndRecordReplay(db, old_sig, Math.floor(t0 / 1000), t0)).fresh, false);
  assert.equal((await checkAndRecordReplay(db, old_sig, Math.floor(now / 1000), now)).fresh, true);

  // bounded: 500 more inserts, all expired, leave the table at window size, not traffic size
  const settled = await replayNonceCount(db);
  for (let i = 0; i < 500; i++) {
    await checkAndRecordReplay(db, 'v0=' + crypto.randomBytes(32).toString('hex'),
      Math.floor(long_ago / 1000), long_ago);
  }
  await pruneReplayNonces(db, now);
  assert.ok((await replayNonceCount(db)) <= settled + 1,
    `store grew without bound: ${await replayNonceCount(db)} vs ${settled}`);
});

test('H5f: the store holds a hash only — never message text, never the raw signature', async () => {
  const req = signedRequest(SECRET_TEXT, 'ev-3.0001');
  await post(req);
  const rows = rawTable();
  assert.ok(rows.length > 0);

  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(SECRET_TEXT), 'message text leaked into the nonce store');
  assert.ok(!dump.includes('wire the payment'), 'message text leaked into the nonce store');
  assert.ok(!dump.includes('u-attacker'), 'author id leaked into the nonce store');
  assert.ok(!dump.includes('C-replay'), 'channel id leaked into the nonce store');
  assert.ok(!dump.includes(req.headers['x-slack-signature']!), 'raw signature stored in the clear');

  // the only text column is a 64 char sha256 hex digest
  const sigHash = hashSignature(req.headers['x-slack-signature']!);
  const stored = rows.find((r) => r['signature_hash'] === sigHash);
  assert.ok(stored, 'the signature hash should be the key');
  assert.match(String(stored!['signature_hash']), /^[0-9a-f]{64}$/);

  // and the columns are exactly the four content-free ones
  assert.deepEqual(Object.keys(stored!).sort(),
    ['expires_at', 'request_ts', 'seen_at', 'signature_hash']);
});

test('H5g: the drizzle table declaration matches the migrated table', () => {
  const rows = db.select().from(webhookReplayNonces).all();
  assert.ok(Array.isArray(rows));
  for (const r of rows) {
    assert.equal(typeof r.signatureHash, 'string');
    assert.equal(typeof r.expiresAt, 'number');
  }
});
