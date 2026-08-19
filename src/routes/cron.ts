/**
 * The worker, for a platform that will not let you run one.
 *
 * Locally `npm run worker` is a loop that lives forever. On Vercel there are no
 * daemons, so the same `tick()` is driven by a scheduled request instead. The
 * endpoint is not public: it requires the platform's cron header or a shared
 * secret, and it refuses rather than working for a stranger.
 *
 * It is bounded by BOTH a job count and a wall clock, because a serverless
 * invocation has a hard ceiling and being killed mid-job is how a queue grows a
 * permanent backlog of half-done work.
 */
import type { Request, Response } from 'express';
import { openDb } from '../db/client';
import { tick } from '../worker';
import { reapStaleJobs } from '../db/system';
import { runMaintenance } from '../limits';

const cronSecret = () => process.env.CRON_SECRET || '';

function authorised(req: Request): boolean {
  // Vercel signs its own cron invocations with this header.
  const vercelCron = req.header('x-vercel-cron');
  if (vercelCron) return true;
  const secret = cronSecret();
  if (!secret) return false;                       // unset means closed, not open
  const given = req.header('authorization') || '';
  const expect = `Bearer ${secret}`;
  if (given.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= given.charCodeAt(i) ^ expect.charCodeAt(i);
  return diff === 0;
}

export async function cronDrain(req: Request, res: Response) {
  if (!authorised(req)) {
    console.log(JSON.stringify({ level: 'warn', event: 'cron.rejected' }));
    return res.status(401).json({ ok: false, error: 'unauthorised' });
  }

  const budgetMs = Number(process.env.CRON_BUDGET_MS || 20_000);
  const maxJobs = Number(process.env.CRON_MAX_JOBS || 25);
  const started = Date.now();
  const db = openDb();

  let done = 0;
  let failed = 0;
  reapStaleJobs(db);                               // anything a killed invocation left behind

  while (done < maxJobs && Date.now() - started < budgetMs) {
    let did = false;
    try {
      did = await tick(db);
    } catch (e: any) {
      failed++;
      console.error(JSON.stringify({ level: 'error', event: 'cron.tick_failed', error: String(e?.message ?? e) }));
    }
    if (!did) break;                               // queue is empty; stop early rather than spin
    done++;
  }

  try { runMaintenance(db); } catch { /* maintenance is best effort */ }

  const body = { ok: true, drained: done, failed, ms: Date.now() - started };
  console.log(JSON.stringify({ level: 'info', event: 'cron.drained', ...body }));
  return res.json(body);
}
