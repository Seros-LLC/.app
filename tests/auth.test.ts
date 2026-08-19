/**
 * tests/auth.test.ts - the sign-in that replaced the member picker.
 *
 * The old /login took a member id out of a dropdown and issued a session for it.
 * These tests are the argument that it cannot do that any more, and that what
 * replaced it holds up: a scrypt credential compared in constant time, one
 * indistinguishable answer for every kind of failure, a lockout, single-use
 * invites, session rotation, and an audit trail with identifiers and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEROS_PROVIDER = 'fake';
process.env.SEROS_SIGNING_SECRET = 'auth-test-signing-secret-long';
process.env.SEROS_SESSION_SECRET = 'auth-test-session-secret-long';
process.env.SEROS_WORKSPACE = 'authws';
process.env.SEROS_SCRYPT_N = '4096';            // real scrypt, small enough for a test run
process.env.SEROS_LOGIN_MAX_ATTEMPTS = '500';   // the lockout test lowers this itself
const dir = mkdtempSync(join(tmpdir(), 'seros-auth-'));
process.env.SEROS_DB = join(dir, 'auth.db');

import { migrateDb, openDb } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import {
  requireSession, requireCsrf, rateLimit, resetRateLimits, csrfToken, type Session,
} from '../src/auth';
import * as authModule from '../src/auth';
import {
  MemberCredentials, hashPassword, verifyPassword, parseHash, needsRehash,
  newInviteToken, hashToken, passwordPolicyError,
} from '../src/password';
import {
  loginPage, loginPost, logoutPost, setPasswordPage, setPasswordPost,
  passwordPage, passwordChangePost, membersPage, invitePost,
} from '../src/routes/login';

const WS = 'authws';
const BOSS_PW = 'correct-horse-battery-staple';
const HAND_PW = 'a-different-long-password';

migrateDb();
const db = openDb();
const scope = WorkspaceScope.ensure(db, WS, 'Auth workspace');
const creds = MemberCredentials.for(db, scope);

scope.addMember('u-boss', 'Bea Boss', 'owner');
scope.addMember('u-hand', 'Hal Hand', 'confirmer');
scope.addMember('u-view', 'Vi View', 'viewer');
scope.addMember('u-lock', 'Lo Lock', 'confirmer');
scope.addMember('u-gone', 'Gus Gone', 'confirmer');
creds.setEmail('u-boss', 'Boss@Auth.Invalid');      // stored lower-cased
creds.setEmail('u-hand', 'hand@auth.invalid');
db.$client.prepare("UPDATE members SET status='suspended' WHERE workspace_id=? AND id=?").run(WS, 'u-gone');

// Hashing is async and this file is CommonJS, so the fixtures are the first test.
test('fixture: four of the five members have a password, u-hand has none yet', async () => {
  creds.setPassword('u-boss', await hashPassword(BOSS_PW));
  creds.setPassword('u-lock', await hashPassword(HAND_PW));
  creds.setPassword('u-view', await hashPassword(HAND_PW));
  creds.setPassword('u-gone', await hashPassword(HAND_PW));
  assert.ok(creds.workspaceHasPasswords());
  assert.equal(creds.get('u-hand')?.passwordHash ?? null, null);
});

/** The wiring src/server.ts must end up with; see the handover note. */
function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.get('/login', loginPage);
  app.post('/login', rateLimit('login', 20, 60_000), loginPost);
  app.post('/logout', logoutPost);
  app.get('/set-password', setPasswordPage);
  app.post('/set-password', rateLimit('setpw', 10, 60_000), setPasswordPost);
  app.use(requireSession);
  app.get('/whoami', (req, res) => { res.json({ memberId: req.session!.memberId }); });
  app.get('/password', passwordPage);
  app.post('/password', rateLimit('password', 20, 60_000), requireCsrf, passwordChangePost);
  app.get('/members', membersPage);
  app.post('/members/invite', rateLimit('invite', 20, 60_000), requireCsrf, invitePost);
  return app;
}
const server = buildApp().listen(0);
const port = (server.address() as any).port;
const url = (p: string) => `http://127.0.0.1:${port}${p}`;

const form = (body: Record<string, string>) => new URLSearchParams(body).toString();
async function post(path: string, body: Record<string, string>, cookie?: string) {
  return fetch(url(path), {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: form(body),
  });
}
const get = (path: string, cookie?: string) =>
  fetch(url(path), { redirect: 'manual', headers: cookie ? { cookie } : {} });

