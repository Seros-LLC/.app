/**
 * ASK: a plain-English question about this workspace's own work.
 *
 * The order is the point. Rows are retrieved through WorkspaceScope FIRST; the
 * model is then asked to answer USING ONLY those rows, and its answer is checked
 * against them afterwards. Three things follow:
 *
 *  - An empty retrieval never reaches the model. No rows, no call, no bill.
 *  - An answer that names an id it was not given is DISCARDED, not shown. The
 *    check is `citedIds` plus a scan of the prose itself, because a model that
 *    invents a task tends to write the id into the sentence.
 *  - A failed or malformed call degrades to the retrieved rows rendered plainly.
 *    The reader still gets their answer; they just read it themselves.
 *
 * This module reads and explains. It writes no draft, no confirmation and no task,
 * and there is no code path here that could: the only write is an audit row of
 * counts.
 */
import type { openDb } from '../db/client';
import { complete, dbMeterContext } from '../provider/index';
import { ASK_PROMPT_VERSION, ASK_SYSTEM, askUser } from './prompts';
import { AskAnswerSchema } from './schemas';
import {
  factsBlock, idSet, isEmpty, normaliseQuestion, retrieve, rowsById,
} from './retrieve';
import type { MemberRow, ReadScope, Retrieved, WorkRow } from './retrieve';

type Db = ReturnType<typeof openDb>;

export type AskDegradeReason =
  | 'provider_unavailable'    // timeout, provider_error
  | 'invalid_output'          // the answer did not fit the schema
  | 'budget_blocked'          // the workspace is at its cap
  | 'unknown_citation';       // the answer named work that was not retrieved

export type AskOutcome =
  | { kind: 'no_question' }
  | { kind: 'no_data' }
  | { kind: 'answered'; answer: string; cited: WorkRow[]; citedMembers: MemberRow[] }
  | { kind: 'degraded'; why: AskDegradeReason; providerOutcome: string };

export interface AskResult {
  question: string;
  retrieved: Retrieved;
  outcome: AskOutcome;
  /** Present exactly when the model was called. Proof, not a promise. */
  meterId: number | null;
  modelCalled: boolean;
}

/** Any id-shaped token in the prose, e.g. a task id the model made up. */
const ID_IN_TEXT = /\b(?:draft|task|member):[A-Za-z0-9._:-]+/g;

/** Every id named anywhere in the answer must be an id we retrieved. */
export function citationsWithin(answer: string, cited: string[], allowed: Set<string>): boolean {
  for (const id of cited) if (!allowed.has(id)) return false;
  for (const m of answer.match(ID_IN_TEXT) ?? []) if (!allowed.has(m)) return false;
  return true;
}

export async function ask(
  db: Db,
  scope: ReadScope,
  rawQuestion: unknown,
  opts: { now?: number } = {},
): Promise<AskResult> {
  const question = normaliseQuestion(rawQuestion);
  const retrieved = await retrieve(scope, opts);
  const base = { question, retrieved, meterId: null, modelCalled: false };

  if (question.length === 0) {
    return { ...base, outcome: { kind: 'no_question' } };
  }
  // Nothing retrieved, nothing to answer from: the model is never asked (and never
  // billed) to have an opinion about an empty workspace.
  if (isEmpty(retrieved)) {
    await scope.audit('ask.no_data', 'ok', { rows: 0, question_chars: question.length });
    return { ...base, outcome: { kind: 'no_data' } };
  }

  const meter = dbMeterContext(db, scope.workspaceId);
  const res = await complete(meter, {
    tier: 'standard',
    purpose: 'other',
    system: ASK_SYSTEM,
    user: askUser(factsBlock(retrieved), question),
    promptVersion: ASK_PROMPT_VERSION,
    refType: 'ask',
    maxOutputTokens: 400,
  }, AskAnswerSchema);

  if (!res.ok || res.value === null) {
    const why: AskDegradeReason =
      res.outcome === 'invalid_output' ? 'invalid_output'
      : res.outcome === 'budget_blocked' ? 'budget_blocked'
      : 'provider_unavailable';
    await scope.audit('ask.degraded', 'failed', { reason: why, provider_outcome: res.outcome, rows: retrieved.rows.length });
    return {
      question, retrieved, meterId: res.meterId, modelCalled: true,
      outcome: { kind: 'degraded', why, providerOutcome: res.outcome },
    };
  }

  const allowed = idSet(retrieved);
  if (!citationsWithin(res.value.answer, res.value.citedIds, allowed)) {
    // The answer referred to work this workspace did not hand it. There is no
    // version of that which is safe to show, so it is thrown away whole.
    await scope.audit('ask.citation_rejected', 'denied', {
      reason: 'unknown_citation', cited: res.value.citedIds.length, rows: retrieved.rows.length,
    });
    return {
      question, retrieved, meterId: res.meterId, modelCalled: true,
      outcome: { kind: 'degraded', why: 'unknown_citation', providerOutcome: res.outcome },
    };
  }

  const byId = rowsById(retrieved);
  const memberById = new Map(retrieved.members.map((m) => [`member:${m.id}`, m]));
  const cited: WorkRow[] = [];
  const citedMembers: MemberRow[] = [];
  for (const id of res.value.citedIds) {
    const row = byId.get(id);
    if (row && !cited.includes(row)) { cited.push(row); continue; }
    const mem = memberById.get(id);
    if (mem && !citedMembers.includes(mem)) citedMembers.push(mem);
  }

  await scope.audit('ask.answered', 'ok', {
    rows: retrieved.rows.length, cited: cited.length, question_chars: question.length,
  });
  return {
    question, retrieved, meterId: res.meterId, modelCalled: true,
    outcome: { kind: 'answered', answer: res.value.answer, cited, citedMembers },
  };
}
