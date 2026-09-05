import test from 'node:test';
import assert from 'node:assert/strict';
import passport from 'passport';
import { oauthStart } from '../src/routes/oauth';

test('Google OAuth start enables state validation', () => {
  const oldId = process.env.GOOGLE_CLIENT_ID;
  const oldSecret = process.env.GOOGLE_CLIENT_SECRET;
  const originalAuthenticate = passport.authenticate;
  let options: unknown;

  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  (passport as any).authenticate = (_provider: string, received: unknown) => {
    options = received;
    return () => undefined;
  };

  try {
    oauthStart('google')({} as any, {} as any, () => undefined);
    assert.deepEqual(options, { scope: ['profile', 'email'], state: true });
  } finally {
    (passport as any).authenticate = originalAuthenticate;
    if (oldId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = oldId;
    if (oldSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = oldSecret;
  }
});
