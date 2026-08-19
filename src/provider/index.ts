/**
 * ADR 0004 boundary: ONE operation, no streaming, no tools, no vendor type escapes.
 * Tiers are named by role and mapped to concrete models in configuration
 * (`./pricing`), changeable without a deploy.
 *
 * What this module guarantees, structurally rather than by habit:
 *
 *  - It is the ONLY thing that opens a socket to a model API (invariant 16), and
 *    it REFUSES to run without a meter context - a required first argument, checked
 *    again at runtime before anything is spent.
 *  - The budget hard stop is evaluated INSIDE this abstraction, BEFORE the network
 *    call (invariant 18). At 100% of a cap the call is refused and metered
 *    `budget_blocked`; ingest, confirmation and tracker writes are untouched
 *    (invariant 19).
 *  - EVERY terminating path - ok, timeout, invalid_output, provider_error,
 *    budget_blocked - writes exactly one ActionMeter row in the same logical step
 *    as the result (invariants 15 and 17), carrying workspace, purpose, tier, model,
 *    prompt version, token counts, priced cost and the ref the call was made for.
 *  - A failed call NEVER invents an answer. On outage the caller gets
 *    `ok: false, value: null` and drafting queues (ADR 0004 §9, promise 5; H2).
 */
import { z } from 'zod';
import {
  assertMeterContext, InvalidOutput, MissingMeterContext, ProviderError, ProviderTimeout,
} from './types';
import type {
  CompleteRequest, CompleteResult, MeterContext, MeterOutcome, MeterRow, Purpose, Tier,
} from './types';
import { budgetDecision, budgetThresholdLog, dbMeterContext, MICROS_PER_CENT } from './meter';
import { estimateCostMicros, modelFor, priceTable, TIERS } from './pricing';
import { callQwen, estimateTokens, fakeComplete, fakeIsConfigured, runTransport, transportChain } from './transports';
import type { TransportResult } from './transports';

export type { CompleteRequest, CompleteResult, MeterContext, MeterOutcome, MeterRow, Purpose, Tier, BudgetSnapshot } from './types';
export { ProviderTimeout, ProviderError, InvalidOutput, MissingMeterContext, assertMeterContext } from './types';
export { dbMeterContext, budgetDecision, MICROS_PER_CENT, startOfUtcDay, startOfUtcMonth } from './meter';
export { priceTable, modelFor, estimateCostMicros, TIERS } from './pricing';
export type { PriceTable, TierPrice } from './pricing';

const maxInputChars = (req: CompleteRequest) =>
  req.maxInputChars ?? Number(process.env.SEROS_MAX_INPUT_CHARS || 8000);

/**
 * The only way the app talks to a model.
 *
 * @param meter  REQUIRED. Names the workspace being spent for, reads its budget,
 *               and writes the ActionMeter row. Build one with
 *               `dbMeterContext(db, workspaceId)`. There is no overload without it.
 */
