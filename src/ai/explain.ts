/**
 * EXPLAIN: one line on the queue card saying why this message was read as a
 * commitment.
 *
 * Computed ONCE, at draft time, in the worker - not on page load. The queue is the
 * page a human sits on all day; a model call per card per refresh would be a bill
 * that scales with how carefully someone reads. The line is stored beside the
 * draft (migration 0007_draft_reason.sql) and read back with the draft.
 *
 * It is decoration on a decision that has already been made, so it is allowed to
 * fail: `explainDraft` never throws and never retries. If the model is down, no
 * row is written, the card renders exactly as it does today, and drafting - the
 * thing that matters - is untouched.
 */
import type { openDb } from '../db/client';
import type { WorkspaceScope } from '../db/scope';
import { complete, dbMeterContext } from '../provider/index';
import { EXPLAIN_HARD_MAX_WORDS, EXPLAIN_PROMPT_VERSION, EXPLAIN_SYSTEM } from './prompts';
import { ExplainSchema } from './schemas';
import { esc } from '../views';

type Db = ReturnType<typeof openDb>;

/**
 * What storing a reason needs from a scope. Both methods are OPTIONAL because
 * src/db/scope.ts belongs to another change; until they land the reason is
 * computed and discarded rather than half-stored. The signatures wanted are:
 *
 *   setDraftReason(draftId: string, reason: string, promptVersion: string): void
 *   draftReasons(draftIds: string[]): Record<string, string>
 */
export type ReasonScope = Pick<WorkspaceScope, 'workspaceId' | 'audit'> & {
  setDraftReason?(draftId: string, reason: string, promptVersion: string): void;
  draftReasons?(draftIds: string[]): Record<string, string>;
};

export type ExplainWhy = 'provider_unavailable' | 'invalid_output' | 'budget_blocked' | 'too_long' | 'empty';

export interface ExplainResult {
  reason: string | null;
  why: ExplainWhy | null;
  meterId: number | null;
  promptVersion: string;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Model punctuation habits, removed before anything is measured or stored. */
export function tidy(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
    .slice(0, 200);
}

/**
 * Ask the model for the reason. One call, cheap tier, bounded output.
 * Returns `reason: null` on every failure, and the caller carries on.
 */
export async function explainCommitment(
  db: Db,
  workspaceId: string,
  input: { body: string; draftId?: string },
): Promise<ExplainResult> {
  const flat = { reason: null, meterId: null, promptVersion: EXPLAIN_PROMPT_VERSION };
  const body = input.body.trim();
  if (body.length === 0) return { ...flat, why: 'empty' };

  const meter = dbMeterContext(db, workspaceId);
  const res = await complete(meter, {
    tier: 'cheap',
    purpose: 'other',
    system: EXPLAIN_SYSTEM,
    user: body,
    promptVersion: EXPLAIN_PROMPT_VERSION,
    refType: 'draft',
    ...(input.draftId ? { refId: input.draftId } : {}),
    maxOutputTokens: 80,
  }, ExplainSchema);

  if (!res.ok || res.value === null) {
    const why: ExplainWhy =
      res.outcome === 'invalid_output' ? 'invalid_output'
      : res.outcome === 'budget_blocked' ? 'budget_blocked'
      : 'provider_unavailable';
    return { ...flat, why, meterId: res.meterId };
  }

  const reason = tidy(res.value.reason);
  if (reason.length === 0) return { ...flat, why: 'empty', meterId: res.meterId };
  // A card is one line. A model that wrote a paragraph did not do the job asked,
  // and a truncated clause reads like a bug, so the field is simply absent.
  if (words(reason) > EXPLAIN_HARD_MAX_WORDS) {
    return { ...flat, why: 'too_long', meterId: res.meterId };
  }
  return { reason, why: null, meterId: res.meterId, promptVersion: EXPLAIN_PROMPT_VERSION };
}

/**
 * The whole draft-time step, in one call for the worker: explain, store, audit.
 * NEVER throws - drafting must not fail because a decoration did.
 */
export async function explainDraft(
  db: Db,
  scope: ReasonScope,
  draftId: string,
  body: string,
): Promise<string | null> {
  try {
    const out = await explainCommitment(db, scope.workspaceId, { body, draftId });
    if (out.reason === null) {
      scope.audit('draft.reason_unavailable', 'failed', { draft_id: draftId, reason: out.why ?? 'unknown' });
      return null;
    }
    if (typeof scope.setDraftReason === 'function') {
      scope.setDraftReason(draftId, out.reason, out.promptVersion);
      // Words, not the words themselves: audit rows carry no content (invariant 14).
      scope.audit('draft.reason_stored', 'ok', { draft_id: draftId, words: words(out.reason) });
    }
    return out.reason;
  } catch (e: any) {
    console.log(JSON.stringify({
      level: 'warn', event: 'explain.failed', draft_id: draftId,
      error_class: e?.constructor?.name ?? 'Error',
    }));
    return null;
  }
}

/** Reasons for a page of drafts, or an empty map when the scope cannot serve them. */
export function reasonsFor(scope: ReasonScope, draftIds: string[]): Record<string, string> {
  if (typeof scope.draftReasons !== 'function' || draftIds.length === 0) return {};
  try { return scope.draftReasons(draftIds); } catch { return {}; }
}

/**
 * The queue card line. Absent field, empty string, and the card is byte-identical
 * to what it renders today.
 */
export const reasonLine = (reason: string | null | undefined): string =>
  reason ? `<p class="meta">Why: ${esc(reason)}</p>` : '';
