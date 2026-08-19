/**
 * DIGEST: what happened today in this workspace, and what did not.
 *
 * The split is the whole design. EVERY NUMBER ON THE PAGE IS COMPUTED IN CODE from
 * the rows that were retrieved (src/ai/retrieve.ts); the model writes only prose,
 * is told never to state a count, and prose that states one anyway is thrown away.
 * A summary whose arithmetic can be wrong is worse than no summary, because nobody
 * can tell which half to trust.
 *
 * Cost: one model call per (workspace, day, counts) - a refresh does not buy a
 * second one, and a workspace nobody touched costs nothing at all. The cache is
 * in-process and small on purpose: it is a spend guard, not a datastore.
 *
 * Writes nothing but an audit row of counts. No draft, no confirmation, no task.
 */
import type { openDb } from '../db/client';
import { complete, dbMeterContext } from '../provider/index';
import { DIGEST_PROMPT_VERSION, DIGEST_SYSTEM, digestUser } from './prompts';
import { DigestProseSchema } from './schemas';
import { factsBlock, isEmpty, retrieve } from './retrieve';
import type { ReadScope, Retrieved } from './retrieve';

type Db = ReturnType<typeof openDb>;

export type DigestDegradeReason =
  | 'no_data'
  | 'provider_unavailable'
  | 'invalid_output'
  | 'budget_blocked'
  | 'numbers_in_prose';

export interface DigestResult {
  retrieved: Retrieved;
  /** Written by the model, or absent. The counts do not depend on it. */
  prose: { headline: string; summary: string } | null;
  why: DigestDegradeReason | null;
  meterId: number | null;
  modelCalled: boolean;
  servedFromCache: boolean;
}

/**
 * Counting words the model is not allowed to use. Digits are refused outright
 * (an ISO date is the one exception, because a date is not a count). "one" and
 * "both" are deliberately absent: "no one has confirmed it" is prose, not
 * arithmetic, and a false rejection costs a reader their summary.
 */
const NUMBER_WORDS = new Set([
  'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'dozen', 'couple',
]);

export function statesANumber(text: string): boolean {
  const withoutDates = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  if (/\d/.test(withoutDates)) return true;
  for (const w of withoutDates.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (NUMBER_WORDS.has(w)) return true;
  }
  return false;
}

// ---- the spend guard -------------------------------------------------------
const CACHE_TTL_MS = () => Number(process.env.SEROS_DIGEST_CACHE_MS || 5 * 60 * 1000);
const CACHE_MAX = 200;
type Entry = { at: number; prose: DigestResult['prose']; why: DigestResult['why'] };
const cache = new Map<string, Entry>();

/** Same workspace, same day, same counts, same answer - and no second call. */
const fingerprint = (r: Retrieved) => [
  r.workspaceId, r.today, r.counts.waiting, r.counts.confirmed, r.counts.confirmedToday,
  r.counts.expired, r.counts.overdue, r.rows[0]?.id ?? '-', r.rows.length,
].join('|');

export function clearDigestCache() { cache.clear(); }

export async function digest(
  db: Db,
  scope: ReadScope,
  opts: { now?: number; noCache?: boolean } = {},
): Promise<DigestResult> {
  const retrieved = await retrieve(scope, opts);
  const flat = { retrieved, meterId: null, modelCalled: false, servedFromCache: false };

  if (isEmpty(retrieved)) {
    // A day with no work in it does not need a paragraph about having no work in it.
    scope.audit('digest.no_data', 'ok', { rows: 0 });
    return { ...flat, prose: null, why: 'no_data' };
  }

  const key = fingerprint(retrieved);
  const hit = cache.get(key);
  if (!opts.noCache && hit && Date.now() - hit.at < CACHE_TTL_MS()) {
    return { ...flat, prose: hit.prose, why: hit.why, servedFromCache: true };
  }

  const meter = dbMeterContext(db, scope.workspaceId);
  const res = await complete(meter, {
    tier: 'cheap',
    purpose: 'other',
    system: DIGEST_SYSTEM,
    user: digestUser(factsBlock(retrieved), retrieved.today),
    promptVersion: DIGEST_PROMPT_VERSION,
    refType: 'digest',
    maxOutputTokens: 300,
  }, DigestProseSchema);

  const remember = (prose: DigestResult['prose'], why: DigestResult['why']): DigestResult => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), prose, why });
    return { retrieved, prose, why, meterId: res.meterId, modelCalled: true, servedFromCache: false };
  };

  if (!res.ok || res.value === null) {
    const why: DigestDegradeReason =
      res.outcome === 'invalid_output' ? 'invalid_output'
      : res.outcome === 'budget_blocked' ? 'budget_blocked'
      : 'provider_unavailable';
    scope.audit('digest.degraded', 'failed', { reason: why, provider_outcome: res.outcome });
    return remember(null, why);
  }

  if (statesANumber(res.value.headline) || statesANumber(res.value.summary)) {
    // The numbers on this page come from the database. A second set, written by a
    // model, is not a nicer sentence: it is a contradiction waiting to be believed.
    scope.audit('digest.prose_rejected', 'denied', { reason: 'numbers_in_prose' });
    return remember(null, 'numbers_in_prose');
  }

  scope.audit('digest.written', 'ok', {
    waiting: retrieved.counts.waiting, confirmed_today: retrieved.counts.confirmedToday,
    expired: retrieved.counts.expired, overdue: retrieved.counts.overdue,
  });
  return remember({ headline: res.value.headline, summary: res.value.summary }, null);
}
