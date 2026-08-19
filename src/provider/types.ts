/**
 * ADR 0004 boundary: the shape of the ONE operation, and the meter context it
 * refuses to run without (IMPLEMENTATION-BRIEF invariants 15-18).
 *
 * Nothing in here talks to a network or a database: types and errors only.
 */

export type Tier = 'cheap' | 'standard' | 'careful';
export type Purpose = 'detect' | 'draft' | 'route' | 'replay' | 'other';
export type MeterOutcome = 'ok' | 'timeout' | 'invalid_output' | 'provider_error' | 'budget_blocked';

export interface CompleteRequest {
  tier: Tier;
  purpose: Purpose;
  system: string;
  user: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** Hard cap on the text that may cross the boundary (ADR 0004: an unbounded call is a bug). */
  maxInputChars?: number;
  /** Versioned prompt artefact id, recorded on the meter row (ADR 0004 §5). */
  promptVersion?: string;
  /** What the call was for, so cost is attributable (brief 1.10). */
  refType?: string;
  refId?: string;
}

/**
 * Every call returns one of these, and every one of them corresponds to exactly
 * one ActionMeter row. `value` is non-null only when `ok` is true; a failed or
 * budget-blocked call NEVER invents an answer (ADR 0004 §9, promise 5).
 */
export interface CompleteResult<T> {
  ok: boolean;
  value: T | null;
  outcome: MeterOutcome;
  provider: string;
  model: string;
  tier: Tier;
  purpose: Purpose;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimatedCostMicros: number;
  priceTableVersion: string;
  promptVersion: string | null;
  /** Rowid of the ActionMeter row written for this call. Proof, not a promise. */
  meterId: number;
  /** Error CLASS only, never a provider body (invariant 13). */
  errorClass?: string;
}

/** The row the abstraction writes for every terminating path. Contains no content. */
export interface MeterRow {
  workspaceId: string;
  purpose: Purpose;
  outcome: MeterOutcome;
  at: number;
  tier: Tier;
  provider: string;
  model: string;
  promptVersion: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimatedCostMicros: number;
  priceTableVersion: string;
  latencyMs: number;
  refType: string | null;
  refId: string | null;
  billableAction: boolean;
}

/** Caps in cents (0 = unlimited) and spend so far, in micros, for this workspace. */
export interface BudgetSnapshot {
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  spentTodayMicros: number;
  spentMonthMicros: number;
  /** Global daily spend cap across all workspaces (brief 18). 0 = unlimited. */
  globalDailyBudgetCents?: number;
  spentGlobalTodayMicros?: number;
}

/**
 * The thing `complete()` refuses to run without (invariant 16). It names the
 * workspace being spent for, can read that workspace's budget, and can write
 * exactly one ActionMeter row.
 */
/**
 * PORTABILITY: both members may answer synchronously OR with a promise, and
 * `complete()` awaits them either way. The database-backed context
 * (`dbMeterContext`) is asynchronous because node-postgres is; an in-memory or
 * test context can stay synchronous, so the existing contract is unbroken.
 */
export interface MeterContext {
  readonly workspaceId: string;
  budget(): BudgetSnapshot | Promise<BudgetSnapshot>;
  /** Writes ONE ActionMeter row and returns its id. */
  record(row: MeterRow): number | Promise<number>;
}

export class ProviderTimeout extends Error { readonly kind = 'timeout' as const; }
export class ProviderError extends Error { readonly kind = 'provider_error' as const; }
export class InvalidOutput extends Error { readonly kind = 'invalid_output' as const; }
/** Thrown before anything is spent when a caller tries to skip metering. */
export class MissingMeterContext extends Error {
  readonly kind = 'missing_meter_context' as const;
  constructor(detail: string) { super(`provider.complete requires a meter context: ${detail}`); }
}

/**
 * Structural runtime guard. The type system already makes the argument required;
 * this catches `as any`, plain JS callers and half-built contexts, and it runs
 * BEFORE the budget read and long before any socket is opened.
 */
export function assertMeterContext(meter: unknown): asserts meter is MeterContext {
  if (meter === null || typeof meter !== 'object') throw new MissingMeterContext('none was passed');
  const m = meter as Partial<MeterContext>;
  if (typeof m.workspaceId !== 'string' || m.workspaceId.length === 0) {
    throw new MissingMeterContext('workspaceId is missing');
  }
  if (typeof m.budget !== 'function') throw new MissingMeterContext('budget() is missing');
  if (typeof m.record !== 'function') throw new MissingMeterContext('record() is missing');
}
