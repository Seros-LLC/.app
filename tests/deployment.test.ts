import test from 'node:test';
import assert from 'node:assert/strict';
import { validateServerlessEnvironment } from '../src/deployment';

const valid = {
  SEROS_SESSION_SECRET: 'session-secret-at-least-sixteen',
  SEROS_SIGNING_SECRET: 'signing-secret-at-least-sixteen',
  DATABASE_URL: 'postgresql://seros.invalid/example',
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
