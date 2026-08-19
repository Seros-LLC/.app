
/**
 * src/sweep.ts — the scheduled retention job (`npm run sweep`).
 * Runs the sweeper for every workspace, prints COUNTS ONLY, never content.
 * Exits non-zero if any workspace still has rows past its window (invariant 24: alert).
 */
import { migrateDb, openDb } from './db/client';
import { sweepAllWorkspaces } from './retention';

function main() {
  migrateDb();
  const db = openDb();
  const results = sweepAllWorkspaces(db);
  let stragglers = 0;
  for (const r of results) {
    stragglers += r.rowsPastWindowAfterSweep;
    console.log(JSON.stringify({
      workspace_id: r.workspaceId,
      retention_content_days: r.retentionContentDays,
      cutoff_at: r.cutoffAt,
      skipped: r.skipped,
      counts: r.counts,
      rows_past_window_after: r.rowsPastWindowAfterSweep,
    }));
  }
  console.log(JSON.stringify({ workspaces_swept: results.length, rows_past_window_after: stragglers }));
  if (stragglers > 0) process.exitCode = 1;
}

main();
