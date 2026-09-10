import test from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import {
  CookieStateStore,
  sealValue,
  unsealValue,
  setFlowCookie,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
} from '../src/oauth-state';

/**
 * These tests exist because of a real production failure: OAuth state was kept
 * in an express-session MemoryStore, which lives in one serverless instance's
 * heap. Measured on production, 17 of 30 requests carrying one session cookie
 * reached an instance that had never seen it, so sign-in failed closed. State
 * must therefore be verifiable from the cookie alone, with no shared store.
 */

process.env.SEROS_SESSION_SECRET ||= 'test-session-secret-at-least-16-chars';

/** Minimal Response double that records Set-Cookie the way Express does. */
function fakeRes() {
  const headers: Record<string, string | string[]> = {};
  return {
    setHeader(name: string, value: string | string[]) { headers[name] = value; },
    getHeader(name: string) { return headers[name]; },
    cookies(): string[] {
      const raw = headers['Set-Cookie'];
      return raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
    },
  };
}

/** Build a Request double carrying the cookies a browser would send back. */
function reqWith(cookies: string[], res?: unknown) {
  const header = cookies
    .map((c) => c.split(';')[0])
    .filter((c) => !/=;|=$/.test(c!))
    .join('; ');
  return { header: (n: string) => (n.toLowerCase() === 'cookie' ? header : undefined), res } as any;
}

test('a state handle issued by one instance verifies on another with no shared store', async () => {
  // Instance A issues the state.
  const resA = fakeRes();
  const storeA = new CookieStateStore('google');
  const handle = await new Promise<string>((resolve, reject) => {
    storeA.store(reqWith([], resA) as any, { intent: 'test' }, {}, (err, h) => err ? reject(err) : resolve(h!));
  });
  assert.ok(handle && handle.length > 20, 'a state handle is issued');

  // Instance B is a different process: it shares only the secret, not the heap.
  const resB = fakeRes();
  const storeB = new CookieStateStore('google');
  const ok = await new Promise<boolean>((resolve, reject) => {
    storeB.verify(reqWith(resA.cookies(), resB) as any, handle, (err, valid) => err ? reject(err) : resolve(!!valid));
  });
  assert.equal(ok, true, 'the cookie alone proves the state, without a shared session store');
});

test('the state cookie survives the provider callback navigation', () => {
  const res = fakeRes();
  setFlowCookie(res as unknown as Response, OAUTH_STATE_COOKIE, 'value', OAUTH_STATE_TTL_MS);
  const cookie = res.cookies()[0]!;
  // Lax, never Strict: the provider redirects cross-site and a Strict cookie
  // would be withheld on exactly the request that needs it.
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /HttpOnly/);
});

test('a forged or tampered state is refused', async () => {
  const res = fakeRes();
  const store = new CookieStateStore('google');
  const handle = await new Promise<string>((resolve, reject) => {
    store.store(reqWith([], res) as any, null, {}, (err, h) => err ? reject(err) : resolve(h!));
  });

  const attempts: Array<[string, string[], string]> = [
    ['no cookie at all', [], handle],
    ['a fabricated state value', res.cookies(), 'not-the-real-handle'],
    ['a tampered cookie body', [`${OAUTH_STATE_COOKIE}=abc.def`], handle],
  ];

  for (const [label, cookies, given] of attempts) {
    const ok = await new Promise<boolean>((resolve, reject) => {
      new CookieStateStore('google').verify(reqWith(cookies, fakeRes()) as any, given, (err, valid) => err ? reject(err) : resolve(!!valid));
    });
    assert.equal(ok, false, `refused: ${label}`);
  }
});

test('state minted for one provider cannot be replayed into the other', async () => {
  const res = fakeRes();
  const handle = await new Promise<string>((resolve, reject) => {
    new CookieStateStore('google').store(reqWith([], res) as any, null, {}, (err, h) => err ? reject(err) : resolve(h!));
  });
  const ok = await new Promise<boolean>((resolve, reject) => {
    new CookieStateStore('github').verify(reqWith(res.cookies(), fakeRes()) as any, handle, (err, valid) => err ? reject(err) : resolve(!!valid));
  });
  assert.equal(ok, false, 'a google state is not a github state');
});

test('verifying burns the nonce so a captured callback cannot be replayed', async () => {
  const issuing = fakeRes();
  const handle = await new Promise<string>((resolve, reject) => {
    new CookieStateStore('google').store(reqWith([], issuing) as any, null, {}, (err, h) => err ? reject(err) : resolve(h!));
  });
  const verifying = fakeRes();
  await new Promise<void>((resolve, reject) => {
    new CookieStateStore('google').verify(reqWith(issuing.cookies(), verifying) as any, handle, (err) => err ? reject(err) : resolve());
  });
  const cleared = verifying.cookies().find((c) => c.startsWith(OAUTH_STATE_COOKIE));
  assert.ok(cleared, 'the response clears the state cookie');
  assert.match(cleared!, /Max-Age=0/, 'single use: the nonce is cleared on verification');
});

test('an expired seal is refused', () => {
  const stale = sealValue('oauth-state:google', { handle: 'x' }, -1000);
  assert.equal(unsealValue('oauth-state:google', stale), null);
});

test('queuing a second cookie does not discard the first', () => {
  const res = fakeRes();
  setFlowCookie(res as unknown as Response, 'a', '1', 1000);
  setFlowCookie(res as unknown as Response, 'b', '2', 1000);
  // The callback clears the state cookie and sets the session cookie on one
  // response; a plain setHeader would drop one of them and break sign-in.
  assert.equal(res.cookies().length, 2);
});
