/**
 * tests/provider-transports.test.ts - provider transport guards.
 *
 * Verifies bounds, fake fallbacks, and error boundaries on provider transports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeComplete, fakeIsConfigured, estimateTokens, MAX_RESPONSE_BYTES } from '../src/provider/transports';

test('fakeIsConfigured reflects SEROS_PROVIDER env var', () => {
  const prev = process.env.SEROS_PROVIDER;
  try {
    process.env.SEROS_PROVIDER = 'fake';
    assert.equal(fakeIsConfigured(), true);
    process.env.SEROS_PROVIDER = 'ollama';
    assert.equal(fakeIsConfigured(), false);
  } finally {
    process.env.SEROS_PROVIDER = prev;
  }
});

test('fakeComplete accurately detects commitments', () => {
  const c1 = fakeComplete({ system: '', user: 'I will send the report tomorrow', tier: 'cheap', purpose: 'detect' });
  assert.equal(JSON.parse(c1.text).isCommitment, true);

  const c2 = fakeComplete({ system: '', user: 'Hello, how are you?', tier: 'cheap', purpose: 'detect' });
  assert.equal(JSON.parse(c2.text).isCommitment, false);
});

test('estimateTokens provides non-zero estimates', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens(''), 1);
  assert.ok(estimateTokens('a'.repeat(400)) >= 100);
});

test('MAX_RESPONSE_BYTES defaults to 256KB', () => {
  assert.equal(MAX_RESPONSE_BYTES(), 256 * 1024);
});
