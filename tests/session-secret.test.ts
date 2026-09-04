/**
 * tests/session-secret.test.ts — the app must not boot with a guessable session key.
 *
 * express-session's config in createApp() used to read:
 *
 *   secret: process.env.SEROS_SESSION_SECRET || 'seros-passport-bridge-secret'
 *
 * so an unset env var in production signed every session cookie with a string
 * committed to this repository. Anyone who read that line could forge a cookie
 * for any workspace. The app's own session (src/auth.ts sessionSecret) and the
 * Slack webhook (SEROS_SIGNING_SECRET) both already refused to start without a
 * real secret; this bridge was the one that quietly accepted a default.
 *
 * Refusing to boot is the whole behaviour under test: a missing secret has to be
 * a crash at startup, never a silently weaker app serving traffic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server';

/** Run fn with SEROS_SESSION_SECRET forced to a value (or removed entirely). */
function withSecret<T>(value: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'SEROS_SESSION_SECRET');
  const prev = process.env.SEROS_SESSION_SECRET;
  if (value === undefined) delete process.env.SEROS_SESSION_SECRET;
  else process.env.SEROS_SESSION_SECRET = value;
  try {
    return fn();
  } finally {
    if (had) process.env.SEROS_SESSION_SECRET = prev;
    else delete process.env.SEROS_SESSION_SECRET;
  }
}

test('the app refuses to boot with no session secret', () => {
  withSecret(undefined, () => {
    assert.throws(
      () => createApp(),
      /SEROS_SESSION_SECRET/,
      'createApp() must throw, not fall back to a built-in default',
    );
  });
});

test('the app refuses to boot with a too-short session secret', () => {
  // A 15-character secret is brute-forceable; the guard requires >= 16.
  withSecret('short-secret-!!', () => {
    assert.throws(() => createApp(), /SEROS_SESSION_SECRET/);
  });
});

test('the app boots with a real session secret', () => {
  // The negative control. Without this, the two tests above would still pass if
  // createApp() were broken for some entirely unrelated reason.
  withSecret('a-properly-long-test-secret-value', () => {
    assert.doesNotThrow(() => createApp());
  });
});

test('no source file carries a hard-coded secret fallback', () => {
  // The specific regression: `process.env.SOMETHING_SECRET || 'literal'`.
  // An empty-string fallback is fine and is used deliberately in routes/cron.ts,
  // where authorised() treats empty as closed rather than open — the danger is
  // only a fallback that is itself a usable credential.
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const { join } = require('node:path') as typeof import('node:path');
  const root = join(__dirname, '..');
  let hits = '';
  try {
    hits = execFileSync(
      'grep',
      ['-rnE', "process\\.env\\.[A-Z_]*(SECRET|TOKEN|KEY|PASSWORD)[A-Za-z_]*\\s*\\|\\|\\s*'[^']+'", 'src/'],
      { cwd: root, encoding: 'utf8' },
    );
  } catch {
    hits = ''; // grep exits 1 when it finds nothing, which is the passing case
  }
  assert.equal(hits.trim(), '', `hard-coded credential fallback:\n${hits}`);
});
