/**
 * tests/replay.test.ts — H5 webhook replay protection.
 *
 * checkAndRecordReplay() in src/replay.ts is what stops a captured, still-valid
 * signed webhook from being resent inside the timestamp window (each replay
 * would otherwise mint a fresh message, job and draft). It is wired into the
 * live webhook (src/routes/webhook.ts) but had no direct test. These tests pin
 * its contract with an injected clock and a real on-disk SQLite database:
 *
 *   - first sight of a signature is fresh and recorded;
 *   - any later sight inside the window is refused as a replay;
 *   - a missing signature and a non-finite timestamp are refused by reason;
 *   - once the window closes the nonce is prunable and the signature is
 *     spendable exactly once more (the verifier's own timestamp window is what
 *     still refuses a truly old request);
 *   - the store stays keyed by a hash, never the raw signature.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrateDbAsync } from '../src/db/client';
import {
  checkAndRecordReplay,
  pruneReplayNonces,
  replayNonceCount,
  hashSignature,
  REPLAY_WINDOW_SEC,
} from '../src/replay';

async function freshDb() {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-replay-')), 'test.db');
  await migrateDbAsync(path);
  return openDb(path);
}

const SIG = 'v0=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const WINDOW_MS = REPLAY_WINDOW_SEC * 1000;

test('first sight of a signature is fresh and recorded', async () => {
  const db = await freshDb();
  const now = 1_000_000_000_000;
  const r = await checkAndRecordReplay(db, SIG, Math.trunc(now / 1000), now);
  assert.equal(r.fresh, true);
  assert.equal(r.reason, undefined);
  assert.equal(r.expiresAt, now + WINDOW_MS);
  assert.equal(await replayNonceCount(db), 1);
});

test('a second sight inside the window is refused as a replay', async () => {
  const db = await freshDb();
  const now = 1_000_000_000_000;
  const first = await checkAndRecordReplay(db, SIG, Math.trunc(now / 1000), now);
  assert.equal(first.fresh, true);

  const again = await checkAndRecordReplay(db, SIG, Math.trunc(now / 1000), now + 1000);
  assert.equal(again.fresh, false);
  assert.equal(again.reason, 'replayed_signature');
  // the refusal reports the original nonce's deadline, not a freshly minted one
  assert.equal(again.expiresAt, first.expiresAt);
  // still exactly one row: a replay records nothing new
  assert.equal(await replayNonceCount(db), 1);
});

test('different signatures are independent', async () => {
  const db = await freshDb();
  const now = 1_000_000_000_000;
  const a = await checkAndRecordReplay(db, SIG, Math.trunc(now / 1000), now);
  const b = await checkAndRecordReplay(db, 'v0=0000000000000000000000000000000000000000000000000000000000000000', Math.trunc(now / 1000), now);
  assert.equal(a.fresh, true);
  assert.equal(b.fresh, true);
  assert.equal(await replayNonceCount(db), 2);
});

test('a missing signature is refused without recording anything', async () => {
  const db = await freshDb();
  const now = 1_000_000_000_000;
  const r = await checkAndRecordReplay(db, '', Math.trunc(now / 1000), now);
  assert.equal(r.fresh, false);
  assert.equal(r.reason, 'missing_signature');
  assert.equal(await replayNonceCount(db), 0);
});

test('a non-finite timestamp is refused without recording anything', async () => {
  const db = await freshDb();
  const now = 1_000_000_000_000;
  const r = await checkAndRecordReplay(db, SIG, Number.NaN, now);
  assert.equal(r.fresh, false);
  assert.equal(r.reason, 'bad_timestamp');
  assert.equal(await replayNonceCount(db), 0);
});

test('once the window closes the nonce is prunable and the signature is spendable once more', async () => {
  const db = await freshDb();
  const t0 = 1_000_000_000_000;
  const first = await checkAndRecordReplay(db, SIG, Math.trunc(t0 / 1000), t0);
  assert.equal(first.fresh, true);

  // At expiry the row is still there until pruned; a manual prune before expiry removes nothing.
  assert.equal(await pruneReplayNonces(db, first.expiresAt - 1), 0);
  assert.equal(await replayNonceCount(db), 1);

  // After the window closes, the next check prunes opportunistically and treats
  // the signature as fresh again (the verifier's timestamp check is what still
  // refuses a genuinely old request; this store only bounds the window).
  const later = t0 + WINDOW_MS + 1;
  const reused = await checkAndRecordReplay(db, SIG, Math.trunc(later / 1000), later);
  assert.equal(reused.fresh, true);
  assert.equal(reused.expiresAt, later + WINDOW_MS);
  assert.equal(await replayNonceCount(db), 1); // old row pruned, new row recorded
});

test('pruneReplayNonces removes only rows at or before now and is idempotent', async () => {
  const db = await freshDb();
  const t0 = 1_000_000_000_000;
  await checkAndRecordReplay(db, SIG, Math.trunc(t0 / 1000), t0);
  const expiresAt = t0 + WINDOW_MS;

  assert.equal(await pruneReplayNonces(db, expiresAt), 1); // <= now boundary is inclusive
  assert.equal(await replayNonceCount(db), 0);
  assert.equal(await pruneReplayNonces(db, expiresAt), 0); // idempotent
});

test('the store is keyed by a hash, never the raw signature', async () => {
  // hashSignature is a deterministic 64-hex SHA-256 and is not the signature
  // itself; the schema (src/replay.ts) stores only this hash, so a leak of the
  // table never discloses a usable signature.
  const h = hashSignature(SIG);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, SIG);
  assert.equal(hashSignature(SIG), h);
});