const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0]!;
/** The session a cookie carries, read the way src/auth.ts reads it. */
function sessionOf(cookie: string): Session {
  const raw = decodeURIComponent(cookie.split('=').slice(1).join('='));
  return JSON.parse(Buffer.from(raw.split('.')[0]!, 'base64url').toString('utf8')) as Session;
}
async function signIn(identifier: string, password: string): Promise<string> {
  resetRateLimits();
  const r = await post('/login', { identifier, password });
  assert.equal(r.status, 303, `sign-in for ${identifier} was refused`);
  return cookieOf(r);
}
const auditEvents = (event: string) => scope.auditRows(500).filter((a) => a.event === event);

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

test('a stored password is scrypt, version tagged, with its parameters and a per-user salt', async () => {
  const a = await hashPassword('the same password');
  const b = await hashPassword('the same password');
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(a, b, 'two hashes of one password must differ: the salt is per-user, not global');
  const pa = parseHash(a)!, pb = parseHash(b)!;
  assert.notEqual(pa.salt.toString('base64'), pb.salt.toString('base64'));
  assert.equal(pa.salt.length, 16);
  assert.equal(pa.hash.length, 32);
  assert.deepEqual(pa.params, { N: 4096, r: 8, p: 1 });       // parameters travel with the hash
  assert.ok(await verifyPassword('the same password', a));
  assert.ok(await verifyPassword('the same password', b));
  // the parameters are read back from the record, so an old cost still verifies
  const cheap = await hashPassword('the same password', { N: 1024, r: 8, p: 1 });
  assert.ok(await verifyPassword('the same password', cheap));
  assert.ok(needsRehash(cheap), 'a weaker record should be flagged for upgrade');
  assert.ok(!needsRehash(a));
  // nothing recoverable: the plaintext never appears in the record
  assert.ok(!a.includes('the same password'));
});

test('verification compares digests with crypto.timingSafeEqual, never with === ', async () => {
  const original = crypto.timingSafeEqual;
  let calls = 0;
  (crypto as any).timingSafeEqual = (x: any, y: any) => { calls++; return original(x, y); };
  try {
    const stored = await hashPassword('a password to compare');
    assert.ok(await verifyPassword('a password to compare', stored));
    assert.ok(calls > 0, 'the right password was accepted without a constant-time compare');
    const before = calls;
    assert.ok(!(await verifyPassword('a password to compаre', stored)));   // one character differs
    assert.ok(calls > before, 'the wrong password was rejected without a constant-time compare');
  } finally {
    (crypto as any).timingSafeEqual = original;
  }
});

test('a missing, malformed or tampered record is refused, and a null record never verifies', async () => {
  const stored = await hashPassword('another password entirely');
  assert.ok(!(await verifyPassword('another password entirely', null)));
  assert.ok(!(await verifyPassword('', null)));
  assert.ok(!(await verifyPassword('anything', 'not-a-hash')));
  assert.ok(!(await verifyPassword('anything', 'scrypt$4096$8$1$c2FsdA==')));         // truncated
  assert.ok(!(await verifyPassword('another password entirely', stored.slice(0, -4) + 'AAAA')));
  assert.equal(parseHash('bcrypt$1$2$3$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA=='), null);  // another scheme
  assert.equal(parseHash(`scrypt$${1 << 23}$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==`), null); // hostile cost
});

test('the password policy refuses what cannot be defended, and says why', () => {
  assert.equal(passwordPolicyError('a-long-enough-password'), null);
  assert.match(String(passwordPolicyError('short')), /at least 12/);
  assert.match(String(passwordPolicyError('')), /Choose a password/);
  assert.match(String(passwordPolicyError('ababababababab')), /distinct/);
  assert.match(String(passwordPolicyError('x'.repeat(300))), /at most/);
});

// ---------------------------------------------------------------------------
// signing in
// ---------------------------------------------------------------------------

test('sign in with an email address and a password', async () => {
  resetRateLimits();
  const r = await post('/login', { identifier: 'BOSS@auth.invalid', password: BOSS_PW });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/queue');
  const cookie = cookieOf(r);
  assert.match(r.headers.get('set-cookie') ?? '', /HttpOnly/);
  assert.match(r.headers.get('set-cookie') ?? '', /SameSite=Strict/);
  const who = await (await get('/whoami', cookie)).json();
  assert.equal(who.memberId, 'u-boss');
  assert.equal(creds.get('u-boss')!.lastLoginAt! > 0, true);
});

