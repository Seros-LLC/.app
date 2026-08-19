/**
 * Scheduled cleaner for the webhook replay nonce store (H5).
 *
 * `npm run prune` — safe to run on a cron, safe to run twice, safe to never run
 * (checkAndRecordReplay prunes opportunistically too). Prints a content-free line.
 */
import { migrateDb, openDb } from './db/client';
import { pruneReplayNonces, replayNonceCount } from './replay';

export function pruneOnce(now: number = Date.now()) {
  migrateDb(); // idempotent: CREATE TABLE IF NOT EXISTS, so the cleaner is safe on a cold db
  const db = openDb();
  const removed = pruneReplayNonces(db, now);
  const remaining = replayNonceCount(db);
  return { removed, remaining };
}

if (require.main === module) {
  const { removed, remaining } = pruneOnce();
  console.log(JSON.stringify({ level: 'info', event: 'replay.pruned', removed, remaining }));
}
