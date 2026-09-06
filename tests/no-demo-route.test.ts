import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SEROS_SIGNING_SECRET = 'test-signing-secret-0123456789';
process.env.SEROS_SESSION_SECRET = 'test-session-secret-0123456789';
process.env.SEROS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.SEROS_PROVIDER = 'fake';
process.env.SEROS_TRACKER = 'fake';

import { createApp } from '../src/server';

test('the production app does not expose the synthetic demo route', async () => {
  const { createServer } = await import('node:http');
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const port = (server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/demo`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login');

    const login = await fetch(`http://127.0.0.1:${port}/login`);
    assert.doesNotMatch(await login.text(), /href="\/demo"/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
