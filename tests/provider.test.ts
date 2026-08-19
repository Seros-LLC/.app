/**
 * H3: metering and the budget hard stop live INSIDE the provider abstraction.
 *
 * These tests prove the structural claims, not the intentions:
 *   - complete() cannot be called without a meter context (type-level AND runtime),
 *   - every terminating path writes exactly one ActionMeter row,
 *   - a workspace at 100% of its cap is refused BEFORE the socket is opened,
 *   - a cap of 0 still means unlimited,
 *   - an outage is metered as the failure and never as `ok`,
 *   - and a hard stop does not stop ingest, confirmation or tracker writes.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_PROVIDER = 'fake';          // deterministic, offline
process.env.SEROS_SIGNING_SECRET = 'test-secret-that-is-long-enough';
process.env.SEROS_SESSION_SECRET = 'test-session-secret-long-enough';

const dir = mkdtempSync(join(tmpdir(), 'seros-provider-test-'));
process.env.SEROS_DB = join(dir, 'test.db');

import { migrateDb, openDb } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { actionMeter, workspaces, tasks } from '../src/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  complete, dbMeterContext, DetectionSchema, MissingMeterContext, MICROS_PER_CENT,
  budgetDecision, priceTable,
} from '../src/provider/index';
import type { MeterContext } from '../src/provider/index';

migrateDb();
const db = openDb();

// ---------------------------------------------------------------- helpers ----

/** A stub model API. Counts the sockets that actually reach a provider. */
let requests = 0;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_q, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: { content: JSON.stringify({ isCommitment: true, confidence: 90, reason: 'stub' }) }, prompt_eval_count: 40, eval_count: 12 }));
};
const stub = http.createServer((q, res) => { requests += 1; handler(q, res); });
const listening = new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
const stubUrl = async () => { await listening; return `http://127.0.0.1:${(stub.address() as any).port}`; };
after(() => stub.close());

/** Run a body against a real (stubbed) provider rather than the deterministic fake. */
async function withRealProvider<T>(host: string, body: () => Promise<T>): Promise<T> {
  const provider = process.env.SEROS_PROVIDER;
  const ollama = process.env.OLLAMA_HOST;
  delete process.env.SEROS_PROVIDER;
  process.env.OLLAMA_HOST = host;
  try { return await body(); }
  finally {
    if (provider === undefined) delete process.env.SEROS_PROVIDER; else process.env.SEROS_PROVIDER = provider;
    if (ollama === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = ollama;
  }
}

function workspace(id: string, budgets: { daily?: number; monthly?: number } = {}): MeterContext {
  WorkspaceScope.ensure(db, id);
  db.update(workspaces)
    .set({ dailyBudgetCents: budgets.daily ?? 0, monthlyBudgetCents: budgets.monthly ?? 0 })
    .where(eq(workspaces.id, id)).run();
  return dbMeterContext(db, id);
}

const meterRows = (id: string) =>
  db.select().from(actionMeter).where(eq(actionMeter.workspaceId, id)).all();

/** Spend that already happened today, e.g. earlier calls in the same day. */
function seedSpend(id: string, micros: number) {
  db.insert(actionMeter).values({
    workspaceId: id, purpose: 'detect', outcome: 'ok', at: Date.now(),
    tier: 'cheap', provider: 'fake', model: 'seed', inputTokens: 0, outputTokens: 0,
    estimatedCostMicros: micros, billableAction: 1,
  }).run();
}

const detectReq = (user = "I'll send the deck by Thursday.") => ({
  tier: 'cheap' as const, purpose: 'detect' as const,
  system: 'decide whether this is a commitment', user,
  refType: 'source_message', refId: 'm-1', promptVersion: 'detect@1',
});

// ------------------------------------------------------------------ tests ----

test('complete() refuses to run without a meter context, and spends nothing', async () => {
  const before = requests;

  await assert.rejects(
    // @ts-expect-error the meter context is a REQUIRED parameter, not an optional one
    () => complete(undefined, detectReq(), DetectionSchema),
    (e: Error) => e instanceof MissingMeterContext,
  );
  await assert.rejects(
    // @ts-expect-error a meter context is not a request object
    () => complete(detectReq(), DetectionSchema),
    (e: Error) => e instanceof MissingMeterContext,
  );
  // A half-built context is refused too: no workspace, or no way to write a row.
  await assert.rejects(
    () => complete({ workspaceId: '', budget: () => { throw new Error('x'); }, record: () => 0 } as MeterContext, detectReq(), DetectionSchema),
    (e: Error) => e instanceof MissingMeterContext,
  );
  await assert.rejects(
    () => complete({ workspaceId: 'T-nometer' } as unknown as MeterContext, detectReq(), DetectionSchema),
    (e: Error) => e instanceof MissingMeterContext,
  );

  assert.equal(requests, before, 'refusal happens before any socket is opened');
  assert.equal(meterRows('T-nometer').length, 0);
});

test('an ok call writes exactly one meter row, priced and attributed', async () => {
  const meter = workspace('T-ok');
  const r = await complete(meter, detectReq(), DetectionSchema);

  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.value?.isCommitment, true);

  const rows = meterRows('T-ok');
  assert.equal(rows.length, 1, 'exactly one row for one call');
  const row = rows[0]!;
  assert.equal(row.workspaceId, 'T-ok');
  assert.equal(row.purpose, 'detect');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.tier, 'cheap');
  assert.equal(row.model, priceTable().tiers.cheap.model);
  assert.equal(row.promptVersion, 'detect@1');
  assert.equal(row.refType, 'source_message');
  assert.equal(row.refId, 'm-1');
  assert.ok(row.inputTokens > 0 && row.outputTokens > 0, 'token counts are recorded');
  assert.ok(row.estimatedCostMicros > 0, 'cost is priced at call time');
  assert.equal(row.priceTableVersion, priceTable().version);
  assert.equal(row.id, r.meterId, 'the result names the row that was written for it');
});