test('sign in with a member id and a password', async () => {
  const cookie = await signIn('u-boss', BOSS_PW);
  const who = await (await get('/whoami', cookie)).json();
  assert.equal(who.memberId, 'u-boss');
});

test('THE HOLE IS CLOSED: a member id with no password is no longer a sign-in', async () => {
  resetRateLimits();
  const r = await post('/login', { memberId: 'u-boss' });          // exactly the old request
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null, 'a session was issued without a password');
});

test('the password-less path is GONE: no member, no workspace and no environment brings it back', async () => {
  assert.equal((authModule as any).bootstrapSignInAllowed, undefined,
    'the bootstrap escape hatch is still exported from src/auth.ts');
  delete process.env.NODE_ENV;                       // the two conditions the old path leaned on
  delete process.env.SEROS_ALLOW_PASSWORDLESS;

  // 1. a member of a provisioned workspace who has no credential
  scope.addMember('u-nopw', 'No Credential', 'confirmer');
  assert.equal(creds.get('u-nopw')?.passwordHash ?? null, null);
  for (const body of [{ memberId: 'u-nopw' }, { identifier: 'u-nopw', password: '' },
                      { identifier: 'u-nopw', password: 'a guess' }]) {
    resetRateLimits();
    const r = await post('/login', body as Record<string, string>);
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null, 'a session was issued to a member with no password');
  }

  // 2. the case the old path existed for: a workspace where NOBODY has a credential
  const virgin = WorkspaceScope.ensure(db, 'authws-virgin', 'Unprovisioned workspace');
  virgin.addMember('u-first', 'First Person', 'owner');
  assert.equal(MemberCredentials.for(db, virgin).workspaceHasPasswords(), false);
  const was = process.env.SEROS_WORKSPACE;
  process.env.SEROS_WORKSPACE = 'authws-virgin';     // the route reads this per request
  try {
    for (const body of [{ memberId: 'u-first' }, { identifier: 'u-first', password: '' }]) {
      resetRateLimits();
      const r = await post('/login', body as Record<string, string>);
      assert.equal(r.status, 401, 'an unprovisioned workspace let someone in');
      assert.equal(r.headers.get('set-cookie'), null);
    }
  } finally { process.env.SEROS_WORKSPACE = was; }
  assert.ok(auditEvents('session.failed').some((a) => JSON.parse(a.detail ?? '{}').reason === 'no_password'));
  assert.equal(scope.auditRows(500).filter((a) => (a.detail ?? '').includes('bootstrap')).length, 0);
});

test('the sign-in page no longer publishes the roster to anonymous visitors', async () => {
  const html = await (await get('/login')).text();
  for (const leak of ['u-boss', 'Bea Boss', 'u-hand', 'Hal Hand', 'boss@auth.invalid']) {
    assert.ok(!html.includes(leak), `/login leaked ${leak}`);
  }
  assert.ok(html.includes('type="password"'));
});

test('an unknown identity and a wrong password are the same answer, to the byte', async () => {
  resetRateLimits();
  const unknown = await post('/login', { identifier: 'nobody@auth.invalid', password: BOSS_PW });
  const wrongId = await post('/login', { identifier: 'u-nobody', password: BOSS_PW });
  const wrongPw = await post('/login', { identifier: 'boss@auth.invalid', password: 'not the password' });
  const suspended = await post('/login', { identifier: 'u-gone', password: HAND_PW });
  const noPassword = await post('/login', { identifier: 'hand@auth.invalid', password: 'guessing' });
  const bodies = await Promise.all([unknown, wrongId, wrongPw, suspended, noPassword].map((r) => r.text()));
  for (const r of [unknown, wrongId, wrongPw, suspended, noPassword]) {
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
  }
  assert.equal(new Set(bodies).size, 1, 'the failures do not all say the same thing');
  assert.match(bodies[0]!, /Sign-in failed/);
  // ... and the reason an operator needs is in the audit log instead
  const reasons = auditEvents('session.failed').map((a) => JSON.parse(a.detail ?? '{}').reason);
  for (const expected of ['unknown_identifier', 'bad_password', 'not_active', 'no_password']) {
    assert.ok(reasons.includes(expected), `audit is missing reason ${expected}`);
  }
});

