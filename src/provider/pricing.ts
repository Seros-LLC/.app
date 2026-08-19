/**
 * ADR 0004 §2: the mapping from a role-named tier to a concrete model, and its
 * price per token, is CONFIGURATION - versioned, changeable without a deploy,
 * and never a branch in the calling code. Nothing here imports a vendor SDK.
 *
 * Resolution order (first hit wins):
 *   1. SEROS_PRICE_TABLE_JSON   - inline JSON (tests, canary flips)
 *   2. SEROS_PRICE_TABLE        - path to a JSON file
 *   3. the built-in default below
 * A per-tier model override (SEROS_MODEL_CHEAP / _STANDARD / _CAREFUL) is applied
 * on top, so a canary can move one tier to another model with an env flip.
 */
import { readFileSync } from 'node:fs';
import type { Tier } from './types';

export interface TierPrice {
  /** Concrete model id for this tier. Named in config, never in code. */
  model: string;
  /** Price in micros (millionths of a cent-free unit: 1 micro = 1e-6 currency unit). */
  inputMicrosPerKToken: number;
  outputMicrosPerKToken: number;
  cachedInputMicrosPerKToken?: number;
}
export interface PriceTable {
  version: string;
  tiers: Record<Tier, TierPrice>;
}

const DEFAULT_TABLE: PriceTable = {
  version: 'pt-2026-08-18',
  tiers: {
    cheap:    { model: 'qwen2.5:7b-instruct', inputMicrosPerKToken: 20,  outputMicrosPerKToken: 80,   cachedInputMicrosPerKToken: 5 },
    standard: { model: 'qwen2.5:7b-instruct', inputMicrosPerKToken: 60,  outputMicrosPerKToken: 240,  cachedInputMicrosPerKToken: 15 },
    careful:  { model: 'qwen2.5:7b-instruct', inputMicrosPerKToken: 300, outputMicrosPerKToken: 1200, cachedInputMicrosPerKToken: 75 },
  },
};

let cacheKey = '';
let cached: PriceTable = DEFAULT_TABLE;

/** The live price table. Re-read when the configuration env changes (no deploy). */
export function priceTable(): PriceTable {
  const key = [
    process.env.SEROS_PRICE_TABLE_JSON ?? '',
    process.env.SEROS_PRICE_TABLE ?? '',
    process.env.SEROS_MODEL_CHEAP ?? '',
    process.env.SEROS_MODEL_STANDARD ?? '',
    process.env.SEROS_MODEL_CAREFUL ?? '',
  ].join('|');
  if (key === cacheKey) return cached;

  let table: PriceTable = DEFAULT_TABLE;
  const inline = process.env.SEROS_PRICE_TABLE_JSON;
  const path = process.env.SEROS_PRICE_TABLE;
  try {
    if (inline) table = mergeTable(JSON.parse(inline));
    else if (path) table = mergeTable(JSON.parse(readFileSync(path, 'utf-8')));
  } catch (e: any) {
    // A broken price table must not silently price everything at zero.
    throw new Error(`price table is unreadable: ${e?.name ?? 'Error'}`);
  }

  const overrides: Record<Tier, string | undefined> = {
    cheap: process.env.SEROS_MODEL_CHEAP,
    standard: process.env.SEROS_MODEL_STANDARD,
    careful: process.env.SEROS_MODEL_CAREFUL,
  };
  const tiers = { ...table.tiers };
  (Object.keys(overrides) as Tier[]).forEach((t) => {
    const m = overrides[t];
    if (m) tiers[t] = { ...tiers[t], model: m };
  });

  cached = { version: table.version, tiers };
  cacheKey = key;
  return cached;
}

function mergeTable(raw: any): PriceTable {
  if (!raw || typeof raw !== 'object' || !raw.tiers) throw new Error('no tiers');
  const tiers = { ...DEFAULT_TABLE.tiers } as Record<Tier, TierPrice>;
  (['cheap', 'standard', 'careful'] as Tier[]).forEach((t) => {
    if (raw.tiers[t]) tiers[t] = { ...tiers[t], ...raw.tiers[t] };
  });
  return { version: String(raw.version ?? DEFAULT_TABLE.version), tiers };
}

/** Concrete model for a tier, from configuration. */
export function modelFor(tier: Tier): string { return priceTable().tiers[tier].model; }

/** Priced at call time from the versioned table (brief: ActionMeter.estimated_cost_micros). */
export function estimateCostMicros(
  tier: Tier, inputTokens: number, outputTokens: number, cachedInputTokens = 0,
): number {
  const p = priceTable().tiers[tier];
  const cachedRate = p.cachedInputMicrosPerKToken ?? p.inputMicrosPerKToken;
  const micros =
    (Math.max(0, inputTokens) * p.inputMicrosPerKToken +
     Math.max(0, outputTokens) * p.outputMicrosPerKToken +
     Math.max(0, cachedInputTokens) * cachedRate) / 1000;
  return Math.ceil(micros);
}

/**
 * Back-compatible view of the tier -> model mapping (was `TIERS` in this module).
 * Reads configuration; kept so nothing has to know where the mapping lives.
 */
export const TIERS: Record<Tier, string> = new Proxy({} as Record<Tier, string>, {
  get: (_t, k: string) => modelFor(k as Tier),
  ownKeys: () => ['cheap', 'standard', 'careful'],
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});
