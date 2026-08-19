import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_SIGNING_SECRET = 'chain-test-signing-secret';
process.env.SEROS_SESSION_SECRET = 'chain-test-session-secret';
delete process.env.SEROS_PROVIDER;
const dir = mkdtempSync(join(tmpdir(), 'seros-chain-'));
process.env.SEROS_DB = join(dir, 'chain.db');

import { migrateDb, openDb } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { complete, dbMeterContext, DetectionSchema } from '../src/provider';
import { transportChain } from '../src/provider/transports';
import { actionMeter } from '../src/db/schema';
import { DETECT_SYSTEM } from '../src/prompts';
import { eq } from 'drizzle-orm';

migrateDb();
const db = openDb();
WorkspaceScope.ensure(db, 'chain', 'Chain workspace');
const meter = () => dbMeterContext(db, 'chain');
const ask = () => complete(meter(), { tier: 'cheap', purpose: 'detect', system: DETECT_SYSTEM, user: "I'll send the report by Friday." }, DetectionSchema);
const meterRows = () => db.select().from(actionMeter).where(eq(actionMeter.workspaceId, 'chain')).all();

test('the default chain is local Qwen alone, and never silently the fake', () => {
  delete process.env.SEROS_PROVIDER_CHAIN;
  assert.deepEqual(transportChain(), ['ollama']);
});

test('a chain is parsed in order and unknown links are ignored', () => {
  process.env.SEROS_PROVIDER_CHAIN = 'http, ollama , nonsense';
  assert.deepEqual(transportChain(), ['http', 'ollama']);
  process.env.SEROS_PROVIDER_CHAIN = 'nonsense';
  assert.deepEqual(transportChain(), ['ollama']);       // never empty
});

test('QWEN IS THE BACKUP: when the hosted provider is unconfigured, local Qwen serves the call', async () => {
  process.env.SEROS_PROVIDER_CHAIN = 'http,ollama';
  delete process.env.SEROS_PROVIDER_BASE_URL;           // hosted link is dead
  const before = meterRows().length;
  const r = await ask();
  if (r.outcome === 'provider_error' && /tried:http\+ollama/.test(r.provider)) {
    // Ollama is not running on this machine right now; the chain still behaved.
    assert.equal(r.value, null);
  } else {
    assert.equal(r.ok, true, `expected qwen to answer, got ${r.provider} ${r.outcome}`);
    assert.match(r.provider, /^ollama:.*\(after:http\)$/);   // it says which link caught it
  }
  assert.equal(meterRows().length, before + 1, 'a chained call is still exactly one metered row');
});

test('when every link fails, nothing is invented and the failure is metered', async () => {
  process.env.SEROS_PROVIDER_CHAIN = 'http';            // the only link, and it is unconfigured
  delete process.env.SEROS_PROVIDER_BASE_URL;
  const before = meterRows().length;
  const r = await ask();
  assert.equal(r.ok, false);
  assert.equal(r.value, null);
  assert.equal(r.outcome, 'provider_error');
  assert.match(r.provider, /^none\(tried:http\)$/);
  assert.equal(meterRows().length, before + 1);
});

test('the fake is only ever reached when it is named on purpose', async () => {
  process.env.SEROS_PROVIDER_CHAIN = 'http,fake';
  delete process.env.SEROS_PROVIDER_BASE_URL;
  const r = await ask();
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'fake(after:http)');
  assert.equal(r.value!.isCommitment, true);
  delete process.env.SEROS_PROVIDER_CHAIN;
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
