/** Durable, one-time CAPTCHA controls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_SESSION_SECRET = 'test-session-secret-for-captcha-12345';
import { migrateDbAsync, openDb } from '../src/db/client';
import { issueCaptcha, consumeCaptcha } from '../src/captcha';
import { admitRateLimit } from '../src/security-controls';
import { sweepSecurityControls, SECURITY_CONTROL_GRACE_MS } from '../src/retention';

async function fresh() {
  const path = join(mkdtempSync(join(tmpdir(), 'seros-captcha-')), 'test.db');
  await migrateDbAsync(path);
  return openDb(path);
}

test('a durable CAPTCHA is bound to its client and consumed exactly once', async () => {
  const db = await fresh();
  const c = await issueCaptcha(db, 'signup', '203.0.113.9');
  assert.match(c.svg, /<svg/);
  assert.ok(c.id.length >= 32);
  const answer = String(c.num1 + c.num2);
  assert.equal(await consumeCaptcha(db, c.id, answer, 'signup', '203.0.113.9'), true);
  assert.equal(await consumeCaptcha(db, c.id, answer, 'signup', '203.0.113.9'), false);
});

test('a durable CAPTCHA rejects a different client or purpose without spending it', async () => {
  const db = await fresh();
  const c = await issueCaptcha(db, 'login', '203.0.113.9');
  const answer = String(c.num1 + c.num2);
  assert.equal(await consumeCaptcha(db, c.id, answer, 'signup', '203.0.113.9'), false);
  assert.equal(await consumeCaptcha(db, c.id, answer, 'login', '203.0.113.10'), false);
  assert.equal(await consumeCaptcha(db, c.id, answer, 'login', '203.0.113.9'), true);
});

test('a wrong answer does not spend the challenge, and an expired one is refused', async () => {
  const db = await fresh();
  const issued = Date.now();
  const c = await issueCaptcha(db, 'login', '203.0.113.9', issued);
  const answer = String(c.num1 + c.num2);

  // A wrong guess must not burn the challenge, or a typo would force a reload.
  assert.equal(await consumeCaptcha(db, c.id, 'not-the-answer', 'login', '203.0.113.9', issued), false);
  assert.equal(await consumeCaptcha(db, c.id, answer, 'login', '203.0.113.9', issued), true);

  // A challenge older than its ten-minute window is refused even if answered correctly.
  const stale = await issueCaptcha(db, 'login', '203.0.113.9', issued);
  const afterExpiry = issued + 10 * 60 * 1000 + 1;
  assert.equal(
    await consumeCaptcha(db, stale.id, String(stale.num1 + stale.num2), 'login', '203.0.113.9', afterExpiry),
    false,
    'an expired challenge must not be accepted',
  );
});

test('an unknown challenge id is refused rather than treated as absent-and-allowed', async () => {
  const db = await fresh();
  assert.equal(await consumeCaptcha(db, 'no-such-challenge', '7', 'login', '203.0.113.9'), false);
  assert.equal(await consumeCaptcha(db, '', '7', 'login', '203.0.113.9'), false);
});

test('rate limit admissions are shared across database handles, not per instance', async () => {
  // The point of the durable limiter: two serverless instances share one budget.
  const path = join(mkdtempSync(join(tmpdir(), 'seros-ratelimit-')), 'test.db');
  await migrateDbAsync(path);
  const instanceA = openDb(path);
  const instanceB = openDb(path);

  const now = Date.now();
  assert.equal((await admitRateLimit(instanceA, 'login', '198.51.100.4', 2, 60_000, now)).admitted, true);
  assert.equal((await admitRateLimit(instanceB, 'login', '198.51.100.4', 2, 60_000, now)).admitted, true);

  const exhausted = await admitRateLimit(instanceB, 'login', '198.51.100.4', 2, 60_000, now);
  assert.equal(exhausted.admitted, false, 'the third attempt exceeds the shared budget');
  assert.ok(exhausted.resetAt > now, 'the caller is told when the window reopens');

  // A different client keeps its own budget.
  assert.equal((await admitRateLimit(instanceA, 'login', '198.51.100.5', 2, 60_000, now)).admitted, true);
  // A different bucket keeps its own budget for the same client.
  assert.equal((await admitRateLimit(instanceA, 'signup', '198.51.100.4', 2, 60_000, now)).admitted, true);
});

test('a rate limit budget refreshes in the next window', async () => {
  const db = await fresh();
  const now = Date.now();
  assert.equal((await admitRateLimit(db, 'login', '198.51.100.7', 1, 60_000, now)).admitted, true);
  assert.equal((await admitRateLimit(db, 'login', '198.51.100.7', 1, 60_000, now)).admitted, false);
  assert.equal(
    (await admitRateLimit(db, 'login', '198.51.100.7', 1, 60_000, now + 60_000)).admitted,
    true,
    'the next window restores the budget',
  );
});

test('the sweep discards spent security controls but keeps live ones', async () => {
  const db = await fresh();
  const now = Date.now();

  // Old enough to be useless: past its expiry and past the grace period.
  const old = now - SECURITY_CONTROL_GRACE_MS - 60 * 60 * 1000;
  await issueCaptcha(db, 'login', '203.0.113.20', old);
  await admitRateLimit(db, 'login', '203.0.113.20', 5, 60_000, old);

  // Still usable right now.
  const live = await issueCaptcha(db, 'login', '203.0.113.21', now);
  await admitRateLimit(db, 'login', '203.0.113.21', 5, 60_000, now);

  const swept = await sweepSecurityControls(db, { now });
  assert.equal(swept.captchaChallengesDeleted, 1, 'the expired challenge is discarded');
  assert.equal(swept.rateLimitWindowsDeleted, 1, 'the closed window is discarded');

  // The live challenge still works, so the sweep did not cut into current traffic.
  assert.equal(
    await consumeCaptcha(db, live.id, String(live.num1 + live.num2), 'login', '203.0.113.21', now),
    true,
    'a live challenge survives the sweep',
  );

  // And a repeat sweep is a no-op rather than an error.
  const again = await sweepSecurityControls(db, { now });
  assert.equal(again.captchaChallengesDeleted, 0);
  assert.equal(again.rateLimitWindowsDeleted, 0);
});
