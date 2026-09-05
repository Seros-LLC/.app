import test from 'node:test';
import assert from 'node:assert/strict';
import { oauthSessionCookie } from '../src/server';

test('OAuth state session permits the provider callback navigation', () => {
  assert.equal(oauthSessionCookie.sameSite, 'lax');
  assert.equal(oauthSessionCookie.httpOnly, true);
  assert.equal(oauthSessionCookie.secure, 'auto');
});
