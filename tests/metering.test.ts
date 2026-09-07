/**
 * tests/metering.test.ts — the metering and budget promises (brief invariants 15-19).
 *
 * TESTING-STRATEGY §1 names two areas with no direct coverage until now:
 *
 *   Metering    "every simulated provider call produces exactly one meter row,
 *                including failures, timeouts and budget blocks"
 *   Budget caps "at the cap, the provider abstraction refuses before the network
 *                call, writes a budget_blocked row, and leaves confirmation and
 *                writes working"
 *
 * Everything here runs offline. The network paths are exercised by pointing the
 * ollama transport at a closed port and by a local http server that answers
 * badly, so no test needs a live provider (strategy §1, last paragraph).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  complete, DetectionSchema, dbMeterContext, budgetDecision, MICROS_PER_CENT,
  MissingMeterContext, estimateCostMicros, startOfUtcDay, startOfUtcMonth,
} from '../src/provider';
import type { MeterContext, MeterRow } from '../src/provider';
import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { actionMeter, workspaces } from '../src/db/schema';
import { eq } from 'drizzle-orm';

/** A meter context that records into an array, so "exactly one row" is countable. */
function recorder(overrides: Partial<{
  dailyBudgetCents: number; monthlyBudgetCents: number;
  spentTodayMicros: number; spentMonthMicros: number;
  globalDailyBudgetCents: number; spentGlobalTodayMicros: number;
}> = {}) {
  const rows: MeterRow[] = [];
  const ctx: MeterContext = {
    workspaceId: 'ws-meter',
    budget: () => ({
      dailyBudgetCents: 0,
      monthlyBudgetCents: 0,
      spentTodayMicros: 0,
      spentMonthMicros: 0,
      ...overrides,
    }),
    record: (row: MeterRow) => { rows.push(row); return rows.length; },
  };
  return { ctx, rows };
}

const detectReq = {
  tier: 'cheap' as const,
  purpose: 'detect' as const,
  system: 'decide whether this is a commitment',
  user: "I'll send the deck by Thursday",
  promptVersion: 'detect-v1',
  refType: 'source_message',
  refId: 'sm-1',
};

/** Runs `fn` with env vars set, and restores them however it ends. */
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------- invariant 16

test('a call with no meter context is refused before anything is spent', async () => {
  for (const bad of [null, undefined, {}, { workspaceId: '' }, { workspaceId: 'ws', budget: () => ({}) }]) {
    await assert.rejects(
      () => complete(bad as any, detectReq, DetectionSchema),
      (e: unknown) => e instanceof MissingMeterContext,
      `a ${JSON.stringify(bad)} context must be refused`,
    );
  }
});

// ---------------------------------------------------------- invariants 15 & 17

test('a successful call writes exactly one meter row, priced and attributed', async () => {
  const { ctx, rows } = recorder();
  const res = await complete(ctx, detectReq, DetectionSchema);

  assert.equal(res.ok, true);
  assert.equal(res.outcome, 'ok');
  assert.notEqual(res.value, null);
  assert.equal(rows.length, 1, 'exactly one meter row per call');

  const row = rows[0]!;
  assert.equal(row.workspaceId, 'ws-meter');
  assert.equal(row.purpose, 'detect');
  assert.equal(row.tier, 'cheap');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.promptVersion, 'detect-v1');
  assert.equal(row.refType, 'source_message');
  assert.equal(row.refId, 'sm-1');
  assert.equal(row.billableAction, true);
  assert.ok(row.inputTokens > 0, 'input tokens counted');
  assert.ok(row.outputTokens > 0, 'output tokens counted');
  assert.equal(
    row.estimatedCostMicros,
    estimateCostMicros('cheap', row.inputTokens, row.outputTokens, row.cachedInputTokens),
    'cost is the price table applied to the counted tokens',
  );
  assert.ok(row.priceTableVersion.length > 0, 'the price table version is recorded');
  assert.equal(res.meterId, 1, 'the caller gets the id of the row, not a promise that one exists');
});

test('the meter row carries no customer content', async () => {
  const { ctx, rows } = recorder();
  await complete(ctx, { ...detectReq, user: 'the customer said something private' }, DetectionSchema);
  const serialised = JSON.stringify(rows[0]);
  assert.ok(!serialised.includes('private'), 'no message body reaches the meter row');
  assert.ok(!serialised.includes('customer said'), 'no message body reaches the meter row');
});