test('two calls write two meter rows', async () => {
  const meter = workspace('T-two');
  await complete(meter, detectReq(), DetectionSchema);
  await complete(meter, detectReq('We will ship on Friday.'), DetectionSchema);
  assert.equal(meterRows('T-two').length, 2);
});

test('a workspace at 100% of its daily budget is refused BEFORE the network call and metered budget_blocked', async () => {
  const meter = workspace('T-daily', { daily: 5 });          // 5 cents
  seedSpend('T-daily', 5 * MICROS_PER_CENT);                 // already spent 100%
  const before = requests;

  const r = await withRealProvider(await stubUrl(), () => complete(meter, detectReq(), DetectionSchema));

  assert.equal(requests, before, 'no socket was opened: the stop is before the call');
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'budget_blocked');
  assert.equal(r.value, null, 'a blocked call invents no answer');
  assert.equal(r.estimatedCostMicros, 0);

  const blocked = meterRows('T-daily').filter((x) => x.outcome === 'budget_blocked');
  assert.equal(blocked.length, 1, 'the blocked call is metered exactly once');
  assert.equal(blocked[0]!.billableAction, 0, 'a blocked call is not billable');
  assert.equal(meterRows('T-daily').length, 2, 'seeded spend + one budget_blocked row');
});

test('a workspace under its daily budget is allowed, and crossing the cap stops the next call', async () => {
  const meter = workspace('T-edge', { daily: 1 });           // 1 cent = 10_000 micros
  const first = await complete(meter, detectReq(), DetectionSchema);
  assert.equal(first.outcome, 'ok', 'under the cap the call runs');

  seedSpend('T-edge', 1 * MICROS_PER_CENT);                  // now at 100%
  const second = await complete(meter, detectReq(), DetectionSchema);
  assert.equal(second.outcome, 'budget_blocked');
  assert.equal(second.ok, false);

  const rows = meterRows('T-edge');
  assert.equal(rows.filter((x) => x.outcome === 'ok').length, 2);        // the call + the seed
  assert.equal(rows.filter((x) => x.outcome === 'budget_blocked').length, 1);
});

test('a budget of 0 means unlimited, however much has been spent', async () => {
  const meter = workspace('T-unlimited', { daily: 0, monthly: 0 });
  seedSpend('T-unlimited', 500_000 * MICROS_PER_CENT);       // 5000 dollars today
  const r = await complete(meter, detectReq(), DetectionSchema);
  assert.equal(r.outcome, 'ok', '0 is unlimited, not "zero budget"');
  assert.equal(r.ok, true);
  assert.equal(meterRows('T-unlimited').filter((x) => x.outcome === 'budget_blocked').length, 0);

  // and the decision function agrees, with no spend row involved
  assert.equal(budgetDecision({ dailyBudgetCents: 0, monthlyBudgetCents: 0, spentTodayMicros: 1e12, spentMonthMicros: 1e12 }).blocked, false);
});

test('the monthly cap stops calls too, and is metered budget_blocked', async () => {
  const meter = workspace('T-monthly', { daily: 0, monthly: 3 });
  seedSpend('T-monthly', 3 * MICROS_PER_CENT);
  const r = await complete(meter, detectReq(), DetectionSchema);
  assert.equal(r.outcome, 'budget_blocked');
  assert.equal(meterRows('T-monthly').filter((x) => x.outcome === 'budget_blocked').length, 1);
});

test('a provider outage is metered as provider_error, never as ok, and invents no answer', async () => {
  const meter = workspace('T-outage');
  const r = await withRealProvider('http://127.0.0.1:1', () => complete(meter, detectReq(), DetectionSchema));

  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'provider_error');
  assert.equal(r.value, null, 'no fabricated draft on outage (H2)');

  const rows = meterRows('T-outage');
  assert.equal(rows.length, 1, 'exactly one row for the failed call');
  assert.equal(rows[0]!.outcome, 'provider_error');
  assert.notEqual(rows[0]!.outcome, 'ok');
  assert.ok((rows[0]!.latencyMs ?? -1) >= 0, 'latency is recorded even for a failure');
});

