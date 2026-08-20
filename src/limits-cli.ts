
/**
 * src/limits-cli.ts — the maintenance pass for M7/M3 (`npm run limits`).
 *
 * Expires stale pending drafts for every workspace, then prints where each workspace
 * stands against its caps. COUNTS AND IDS ONLY, never content.
 * Exits non-zero if any workspace is at or past a cap (invariant 24's alerting shape:
 * a cap that is biting is something a human must see).
 */
import { migrateDbAsync, openDb } from './db/client';
import { runMaintenance, draftTtlDays, maxQueuedJobs, maxPendingDrafts } from './limits';

async function main() {
  await migrateDbAsync();
  const db = openDb();
  const { expired, counts } = await runMaintenance(db);

  let draftsExpired = 0;
  for (const e of expired) {
    draftsExpired += e.counts.drafts_expired;
    if (e.counts.drafts_expired === 0) continue;
    console.log(JSON.stringify({
      workspace_id: e.workspaceId, event: 'drafts.expired',
      ttl_days: e.ttlDays, cutoff_at: e.cutoffAt,
      drafts_expired: e.counts.drafts_expired,
      confirmations_created: e.confirmationsCreated, tasks_created: e.tasksCreated,
    }));
  }

  let exceeded = 0;
  for (const c of counts) {
    exceeded += c.exceeded.length;
    console.log(JSON.stringify({
      workspace_id: c.workspaceId, event: 'limits.counts',
      counts: c.counts, limits: c.limits, exceeded: c.exceeded,
    }));
  }

  console.log(JSON.stringify({
    event: 'limits.done', workspaces: counts.length, drafts_expired: draftsExpired,
    workspaces_at_a_cap: exceeded,
    config: { draft_ttl_days: draftTtlDays(), max_queued_jobs: maxQueuedJobs(), max_pending_drafts: maxPendingDrafts() },
  }));
  if (exceeded > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'error', event: 'limits.failed', error: String(err?.message ?? err) }));
  process.exitCode = 1;
});