test('an unknown identity costs about what a known one costs (no timing oracle)', async () => {
  const unknown: number[] = [], wrong: number[] = [];
  const timed = async (fn: () => Promise<unknown>) => {
    const t0 = process.hrtime.bigint();
    await fn();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  for (let i = 0; i < 9; i++) {                       // interleaved, so drift hits both equally
    resetRateLimits();
    unknown.push(await timed(() => post('/login', { identifier: `u-ghost-${i}`, password: 'a wrong password' })));
    wrong.push(await timed(() => post('/login', { identifier: 'boss@auth.invalid', password: 'a wrong password' })));
  }
  const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const ratio = median(unknown) / median(wrong);
  assert.ok(ratio > 0.5 && ratio < 2.0,
    `unknown-identity replies must not be distinguishable by time: ratio ${ratio.toFixed(2)} ` +
    `(unknown ${median(unknown).toFixed(1)}ms, wrong-password ${median(wrong).toFixed(1)}ms)`);
});

test('a suspended member with the right password still cannot sign in', async () => {
  resetRateLimits();
  const r = await post('/login', { identifier: 'u-gone', password: HAND_PW });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null);
});

// ---------------------------------------------------------------------------
// lockout
// ---------------------------------------------------------------------------

test('N failures lock the account for a cooldown, and the right password does not open it', async () => {
  const before = process.env.SEROS_LOGIN_MAX_ATTEMPTS;
  const beforeMs = process.env.SEROS_LOGIN_LOCKOUT_MS;
  process.env.SEROS_LOGIN_MAX_ATTEMPTS = '3';
  process.env.SEROS_LOGIN_LOCKOUT_MS = '1000';
  try {
    for (let i = 0; i < 3; i++) {
      resetRateLimits();
      const r = await post('/login', { identifier: 'u-lock', password: 'wrong every time' });
      assert.equal(r.status, 401);
    }
    const row = creds.get('u-lock')!;
    assert.equal(row.failedAttempts, 3);
    assert.ok(row.lockedUntil! > Date.now(), 'the account should be locked');

    resetRateLimits();
    const denied = await post('/login', { identifier: 'u-lock', password: HAND_PW });   // correct!
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('set-cookie'), null);
    assert.ok(auditEvents('session.failed').some((a) => {
      const d = JSON.parse(a.detail ?? '{}');
      return d.member_id === 'u-lock' && d.reason === 'locked' && a.outcome === 'denied';
    }), 'the lockout is not in the audit log');

    await new Promise((r) => setTimeout(r, 1100));                                       // cooldown
    const cookie = await signIn('u-lock', HAND_PW);
    assert.equal(sessionOf(cookie).memberId, 'u-lock');
    assert.equal(creds.get('u-lock')!.failedAttempts, 0, 'a success must clear the counter');
    assert.equal(creds.get('u-lock')!.lockedUntil, null);
  } finally {
    process.env.SEROS_LOGIN_MAX_ATTEMPTS = before;
    process.env.SEROS_LOGIN_LOCKOUT_MS = beforeMs;
  }
});

// ---------------------------------------------------------------------------
// session rotation
// ---------------------------------------------------------------------------

test('every sign-in mints a new session id, so a cookie from before it is not the one after', async () => {
  const first = await signIn('u-boss', BOSS_PW);
  const second = await signIn('u-boss', BOSS_PW);
  const a = sessionOf(first), b = sessionOf(second);
  assert.notEqual(first, second);
  assert.ok(a.sid && b.sid);
  assert.notEqual(a.sid, b.sid);
  assert.notEqual(csrfToken(a), csrfToken(b), 'the CSRF token must move with the session id');
});