test('an outage is metered as a failure, and never invents an answer', async () => {
  // A port nothing is listening on: a real transport failure, no network needed.
  await withEnv({
    SEROS_PROVIDER: 'ollama',
    SEROS_PROVIDER_CHAIN: 'ollama',
    OLLAMA_HOST: 'http://127.0.0.1:1',
    SEROS_TIMEOUT_MS: '1500',
  }, async () => {
    const { ctx, rows } = recorder();
    const res = await complete(ctx, detectReq, DetectionSchema);

    assert.equal(res.ok, false, 'a failed call is not ok');
    assert.equal(res.value, null, 'a failed call returns nothing to draft from (H2)');
    assert.ok(['provider_error', 'timeout'].includes(res.outcome));
    assert.equal(rows.length, 1, 'a failure is metered exactly once');
    assert.equal(rows[0]!.outcome, res.outcome);
    assert.equal(rows[0]!.billableAction, true);
    assert.ok((res.errorClass ?? '').length > 0, 'an error class, never a provider body');
  });
});

test('a timeout is metered as a timeout, once', async () => {
  const server = createServer((_req, res) => { /* answer never */ void res; });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  try {
    await withEnv({
      SEROS_PROVIDER: 'ollama',
      SEROS_PROVIDER_CHAIN: 'ollama',
      OLLAMA_HOST: `http://127.0.0.1:${port}`,
      SEROS_TIMEOUT_MS: '150',
    }, async () => {
      const { ctx, rows } = recorder();
      const res = await complete(ctx, detectReq, DetectionSchema);
      assert.equal(res.outcome, 'timeout');
      assert.equal(res.value, null);
      assert.equal(rows.length, 1, 'a timeout is metered exactly once');
      assert.equal(rows[0]!.outcome, 'timeout');
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('output that does not match the schema is metered as invalid_output, once', async () => {
  const { ctx, rows } = recorder();
  // The fake answers the detection shape; ask for an incompatible one.
  const Incompatible = z.object({ somethingElseEntirely: z.string() });
  const res = await complete(ctx, detectReq, Incompatible);

  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'invalid_output');
  assert.equal(res.value, null, 'an unparseable answer is not passed on');
  assert.equal(rows.length, 1, 'the invalid-output path is metered too (H3)');
  assert.ok(rows[0]!.inputTokens > 0, 'the tokens spent on a bad answer are still counted');
});

// ------------------------------------------------------------ invariants 18/19

test('at the daily cap the call is refused before the network and metered budget_blocked', async () => {
  // The chain points at a closed port: if the socket were opened this would be a
  // provider_error, so budget_blocked is proof the refusal happened first.
  await withEnv({
    SEROS_PROVIDER: 'ollama',
    SEROS_PROVIDER_CHAIN: 'ollama',
    OLLAMA_HOST: 'http://127.0.0.1:1',
  }, async () => {
    const { ctx, rows } = recorder({
      dailyBudgetCents: 100,
      spentTodayMicros: 100 * MICROS_PER_CENT,
    });
    const res = await complete(ctx, detectReq, DetectionSchema);

    assert.equal(res.outcome, 'budget_blocked');
    assert.equal(res.value, null);
    assert.equal(res.provider, 'none', 'no transport was reached');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, 'budget_blocked');
    assert.equal(rows[0]!.estimatedCostMicros, 0, 'a refused call costs nothing');
    assert.equal(rows[0]!.billableAction, false, 'a refused call is not billable');
  });
});

test('the monthly and global caps each stop a call, and a zero cap means unlimited', async () => {
  const monthly = recorder({ monthlyBudgetCents: 50, spentMonthMicros: 50 * MICROS_PER_CENT });
  assert.equal((await complete(monthly.ctx, detectReq, DetectionSchema)).outcome, 'budget_blocked');

  const global = recorder({ globalDailyBudgetCents: 10, spentGlobalTodayMicros: 10 * MICROS_PER_CENT });
  assert.equal((await complete(global.ctx, detectReq, DetectionSchema)).outcome, 'budget_blocked');

  const unlimited = recorder({ dailyBudgetCents: 0, spentTodayMicros: 999_999_999 });
  assert.equal((await complete(unlimited.ctx, detectReq, DetectionSchema)).outcome, 'ok',
    'a cap of 0 is unlimited, which is the documented behaviour');
});

test('budgetDecision names the cap that stopped the call and reports the percentages', () => {
  const base = { dailyBudgetCents: 0, monthlyBudgetCents: 0, spentTodayMicros: 0, spentMonthMicros: 0 };

  assert.deepEqual(budgetDecision(base), { blocked: false, cap: null, dailyPct: 0, monthlyPct: 0 });

  const half = budgetDecision({ ...base, dailyBudgetCents: 100, spentTodayMicros: 50 * MICROS_PER_CENT });
  assert.equal(half.blocked, false);
  assert.equal(half.dailyPct, 50);

  assert.equal(budgetDecision({ ...base, dailyBudgetCents: 100, spentTodayMicros: 100 * MICROS_PER_CENT }).cap, 'daily');
  assert.equal(budgetDecision({ ...base, monthlyBudgetCents: 10, spentMonthMicros: 10 * MICROS_PER_CENT }).cap, 'monthly');
  assert.equal(budgetDecision({
    ...base, globalDailyBudgetCents: 10, spentGlobalTodayMicros: 10 * MICROS_PER_CENT,
  }).cap, 'global_daily');
  assert.equal(budgetDecision({
    ...base, dailyBudgetCents: 1, spentTodayMicros: MICROS_PER_CENT,
    monthlyBudgetCents: 1, spentMonthMicros: MICROS_PER_CENT,
  }).cap, 'daily', 'the daily cap is reported first when both are spent');
});

// ------------------------------------------------- the database-backed context

async function freshDb() {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-meter-')), 'test.db');
  await migrateDbAsync(path);
  return openDb(path);
}

test('the database meter context persists one row per call and spends the budget down', async () => {
  const db = await freshDb();
  await WorkspaceScope.ensure(db, 'ws-db-meter');
  await db.update(workspaces).set({ dailyBudgetCents: 1_000_000 })
    .where(eq(workspaces.id, 'ws-db-meter'));

  const ctx = dbMeterContext(db, 'ws-db-meter');
  const before = await ctx.budget();
  assert.equal(before.spentTodayMicros, 0);

  await complete(ctx, detectReq, DetectionSchema);
  await complete(ctx, { ...detectReq, purpose: 'draft', tier: 'standard' }, DetectionSchema);

  const rows = await db.select().from(actionMeter).where(eq(actionMeter.workspaceId, 'ws-db-meter'));
  assert.equal(rows.length, 2, 'two calls, two rows, no more and no fewer');
  assert.deepEqual(rows.map((r: any) => r.purpose).sort(), ['detect', 'draft']);

  const after = await ctx.budget();
  assert.ok(after.spentTodayMicros > 0, 'spend accumulates from the rows just written');
  assert.equal(
    after.spentTodayMicros,
    rows.reduce((n: number, r: any) => n + Number(r.estimatedCostMicros), 0),
    'the budget read is the sum of the metered rows',
  );
});

test('the database context reads its own workspace only', async () => {
  const db = await freshDb();
  await WorkspaceScope.ensure(db, 'ws-a');
  await WorkspaceScope.ensure(db, 'ws-b');

  await complete(dbMeterContext(db, 'ws-a'), detectReq, DetectionSchema);

  const b = await dbMeterContext(db, 'ws-b').budget();
  assert.equal(b.spentTodayMicros, 0, "ws-a's spend is invisible to ws-b");
  assert.equal(b.spentMonthMicros, 0);
});

test('a database-backed cap blocks the call and still writes its row', async () => {
  const db = await freshDb();
  await WorkspaceScope.ensure(db, 'ws-capped');
  await db.update(workspaces).set({ dailyBudgetCents: 1 })
    .where(eq(workspaces.id, 'ws-capped'));

  const ctx = dbMeterContext(db, 'ws-capped');
  // Book a call that spends the whole cent, through the same record() the
  // abstraction uses, then try to make one more.
  await ctx.record({
    workspaceId: 'ws-capped', purpose: 'detect', outcome: 'ok', at: Date.now(),
    tier: 'cheap', provider: 'fake', model: 'test', promptVersion: null,
    inputTokens: 10, outputTokens: 10, cachedInputTokens: 0,
    estimatedCostMicros: MICROS_PER_CENT, priceTableVersion: 'test',
    latencyMs: 1, refType: null, refId: null, billableAction: true,
  });
  assert.equal((await ctx.budget()).spentTodayMicros, MICROS_PER_CENT, 'the cent is spent');

  const outcome = (await complete(ctx, detectReq, DetectionSchema)).outcome;
  assert.equal(outcome, 'budget_blocked', 'spending past the cap refuses the next call');

  const all = await db.select().from(actionMeter).where(eq(actionMeter.workspaceId, 'ws-capped'));
  assert.equal(all.length, 2, 'the booked spend plus the refusal, nothing else');
  const blocked = all.filter((r: any) => r.outcome === 'budget_blocked');
  assert.equal(blocked.length, 1, 'the refusal is recorded, once');
  assert.equal(Number(blocked[0]!.estimatedCostMicros), 0);
  assert.equal(Number(blocked[0]!.billableAction), 0);
});

test('an unknown workspace cannot be spent for', async () => {
  const db = await freshDb();
  assert.throws(() => dbMeterContext(db, ''), /workspace id/,
    'a context without a workspace cannot be built at all');
  await assert.rejects(async () => { await dbMeterContext(db, 'ws-does-not-exist').budget(); });
});

// -------------------------------------------------------------- the day window

test('the day and month windows start at UTC midnight and the first of the month', () => {
  const t = Date.UTC(2026, 8, 7, 13, 45, 30);
  assert.equal(startOfUtcDay(t), Date.UTC(2026, 8, 7));
  assert.equal(startOfUtcMonth(t), Date.UTC(2026, 8, 1));
});
