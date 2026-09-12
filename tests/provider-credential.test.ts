/**
 * The credential check exists because an expiring provider key failed silently:
 * drafts stopped, the log recorded it, and /health still said ok. These tests
 * pin the distinction that makes it useful — a REFUSED credential is
 * actionable, an unreachable network is not, and the two must not be conflated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHostedCredential } from '../src/provider/transports';

const BASE = 'https://provider.example/v1';
const realFetch = globalThis.fetch;

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; 
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]!; }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
    }
  });
}

function stubFetch(impl: (url: string, init: any) => Promise<Response> | Response) {
  globalThis.fetch = ((url: any, init: any) => Promise.resolve(impl(String(url), init))) as any;
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test('a live credential reports ok', async () => {
  stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  await withEnv({ SEROS_PROVIDER_BASE_URL: BASE, SEROS_PROVIDER_API_KEY: 'k' }, async () => {
    const r = await checkHostedCredential();
    assert.equal(r.state, 'ok');
  });
});

// The case that actually happened: the key expired and nothing said so.
test('an expired or revoked key reports invalid, not a generic failure', async () => {
  for (const status of [401, 403]) {
    stubFetch(() => new Response('nope', { status }));
    await withEnv({ SEROS_PROVIDER_BASE_URL: BASE, SEROS_PROVIDER_API_KEY: 'stale' }, async () => {
      const r = await checkHostedCredential();
      assert.equal(r.state, 'invalid', `http ${status} must mean the credential is bad`);
      assert.match(r.detail, /rejected/);
    });
  }
});

// Without this separation an operator gets paged to rotate a perfectly good key.
test('a network failure is unreachable, never invalid', async () => {
  stubFetch(() => { throw new Error('ECONNREFUSED'); });
  await withEnv({ SEROS_PROVIDER_BASE_URL: BASE, SEROS_PROVIDER_API_KEY: 'k' }, async () => {
    const r = await checkHostedCredential();
    assert.equal(r.state, 'unreachable');
    assert.notEqual(r.state, 'invalid');
  });
});

test('a provider 500 is unreachable, not a bad credential', async () => {
  stubFetch(() => new Response('boom', { status: 500 }));
  await withEnv({ SEROS_PROVIDER_BASE_URL: BASE, SEROS_PROVIDER_API_KEY: 'k' }, async () => {
    assert.equal((await checkHostedCredential()).state, 'unreachable');
  });
});

test('a timeout is unreachable and does not hang', async () => {
  stubFetch((_u, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => {
      const e: any = new Error('aborted'); e.name = 'AbortError'; rej(e);
    });
  }) as any);
  await withEnv({ SEROS_PROVIDER_BASE_URL: BASE, SEROS_PROVIDER_API_KEY: 'k' }, async () => {
    const r = await checkHostedCredential(25);
    assert.equal(r.state, 'unreachable');
    assert.match(r.detail, /timed out/);
  });
});

test('no configured provider is unconfigured, and makes no network call', async () => {
  let called = false;
  stubFetch(() => { called = true; return new Response('{}', { status: 200 }); });
  await withEnv({ SEROS_PROVIDER_BASE_URL: undefined, SEROS_PROVIDER_API_KEY: undefined }, async () => {
    assert.equal((await checkHostedCredential()).state, 'unconfigured');
    assert.equal(called, false);
  });
});

// It must cost nothing to run on a schedule, and must not be redirected to
// another host — the same SSRF concern the completion path guards against.
test('the check lists models, spends no tokens, and refuses redirects', async () => {
  let seen: { url: string; init: any } | null = null;
  stubFetch((url, init) => { seen = { url, init }; return new Response('{}', { status: 200 }); });
  await withEnv({ SEROS_PROVIDER_BASE_URL: BASE, SEROS_PROVIDER_API_KEY: 'k' }, async () => {
    await checkHostedCredential();
    assert.ok(seen, 'the check must call the provider');
    assert.equal(seen!.url, `${BASE}/models`);
    assert.equal(seen!.init.method, 'GET');
    assert.equal(seen!.init.redirect, 'error');
    assert.equal(seen!.init.body, undefined, 'a health check must not send a prompt');
  });
});

test('a trailing slash on the base url does not double up', async () => {
  let url = '';
  stubFetch((u) => { url = u; return new Response('{}', { status: 200 }); });
  await withEnv({ SEROS_PROVIDER_BASE_URL: BASE + '/', SEROS_PROVIDER_API_KEY: 'k' }, async () => {
    await checkHostedCredential();
    assert.equal(url, `${BASE}/models`);
  });
});
