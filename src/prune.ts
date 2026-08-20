/**
 * Scheduled cleaner for the webhook replay nonce store (H5).
 *
 * `npm run prune` — safe to run on a cron, safe to run twice, safe to never run
 * (checkAndRecordReplay prunes opportunistically too). Prints a content-free line.
 */
import { migrateDbAsync, openDb } from './db/client';
import { pruneReplayNonces, replayNonceCount } from './replay';

export async function pruneOnce(now: number = Date.now()) {
  // async on both dialects: the migration, the delete and the count are all
  // promises on Postgres, and a cleaner that does not wait cleans nothing.
  await migrateDbAsync(); // idempotent: CREATE TABLE IF NOT EXISTS, so the cleaner is safe on a cold db
  const db = openDb();
  const removed = await pruneReplayNonces(db, now);
  const remaining = await replayNonceCount(db);
  return { removed, remaining };
}

if (require.main === module) {
  pruneOnce().then(({ removed, remaining }) => {
    console.log(JSON.stringify({ level: 'info', event: 'replay.pruned', removed, remaining }));
  }).catch((err) => {
    console.error(JSON.stringify({ level: 'error', event: 'replay.prune_failed', error: String(err?.message ?? err) }));
    process.exitCode = 1;
  });
}
