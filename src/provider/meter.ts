/**
 * The meter context: the only way to pay for a model call.
 *
 * Invariant 15/16: no provider call without an ActionMeter row carrying workspace,
 * purpose, model, token counts and estimated cost, written by the abstraction, and
 * the provider client refuses to run without this object. Invariant 18: the budget
 * hard stop is read here and enforced in `complete()` BEFORE the network call.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import type { openDb } from '../db/client';
import { actionMeter, workspaces } from '../db/schema';
import type { BudgetSnapshot, MeterContext, MeterRow } from './types';

type Db = ReturnType<typeof openDb>;

/** 1 currency unit = 1_000_000 micros, so 1 cent = 10_000 micros. */
export const MICROS_PER_CENT = 10_000;

export class UnknownBudgetWorkspace extends Error {}

export function startOfUtcDay(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
export function startOfUtcMonth(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Global daily spend cap (brief 18). 0 or unset = unlimited. */
function globalDailyBudgetCents(): number {
  const v = Number(process.env.SEROS_GLOBAL_DAILY_BUDGET_CENTS || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * A meter context backed by the real tables. One workspace, no ambient state,
 * no cross-tenant read except the deliberate global daily spend total (brief 22:
 * aggregate counts, never content).
 */
export function dbMeterContext(db: Db, workspaceId: string, now: () => number = Date.now): MeterContext {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new UnknownBudgetWorkspace('a meter context needs a workspace id');
  }
  return {
    workspaceId,
    async budget(): Promise<BudgetSnapshot> {
      const ws = (await db.select({
        daily: workspaces.dailyBudgetCents,
        monthly: workspaces.monthlyBudgetCents,
      }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0];
      if (!ws) throw new UnknownBudgetWorkspace(workspaceId);
      const t = now();
      const day = startOfUtcDay(t);
      const month = startOfUtcMonth(t);
      const sumFrom = async (since: number, scoped: boolean) => {
        const where = scoped
          ? and(eq(actionMeter.workspaceId, workspaceId), gte(actionMeter.at, since))
          : gte(actionMeter.at, since);
        const r = (await db.select({ total: sql<number>`coalesce(sum(${actionMeter.estimatedCostMicros}), 0)` })
          .from(actionMeter).where(where).limit(1))[0];
        return Number(r?.total ?? 0);
      };
      return {
        dailyBudgetCents: Number(ws.daily ?? 0),
        monthlyBudgetCents: Number(ws.monthly ?? 0),
        spentTodayMicros: await sumFrom(day, true),
        spentMonthMicros: await sumFrom(month, true),
        globalDailyBudgetCents: globalDailyBudgetCents(),
        spentGlobalTodayMicros: globalDailyBudgetCents() > 0 ? await sumFrom(day, false) : 0,
      };
    },
    async record(row: MeterRow): Promise<number> {
      const inserted = (await db.insert(actionMeter).values({
        workspaceId: row.workspaceId,
        purpose: row.purpose,
        outcome: row.outcome,
        at: row.at,
        tier: row.tier,
        provider: row.provider,
        model: row.model,
        promptVersion: row.promptVersion,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cachedInputTokens: row.cachedInputTokens,
        estimatedCostMicros: row.estimatedCostMicros,
        priceTableVersion: row.priceTableVersion,
        latencyMs: row.latencyMs,
        refType: row.refType,
        refId: row.refId,
        billableAction: row.billableAction ? 1 : 0,
      }).returning({ id: actionMeter.id }))[0];
      return Number(inserted?.id ?? 0);
    },
  };
}

export interface BudgetDecision {
  blocked: boolean;
  /** Which cap stopped the call, for the log line and the notice (invariant 19). */
  cap: 'daily' | 'monthly' | 'global_daily' | null;
  dailyPct: number;
  monthlyPct: number;
}

/**
 * 100% of a cap = hard stop. A cap of 0 means UNLIMITED, which is the existing
 * behaviour of `workspaces.daily_budget_cents` and is preserved deliberately.
 */
export function budgetDecision(snap: BudgetSnapshot): BudgetDecision {
  const dailyCap = Number(snap.dailyBudgetCents || 0) * MICROS_PER_CENT;
  const monthlyCap = Number(snap.monthlyBudgetCents || 0) * MICROS_PER_CENT;
  const globalCap = Number(snap.globalDailyBudgetCents || 0) * MICROS_PER_CENT;
  const dailyPct = dailyCap > 0 ? (snap.spentTodayMicros / dailyCap) * 100 : 0;
  const monthlyPct = monthlyCap > 0 ? (snap.spentMonthMicros / monthlyCap) * 100 : 0;

  let cap: BudgetDecision['cap'] = null;
  if (dailyCap > 0 && snap.spentTodayMicros >= dailyCap) cap = 'daily';
  else if (monthlyCap > 0 && snap.spentMonthMicros >= monthlyCap) cap = 'monthly';
  else if (globalCap > 0 && Number(snap.spentGlobalTodayMicros || 0) >= globalCap) cap = 'global_daily';

  return { blocked: cap !== null, cap, dailyPct, monthlyPct };
}

/** 50% record, 80% alert (invariant 18). Ids and numbers only, never content. */
export function budgetThresholdLog(workspaceId: string, before: BudgetDecision, after: BudgetDecision): void {
  const crossed = (pctBefore: number, pctAfter: number, mark: number) => pctBefore < mark && pctAfter >= mark;
  for (const mark of [50, 80]) {
    if (crossed(before.dailyPct, after.dailyPct, mark) || crossed(before.monthlyPct, after.monthlyPct, mark)) {
      console.log(JSON.stringify({
        level: mark >= 80 ? 'warn' : 'info',
        event: 'budget.threshold',
        workspace_id: workspaceId,
        threshold_pct: mark,
        daily_pct: Math.round(after.dailyPct),
        monthly_pct: Math.round(after.monthlyPct),
      }));
    }
  }
}