test('a password change ends every other session, including the one it was stolen into', async () => {
  const stolen = await signIn('u-boss', BOSS_PW);       // the attacker's copy
  const mine = await signIn('u-boss', BOSS_PW);
  assert.equal((await get('/whoami', stolen)).status, 200);

  const next = 'a-brand-new-long-password';
  resetRateLimits();
  const changed = await post('/password',
    { csrf: csrfToken(sessionOf(mine)), current: BOSS_PW, password: next, confirm: next }, mine);
  assert.equal(changed.status, 303);
  const rotated = cookieOf(changed);
  assert.notEqual(sessionOf(rotated).sid, sessionOf(mine).sid);

  const stolenNow = await get('/whoami', stolen);
  assert.equal(stolenNow.status, 303);
  assert.equal(stolenNow.headers.get('location'), '/login');
  assert.equal((await get('/whoami', mine)).status, 303, 'even the pre-change cookie of the changer is dead');
  assert.equal((await get('/whoami', rotated)).status, 200, 'the rotated session must keep working');

  // the old password is genuinely gone, the new one works
  resetRateLimits();
  assert.equal((await post('/login', { identifier: 'u-boss', password: BOSS_PW })).status, 401);
  const back = await signIn('u-boss', next);
  assert.equal(sessionOf(back).memberId, 'u-boss');
  // put it back for the tests that follow
  const c = csrfToken(sessionOf(back));
  resetRateLimits();
  const undo = await post('/password', { csrf: c, current: next, password: BOSS_PW, confirm: BOSS_PW }, back);
  assert.equal(undo.status, 303);
  assert.ok(auditEvents('password.changed').some((a) => a.outcome === 'ok'));
});

test('changing a password needs the current one, and CSRF is still enforced', async () => {
  const cookie = await signIn('u-boss', BOSS_PW);
  const csrf = csrfToken(sessionOf(cookie));

  resetRateLimits();
  const noCsrf = await post('/password', { current: BOSS_PW, password: 'x'.repeat(14), confirm: 'x'.repeat(14) }, cookie);
  assert.equal(noCsrf.status, 403);

  resetRateLimits();
  const stale = await post('/password',
    { csrf: csrfToken({ ...sessionOf(cookie), sid: 'a-different-session-id' }), current: BOSS_PW,
      password: 'another-fine-password', confirm: 'another-fine-password' }, cookie);
  assert.equal(stale.status, 403, 'a token minted for a different session id must not work');

  resetRateLimits();
  const wrongCurrent = await post('/password',
    { csrf, current: 'not my password', password: 'another-fine-password', confirm: 'another-fine-password' }, cookie);
  assert.equal(wrongCurrent.status, 303);
  assert.match(wrongCurrent.headers.get('location')!, /err=/);
  assert.ok(await verifyPassword(BOSS_PW, creds.get('u-boss')!.passwordHash), 'the password must be unchanged');
  assert.ok(auditEvents('password.changed').some((a) => a.outcome === 'denied'));

  resetRateLimits();
  const mismatch = await post('/password', { csrf, current: BOSS_PW, password: 'a-good-long-password', confirm: 'different' }, cookie);
  assert.match(mismatch.headers.get('location')!, /not%20the%20same/);
  assert.ok(await verifyPassword(BOSS_PW, creds.get('u-boss')!.passwordHash));

  resetRateLimits();
  const weak = await post('/password', { csrf, current: BOSS_PW, password: 'short', confirm: 'short' }, cookie);
  assert.match(weak.headers.get('location')!, /err=/);
  assert.ok(await verifyPassword(BOSS_PW, creds.get('u-boss')!.passwordHash));
});

test('signing out clears the cookie and refuses a cross-origin POST', async () => {
  const cookie = await signIn('u-boss', BOSS_PW);
  const forged = await post('/logout', {}, cookie);
  assert.equal(forged.status, 403, 'a logout without a CSRF token is a write someone else drove');
  const out = await post('/logout', { csrf: csrfToken(sessionOf(cookie)) }, cookie);
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie') ?? '', /seros_session=;/);
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
});

// ---------------------------------------------------------------------------
// invites
// ---------------------------------------------------------------------------