test('a provider timeout is metered as timeout, exactly once', async () => {
  const meter = workspace('T-timeout');
  handler = () => { /* never responds */ };
  try {
    const r = await withRealProvider(await stubUrl(), () =>
      complete(meter, { ...detectReq(), timeoutMs: 150 }, DetectionSchema));
    assert.equal(r.outcome, 'timeout');
    assert.equal(r.ok, false);
    assert.equal(r.value, null);
  } finally {
    handler = (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content: JSON.stringify({ isCommitment: true, confidence: 90, reason: 'stub' }) } }));
    };
  }
  const rows = meterRows('T-timeout');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, 'timeout');
});

test('output that fails the schema is metered as invalid_output, exactly once', async () => {
  const meter = workspace('T-invalid');
  handler = (_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: { content: JSON.stringify({ nonsense: true }) } }));
  };
  const r = await withRealProvider(await stubUrl(), () => complete(meter, detectReq(), DetectionSchema));
  assert.equal(r.outcome, 'invalid_output');
  assert.equal(r.ok, false);
  assert.equal(r.value, null, 'no fallback answer is smuggled past the schema');

  const rows = meterRows('T-invalid');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, 'invalid_output');
});

test('output that is not JSON at all is metered as invalid_output', async () => {
  const meter = workspace('T-notjson');
  handler = (_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: { content: 'I am not JSON' } }));
  };
  const r = await withRealProvider(await stubUrl(), () => complete(meter, detectReq(), DetectionSchema));
  assert.equal(r.outcome, 'invalid_output');
  assert.equal(meterRows('T-notjson').length, 1);
});

test('every outcome is metered exactly once: five paths, five rows, one per call', async () => {
  const seen = new Set<string>();
  for (const row of [
    ...meterRows('T-ok'), ...meterRows('T-daily'), ...meterRows('T-outage'),
    ...meterRows('T-timeout'), ...meterRows('T-invalid'),
  ]) seen.add(row.outcome);
  assert.deepEqual([...seen].sort(), ['budget_blocked', 'invalid_output', 'ok', 'provider_error', 'timeout']);
});

test('a hard stop stops model calls only: ingest holds messages, confirmation and tracker writes keep working', async () => {
  const scope = WorkspaceScope.ensure(db, 'T-stopped');
  db.update(workspaces).set({ dailyBudgetCents: 2, monthlyBudgetCents: 0 })
    .where(eq(workspaces.id, 'T-stopped')).run();
  seedSpend('T-stopped', 2 * MICROS_PER_CENT);
  const meter = dbMeterContext(db, 'T-stopped');

  // model call: refused
  const r = await complete(meter, detectReq(), DetectionSchema);
  assert.equal(r.outcome, 'budget_blocked');

  // ingest: still accepted and HELD, not discarded
  const msg = scope.ingestMessage({ channelId: 'C1', ts: '900.1', authorId: 'u-ana', body: "I'll send the deck." });
  assert.equal(msg.created, true);
  assert.ok(scope.messageById(msg.row.id));

  // confirmation and the tracker write path: untouched by the budget stop
  scope.addMember('u-ana', 'Ana', 'confirmer');
  const draftId = scope.createDraft({
    sourceMessageId: msg.row.id, title: 'Send the deck', outcome: 'deck sent',
    kind: 'commitment', confidence: 80, suggestedOwner: 'u-ana',
    suggestedDueDate: null, provider: 'human',
  });
  const confirmed = scope.confirm(draftId, 'confirmed', 'u-ana');
  assert.equal(confirmed.ok, true);
  const task = db.select().from(tasks)
    .where(and(eq(tasks.workspaceId, 'T-stopped'), eq(tasks.confirmationId, (confirmed as any).confirmationId))).get();
  assert.ok(task, 'a confirmed write is still queued while model spend is stopped');

  // and the stop is still metered exactly once
  assert.equal(meterRows('T-stopped').filter((x) => x.outcome === 'budget_blocked').length, 1);
});

test('the meter context is per workspace: one workspace cannot spend another\'s budget', async () => {
  const rich = workspace('T-rich', { daily: 0 });
  const poor = workspace('T-poor', { daily: 1 });
  seedSpend('T-poor', 1 * MICROS_PER_CENT);

  assert.equal((await complete(rich, detectReq(), DetectionSchema)).outcome, 'ok');
  assert.equal((await complete(poor, detectReq(), DetectionSchema)).outcome, 'budget_blocked');
  assert.equal(meterRows('T-rich').every((r) => r.workspaceId === 'T-rich'), true);
  assert.equal(meterRows('T-poor').every((r) => r.workspaceId === 'T-poor'), true);
});
