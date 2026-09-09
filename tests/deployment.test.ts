import test from 'node:test';
import assert from 'node:assert/strict';
import { validateServerlessEnvironment } from '../src/deployment';

const valid = {
  SEROS_SESSION_SECRET: 'session-secret-at-least-sixteen',
  SEROS_SIGNING_SECRET: 'signing-secret-at-least-sixteen',
  DATABASE_URL: 'postgresql://seros.invalid/example',
  SEROS_PROVIDER_CHAIN: 'http,ollama',
  SEROS_PROVIDER_BASE_URL: 'https://provider.invalid/v1',
  SEROS_PROVIDER_API_KEY: 'provider-key-at-least-sixteen',
} as NodeJS.ProcessEnv;

test('serverless config refuses missing or weak secrets', () => {
  assert.throws(
    () => validateServerlessEnvironment({ ...valid, SEROS_SESSION_SECRET: '' }),
    /SEROS_SESSION_SECRET/,
  );
  assert.throws(
    () => validateServerlessEnvironment({ ...valid, SEROS_SIGNING_SECRET: 'short' }),
    /SEROS_SIGNING_SECRET/,
  );
});

test('serverless config refuses ephemeral or absent databases', () => {
  assert.throws(
    () => validateServerlessEnvironment({ ...valid, DATABASE_URL: '' }),
    /DATABASE_URL/,
  );
  assert.throws(
    () => validateServerlessEnvironment({ ...valid, DATABASE_URL: 'file:/tmp/seros.db' }),
    /DATABASE_URL/,
  );
});

test('serverless config accepts real secrets with Postgres', () => {
  assert.doesNotThrow(() => validateServerlessEnvironment(valid));
});

test('serverless config refuses a provider chain that cannot answer', () => {
  // The default chain is `ollama`, i.e. localhost:11434, which does not exist on
  // Vercel. Booting anyway yields a healthy app that silently drafts nothing.
  const { SEROS_PROVIDER_CHAIN: _drop, ...defaulted } = valid as Record<string, string>;
  assert.throws(
    () => validateServerlessEnvironment(defaulted as NodeJS.ProcessEnv),
    /must include `http`/,
  );
  assert.throws(
    () => validateServerlessEnvironment({ ...valid, SEROS_PROVIDER_CHAIN: 'ollama' }),
    /must include `http`/,
  );
});

test('serverless config refuses hosted transport without credentials', () => {
  assert.throws(
    () => validateServerlessEnvironment({ ...valid, SEROS_PROVIDER_BASE_URL: '' }),
    /SEROS_PROVIDER_BASE_URL/,
  );
  assert.throws(
    () => validateServerlessEnvironment({ ...valid, SEROS_PROVIDER_API_KEY: '' }),
    /SEROS_PROVIDER_API_KEY/,
  );
});

test('serverless config never lets the fake provider serve traffic', () => {
  assert.throws(
    () => validateServerlessEnvironment({ ...valid, SEROS_PROVIDER: 'fake' }),
    /fabricates model output/,
  );
  assert.throws(
    () => validateServerlessEnvironment({ ...valid, SEROS_PROVIDER_CHAIN: 'http,fake' }),
    /fabricates model output/,
  );
});