test('an admin issues an invite: raw token shown once, only a hash stored, single use, time limited', async () => {
  const boss = await signIn('u-boss', BOSS_PW);
  resetRateLimits();
  const issued = await post('/members/invite', { csrf: csrfToken(sessionOf(boss)), memberId: 'u-hand' }, boss);
  assert.equal(issued.status, 303);
  const token = new URL(issued.headers.get('location')!, 'http://x').searchParams.get('token')!;
  assert.ok(token && token.length >= 32);

  const row = creds.get('u-hand')!;
  assert.equal(row.inviteTokenHash, hashToken(token));
  assert.notEqual(row.inviteTokenHash, token, 'the raw token must not be what is stored');
  assert.ok(!JSON.stringify(row).includes(token), 'the raw token is somewhere in the credential row');
  assert.ok(row.inviteExpiresAt! > Date.now());
  for (const a of scope.auditRows(500)) assert.ok(!(a.detail ?? '').includes(token), 'a token reached the audit log');

  const formPage = await (await get('/set-password?token=' + encodeURIComponent(token))).text();
  assert.ok(formPage.includes('name="token"'));

  // a password that fails the policy does NOT spend the invite
  resetRateLimits();
  const weak = await post('/set-password', { token, password: 'short', confirm: 'short' });
  assert.match(weak.headers.get('location')!, /err=/);
  assert.equal(creds.get('u-hand')!.inviteTokenHash, hashToken(token), 'the invite was spent on a refused password');

  const chosen = 'the-password-hal-chose';
  resetRateLimits();
  const ok = await post('/set-password', { token, password: chosen, confirm: chosen });
  assert.equal(ok.status, 303);
  const cookie = cookieOf(ok);
  assert.equal(sessionOf(cookie).memberId, 'u-hand', 'redeeming an invite signs you in on a fresh session');
  assert.equal((await (await get('/whoami', cookie)).json()).memberId, 'u-hand');
  assert.equal(creds.get('u-hand')!.inviteTokenHash, null, 'the invite must be spent');
  assert.ok(await verifyPassword(chosen, creds.get('u-hand')!.passwordHash));

  // single use: the same link again does nothing
  resetRateLimits();
  const replay = await post('/set-password', { token, password: 'yet-another-password', confirm: 'yet-another-password' });
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.get('set-cookie'), null);
  assert.ok(await verifyPassword(chosen, creds.get('u-hand')!.passwordHash), 'a replayed invite changed the password');
  assert.ok(auditEvents('password.set').some((a) => a.outcome === 'denied'));

  // and the new credential is a sign-in
  const again = await signIn('hand@auth.invalid', chosen);
  assert.equal(sessionOf(again).memberId, 'u-hand');
});

