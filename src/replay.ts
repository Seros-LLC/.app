/**
 * H5 — replay protection for signed webhooks.
 *
 * A timestamp window alone is not replay protection: inside the window the same
 * captured bytes can be resent forever, and each replay creates a fresh message,
 * a fresh job and a fresh draft. This module is the missing nonce store.
 *
 * The key is a SHA-256 hash of the exact signature header and nothing else.
 * No body, no message text, no author, no channel, no workspace ever reaches
 * this table (see IMPLEMENTATION-BRIEF: content-free by construction), and the
 * signature itself is not stored in the clear either.
 *
 * Every entry point here is async (the drizzle handle is asynchronous on
 * Postgres) and safe to run twice.
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { eq, lte, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import type { openDb } from './db/client';
import { affectedRows } from './db/client';

type Db = ReturnType<typeof openDb>;

/** Mirrors migrations/0003_replay_nonce.sql. Declared here so this module is self-contained. */
export const webhookReplayNonces = sqliteTable('webhook_replay_nonces', {
  /** sha256(signature), hex. Never the signature itself, never the body. */
  signatureHash: text('signature_hash').primaryKey(),
  /** Epoch SECONDS, exactly as carried by the signed X-Slack-Request-Timestamp header. */
  requestTs: integer('request_ts').notNull(),
  /** Epoch MILLIS when this signature was first seen. */
  seenAt: integer('seen_at').notNull(),
  /** Epoch MILLIS after which the row is dead and prunable. */
  expiresAt: integer('expires_at').notNull(),
}, (t) => [index('webhook_replay_nonces_expires_at').on(t.expiresAt)]);

/** Must be >= the verifier's MAX_AGE_SEC, or a request could outlive its nonce. */
export const REPLAY_WINDOW_SEC = Number(process.env.SEROS_REPLAY_WINDOW_SEC || 300);

export type ReplayCheck = {
  /** true = first sight, recorded, caller may process. false = replay, refuse. */
  fresh: boolean;
  /** Machine-readable refusal reason; absent when fresh. */
  reason?: 'replayed_signature' | 'missing_signature' | 'bad_timestamp';
  /** Epoch millis this nonce expires (or expired). */
  expiresAt: number;
};

/** sha256 of the signature header, hex. Fixed length, so comparisons are length-stable. */
export function hashSignature(signature: string): string {
  return crypto.createHash('sha256').update(signature, 'utf8').digest('hex');
}

/** Equal-length, constant-time hex compare. Never throws on odd input. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

/** Delete every nonce whose window has closed.
 *
 * Cheap (single indexed range delete on expires_at) and idempotent: running it
 * twice, or never, changes nothing but the row count. Returns rows removed.
 */
export async function pruneReplayNonces(db: Db, now: number = Date.now()): Promise<number> {
  const res = await db.delete(webhookReplayNonces)
    .where(lte(webhookReplayNonces.expiresAt, now));
  return affectedRows(res);
}

/** Rows currently held. Test/ops helper — proves the store stays bounded. */
export async function replayNonceCount(db: Db): Promise<number> {
  const row = (await db.select({ n: sql<number>`count(*)` }).from(webhookReplayNonces).limit(1))[0];
  return Number(row?.n ?? 0);
}

/**
 * Spend a signature. First sight records it and returns { fresh: true };
 * any later sight of the same signature inside the window returns
 * { fresh: false, reason: 'replayed_signature' } and the caller must refuse
 * (401 or 409) WITHOUT processing the body.
 *
 * Wire it into the webhook in one line, after signature verification succeeds:
 *   if (!(await checkAndRecordReplay(db, sig, tsNum)).fresh) return res.status(409)...
 *
 * @param db            an open drizzle handle (openDb())
 * @param signature     the exact signature header value (e.g. 'v0=<hex>')
 * @param timestampSec  the signed request timestamp, in epoch SECONDS
 * @param now           epoch millis, injectable for tests
 */
export async function checkAndRecordReplay(
  db: Db,
  signature: string,
  timestampSec: number,
  now: number = Date.now(),
): Promise<ReplayCheck> {
  const windowMs = REPLAY_WINDOW_SEC * 1000;
  const expiresAt = now + windowMs;

  if (typeof signature !== 'string' || signature.length === 0) {
    return { fresh: false, reason: 'missing_signature', expiresAt };
  }
  if (!Number.isFinite(timestampSec)) {
    return { fresh: false, reason: 'bad_timestamp', expiresAt };
  }

  // Opportunistic prune first: keeps the table bounded by the window, not by
  // traffic, and makes a long-expired nonce reusable exactly once again.
  await pruneReplayNonces(db, now);

  const signatureHash = hashSignature(signature);

  // Atomic claim: the PRIMARY KEY decides the race, not a read-then-write.
  const res = await db.insert(webhookReplayNonces).values({
    signatureHash,
    requestTs: Math.trunc(timestampSec),
    seenAt: now,
    expiresAt,
  }).onConflictDoNothing();

  if (affectedRows(res) === 1) {
    return { fresh: true, expiresAt };
  }

  // Lost the claim: a live nonce already holds this signature. Confirm it in
  // constant time over the fixed-length hashes before refusing.
  const existing = (await db.select().from(webhookReplayNonces)
    .where(eq(webhookReplayNonces.signatureHash, signatureHash)).limit(1))[0];

  if (existing && sameHash(existing.signatureHash, signatureHash)) {
    return { fresh: false, reason: 'replayed_signature', expiresAt: existing.expiresAt };
  }
  // Row vanished between insert and read (concurrent prune): still refuse.
  return { fresh: false, reason: 'replayed_signature', expiresAt };
}