export async function complete<T>(
  meter: MeterContext,
  req: CompleteRequest,
  schema: z.ZodType<T>,
): Promise<CompleteResult<T>> {
  // Before the budget read, before the socket, before anything is spent.
  assertMeterContext(meter);

  const started = Date.now();
  const table = priceTable();
  const model = modelFor(req.tier);
  const cap = maxInputChars(req);
  const bounded: CompleteRequest = {
    ...req,
    system: req.system.slice(0, cap),
    user: req.user.slice(0, cap),
  };

  let recorded = false;
  const before = budgetDecision(await meter.budget());

  /** Writes exactly one meter row and returns the result in the same step. */
  const settle = async (o: {
    outcome: MeterOutcome;
    provider: string;
    value: T | null;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    errorClass?: string;
  }): Promise<CompleteResult<T>> => {
    if (recorded) throw new Error('provider.complete: refusing to meter one call twice');
    recorded = true;
    const inputTokens = Math.max(0, Math.round(o.inputTokens ?? 0));
    const outputTokens = Math.max(0, Math.round(o.outputTokens ?? 0));
    const cachedInputTokens = Math.max(0, Math.round(o.cachedInputTokens ?? 0));
    const estimatedCostMicros = o.outcome === 'budget_blocked'
      ? 0
      : estimateCostMicros(req.tier, inputTokens, outputTokens, cachedInputTokens);
    const latencyMs = Date.now() - started;
    const row: MeterRow = {
      workspaceId: meter.workspaceId,
      purpose: req.purpose,
      outcome: o.outcome,
      at: Date.now(),
      tier: req.tier,
      provider: o.provider,
      model,
      promptVersion: req.promptVersion ?? null,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      estimatedCostMicros,
      priceTableVersion: table.version,
      latencyMs,
      refType: req.refType ?? null,
      refId: req.refId ?? null,
      billableAction: o.outcome !== 'budget_blocked',
    };
    const meterId = await meter.record(row);

    // 50% record / 80% alert, computed from the spend this call just added.
    const after = budgetDecision({
      ...(await meter.budget()),
    });
    budgetThresholdLog(meter.workspaceId, before, after);

    return {
      ok: o.outcome === 'ok',
      value: o.value,
      outcome: o.outcome,
      provider: o.provider,
      model,
      tier: req.tier,
      purpose: req.purpose,
      latencyMs,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      estimatedCostMicros,
      priceTableVersion: table.version,
      promptVersion: req.promptVersion ?? null,
      meterId,
      ...(o.errorClass ? { errorClass: o.errorClass } : {}),
    };
  };

  try {
    // ---- hard stop, BEFORE the network call (invariant 18) ----
    if (before.blocked) {
      console.log(JSON.stringify({
        level: 'warn', event: 'budget.blocked', workspace_id: meter.workspaceId,
        cap: before.cap, purpose: req.purpose, tier: req.tier,
      }));
      return await settle({ outcome: 'budget_blocked', provider: 'none', value: null });
    }

    // ---- the sockets, in order, until one answers ----
    // Still exactly one metered row: the chain is one logical call, and the
    // provider string records which link actually served it.
    const chain = transportChain();
    let tr: TransportResult | null = null;
    let lastKind: 'timeout' | 'provider_error' = 'provider_error';
    let lastError = 'Error';
    const tried: string[] = [];
    for (const link of chain) {
      try {
        tr = await runTransport(link, bounded, model);
        if (tried.length) tr = { ...tr, provider: `${tr.provider}(after:${tried.join('+')})` };
        break;
      } catch (e: any) {
        tried.push(link);
        lastKind = e?.kind === 'timeout' ? 'timeout' : 'provider_error';
        lastError = e?.constructor?.name ?? 'Error';
        console.log(JSON.stringify({ level: 'warn', event: 'provider.link_failed', link, error_class: lastError }));
      }
    }
    if (tr === null) {
      return await settle({
        outcome: lastKind,
        provider: `none(tried:${tried.join('+') || 'nothing'})`,
        value: null,                       // never a fabricated answer (H2)
        inputTokens: estimateTokens(bounded.system + bounded.user),
        outputTokens: 0,
        errorClass: lastError,
      });
    }

    // ---- schema validation is part of the same metered step ----
    let parsed: unknown;
    try {
      parsed = JSON.parse(tr.text);
    } catch {
      return await settle({
        outcome: 'invalid_output', provider: tr.provider, value: null,
        inputTokens: tr.inputTokens, outputTokens: tr.outputTokens,
        cachedInputTokens: tr.cachedInputTokens, errorClass: 'InvalidOutput',
      });
    }
    const check = schema.safeParse(parsed);
    if (!check.success) {
      return await settle({
        outcome: 'invalid_output', provider: tr.provider, value: null,
        inputTokens: tr.inputTokens, outputTokens: tr.outputTokens,
        cachedInputTokens: tr.cachedInputTokens, errorClass: 'InvalidOutput',
      });
    }
    return await settle({
      outcome: 'ok', provider: tr.provider, value: check.data,
      inputTokens: tr.inputTokens, outputTokens: tr.outputTokens,
      cachedInputTokens: tr.cachedInputTokens,
    });
  } catch (e: any) {
    // Nothing may leave this function unmetered.
    if (!recorded) {
      return await settle({
        outcome: 'provider_error',
        provider: fakeIsConfigured() ? 'fake' : `ollama:${model}`,
        value: null,
        inputTokens: estimateTokens(bounded.system + bounded.user),
        outputTokens: 0,
        errorClass: e?.constructor?.name ?? 'Error',
      });
    }
    throw e;
  }
}

export const DetectionSchema = z.object({
  isCommitment: z.boolean(),
  confidence: z.number().min(0).max(100),
  reason: z.string().max(200).optional().default(''),
});
export const DraftSchema = z.object({
  title: z.string().min(1).max(160),
  outcome: z.string().min(1).max(400),
  proposedOwner: z.string().nullable().default(null),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  confidence: z.number().min(0).max(100),
});