test('an expired invite is not redeemable, and an unknown token is refused', async () => {
  const { token, hash } = newInviteToken();
  creds.issueInvite('u-view', hash, Date.now() - 60_000, 1_000);     // expired a minute ago
  assert.equal(creds.inviteValid(token), false);
  assert.equal(creds.claimInvite(token), undefined);
  resetRateLimits();
  const r = await post('/set-password', { token, password: 'a-perfectly-fine-password', confirm: 'a-perfectly-fine-password' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(creds.claimInvite('a token nobody issued'), undefined);
});

test('only an owner or an admin may issue an invite', async () => {
  const viewer = await signIn('u-view', HAND_PW);
  resetRateLimits();
  const r = await post('/members/invite', { csrf: csrfToken(sessionOf(viewer)), memberId: 'u-lock' }, viewer);
  assert.equal(r.status, 403);
  assert.equal(creds.get('u-lock')!.inviteTokenHash, null);
  assert.ok(auditEvents('invite.issued').some((a) => a.outcome === 'denied'));
});

test('the members page shows who has a credential, and never a hash or a token', async () => {
  const boss = await signIn('u-boss', BOSS_PW);
  const html = await (await get('/members', boss)).text();
  assert.ok(html.includes('u-boss') && html.includes('Hal Hand'));
  assert.ok(!html.includes('scrypt$'), 'a password hash reached a page');
  assert.ok(!html.includes(creds.get('u-boss')!.passwordHash!.slice(0, 12)));
});

// ---------------------------------------------------------------------------
// the audit trail
// ---------------------------------------------------------------------------

test('the audit log records the four auth events, with identifiers and nothing else', async () => {
  const started = auditEvents('session.started');
  const failed = auditEvents('session.failed');
  assert.ok(started.length > 0 && started.every((a) => a.outcome === 'ok'));
  assert.ok(failed.length > 0 && failed.every((a) => a.outcome === 'denied'));
  assert.ok(auditEvents('password.set').some((a) => a.outcome === 'ok'));
  assert.ok(auditEvents('password.changed').some((a) => a.outcome === 'ok'));
  // a member actor is always identified, which migration 0005 also insists on
  for (const a of [...started, ...auditEvents('password.changed')].filter((x) => x.actorType === 'member')) {
    assert.ok(a.actorId, 'a member actor without an id');
  }
  // no secret of any kind, ever
  const everything = scope.auditRows(1000).map((a) => a.detail ?? '').join('|');
  for (const secret of [BOSS_PW, HAND_PW, 'the-password-hal-chose', 'a-brand-new-long-password']) {
    assert.ok(!everything.includes(secret), 'a password reached the audit log');
  }
  assert.ok(!everything.includes('scrypt$'), 'a hash reached the audit log');
  assert.ok(!/@/.test(everything), 'an address reached the audit log');
});

test('the audit CHECK from 0005 still refuses a content-shaped detail key, which is why these keys are what they are', () => {
  assert.throws(() => scope.audit('probe', 'ok', { name: 'Bea Boss' } as any), /CHECK/i);
  assert.throws(() => scope.audit('probe', 'ok', { email: 'boss@auth.invalid' } as any), /CHECK/i);
  scope.audit('probe', 'ok', { member_id: 'u-boss', reason: 'bad_password', attempts: 2 });   // accepted
});

test('no password is written to any log line during a sign-in', async () => {
  const lines: string[] = [];
  const log = console.log, err = console.error, warn = console.warn;
  console.log = (...a: any[]) => { lines.push(a.join(' ')); };
  console.error = (...a: any[]) => { lines.push(a.join(' ')); };
  console.warn = (...a: any[]) => { lines.push(a.join(' ')); };
  try {
    resetRateLimits();
    await post('/login', { identifier: 'boss@auth.invalid', password: BOSS_PW });
    await post('/login', { identifier: 'boss@auth.invalid', password: 'a wrong one this time' });
  } finally {
    console.log = log; console.error = err; console.warn = warn;
  }
  const joined = lines.join('\n');
  assert.ok(!joined.includes(BOSS_PW), 'a password was logged');
  assert.ok(!joined.includes('a wrong one this time'), 'a rejected password was logged');
});

// ---------------------------------------------------------------------------
// tenancy
// ---------------------------------------------------------------------------

test('a credential is reachable only through the workspace that owns it', async () => {
  const other = WorkspaceScope.ensure(db, 'authws-other', 'Another workspace');
  const otherCreds = MemberCredentials.for(db, other);
  assert.equal(otherCreds.get('u-boss'), undefined, 'a credential leaked across workspaces');
  assert.equal(otherCreds.byEmail('boss@auth.invalid'), undefined);
  assert.equal(otherCreds.passwordVersion('u-boss'), 0);
  assert.equal(otherCreds.workspaceHasPasswords(), false);
});

test('deleting a member deletes the credential with it', () => {
  const scoped = WorkspaceScope.ensure(db, 'authws-cascade', 'Cascade workspace');
  const c = MemberCredentials.for(db, scoped);
  scoped.addMember('u-temp', 'Temp Person', 'viewer');
  c.setEmail('u-temp', 'temp@authws.invalid');
  assert.ok(c.get('u-temp'));
  db.$client.prepare('DELETE FROM members WHERE workspace_id=? AND id=?').run('authws-cascade', 'u-temp');
  assert.equal(c.get('u-temp'), undefined, 'a credential outlived its member');
});

test('a sign-in transparently upgrades a weaker stored parameter set, without changing the password', async () => {
  creds.setPassword('u-lock', await hashPassword(HAND_PW, { N: 1024, r: 8, p: 1 }));
  const before = creds.get('u-lock')!;
  assert.equal(parseHash(before.passwordHash)!.params.N, 1024);
  const cookie = await signIn('u-lock', HAND_PW);
  const after = creds.get('u-lock')!;
  assert.equal(parseHash(after.passwordHash)!.params.N, 4096, 'the record should have been re-hashed');
  assert.ok(await verifyPassword(HAND_PW, after.passwordHash));
  assert.equal(after.passwordSetAt, before.passwordSetAt,
    'a parameter upgrade is not a password change: it must not sign other sessions out');
  assert.equal((await get('/whoami', cookie)).status, 200);
});

test('a tampered or unsigned cookie is not a session', async () => {
  const cookie = await signIn('u-boss', BOSS_PW);
  const [name, value] = [cookie.split('=')[0]!, decodeURIComponent(cookie.split('=').slice(1).join('='))];
  const [body, mac] = value.split('.') as [string, string];
  const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const forged = Buffer.from(JSON.stringify({ ...s, memberId: 'u-hand' })).toString('base64url');
  for (const bad of [`${forged}.${mac}`, `${body}.${'A'.repeat(mac.length)}`, body, 'nonsense']) {
    const r = await get('/whoami', `${name}=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 303, 'a cookie that is not signed by this server was accepted');
    assert.equal(r.headers.get('location'), '/login');
  }
});

test.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
