/**
 * tests/error-chrome.test.ts — every expected refusal is an application page.
 *
 * Three UX findings are pinned here, and all three are about the BODY of a
 * response while its STATUS stays exactly what it was:
 *
 *   1. Ask and Digest dropped the signed-in account controls, so a member saw
 *      "Sign in" on two pages of the app they were signed into and lost their
 *      own sign-out control. They must carry the same member/CSRF context that
 *      Queue, Tasks, Members and Audit build.
 *   2. A failed Slack return redirects to /connect?err=..., and the page said
 *      nothing at all about it.
 *   3. CSRF failure, rate limiting, a malformed review, a viewer confirmation, a
 *      missing draft and a conflict all answered with a bare string such as
 *      `bad csrf token`, leaving no navigation and no way to recover.
 *
 * Each assertion therefore checks the status is UNCHANGED and that the body is
 * now a real page with a role="alert" notice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

process.env.SEROS_SESSION_SECRET = 'test-session-secret-for-chrome-123456';
process.env.SEROS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.SEROS_SLACK = 'fake';

import { openDb, migrateDbAsync } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';
import { csrfToken, requireCsrf, rateLimit, resetRateLimits, type Session } from '../src/auth';
import { confirmHandler } from '../src/routes/confirm';
import { connectPage, channelsSave, disconnect } from '../src/routes/connect';
import { askPage, askPost } from '../src/routes/ask';
import { digestPage } from '../src/routes/digest';

const WS = 'ws-chrome';

/**
 * A response that records what a handler did with it, including headers: the 429
 * assertion is about Retry-After surviving as well as being repeated in words.
 */
function response() {
  let statusCode = 200;
  let body = '';
  let redirectTo = '';
  const headers: Record<string, string> = {};
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    type(_t: string) { return res; },
    send(value: unknown) { body = String(value); return res; },
    redirect(code: number, location: string) { statusCode = code; redirectTo = location; return res; },
    setHeader(k: string, v: string) { headers[k] = String(v); return res; },
  };
  return {
    res, headers,
    get status() { return statusCode; },
    get body() { return body; },
    get redirect() { return redirectTo; },
  };
}

async function fresh(label: string) {
  const path = join(mkdtempSync(join(tmpdir(), `seros-chrome-${label}-`)), 'test.db');
  await migrateDbAsync(path);
  process.env.SEROS_DB = path;
  const db = openDb(path);
  const scope = await WorkspaceScope.ensure(db, WS);
  await scope.addMember('u-owner', 'Ola Owner', 'owner');
  await scope.addMember('u-viewer', 'Vic Viewer', 'viewer');
  return { db, scope, path };
}

const sessionFor = (memberId: string): Session =>
  ({ workspaceId: WS, memberId, issuedAt: Date.now(), sid: `sid-${memberId}`, pv: 0 });

/** The account controls the application header renders for a signed-in member. */
function assertSignedInChrome(html: string, name: string, role: string, where: string) {
  assert.match(html, /class="who"/, `${where}: renders the account badge`);
  assert.ok(html.includes(name), `${where}: names the signed-in member`);
  assert.ok(html.includes(`<span class="role-pill">${role}</span>`), `${where}: shows the role`);
  assert.ok(html.includes('href="/password"'), `${where}: keeps the password link`);
  assert.match(html, /action="\/logout"[\s\S]*Sign out/, `${where}: sign-out stays reachable`);
  assert.ok(!html.includes('<a href="/login" class="linkish">Sign in</a>'),
    `${where}: a signed-in member is never told to sign in`);
}

/** A refusal is an application page, not a sentence. */
function assertErrorPage(html: string, where: string) {
  assert.match(html, /^<!doctype html>/, `${where}: is a whole page`);
  assert.match(html, /<header class="app-header">/, `${where}: keeps the page chrome`);
  assert.match(html, /role="alert"/, `${where}: the failure is announced, not only drawn`);
  assert.match(html, /class="button/, `${where}: offers a way onward`);
  assert.match(html, /<h1>/, `${where}: has a heading that names the outcome`);
}

// ---------------------------------------------------------------------------
// P1-A — Ask and Digest keep the signed-in account controls
// ---------------------------------------------------------------------------

test('GET /ask keeps the signed-in account controls', async () => {
  await fresh('ask-get');
  const out = response();
  await askPage({ serosSession: sessionFor('u-owner'), body: {}, query: {} } as any, out.res);

  assert.equal(out.status, 200);
  assertSignedInChrome(out.body, 'Ola Owner', 'owner', 'GET /ask');
});

test('POST /ask keeps the signed-in account controls', async () => {
  await fresh('ask-post');
  const out = response();
  await askPost({
    serosSession: sessionFor('u-owner'), query: {},
    body: { question: 'What is overdue?', csrf: csrfToken(sessionFor('u-owner')) },
  } as any, out.res);

  assert.equal(out.status, 200);
  assertSignedInChrome(out.body, 'Ola Owner', 'owner', 'POST /ask');
});

test('GET /digest keeps the signed-in account controls', async () => {
  await fresh('digest');
  const out = response();
  await digestPage({ serosSession: sessionFor('u-viewer'), body: {}, query: {} } as any, out.res);

  assert.equal(out.status, 200);
  assertSignedInChrome(out.body, 'Vic Viewer', 'viewer', 'GET /digest');
});

// ---------------------------------------------------------------------------
// P1-B — a failed Slack return is visible on /connect
// ---------------------------------------------------------------------------

for (const [err, phrase] of [
  ['no_code', /without granting access/i],
  ['exchange_failed', /could not be completed/i],
] as const) {
  test(`/connect?err=${err} shows why the connection failed`, async () => {
    await fresh(`connect-${err}`);
    const out = response();
    await connectPage({ serosSession: sessionFor('u-owner'), body: {}, query: { err } } as any, out.res);

    assert.equal(out.status, 200, 'the page itself is not an error status');
    assert.match(out.body, /class="notice bad" role="alert"/, 'the failure is announced');
    assert.match(out.body, phrase);
    assert.match(out.body, /Try connecting Slack again/, 'the retry action is named');
  });
}

test('an unknown err code still explains itself and leaks nothing back into the page', async () => {
  await fresh('connect-unknown');
  const out = response();
  const injected = '<img src=x onerror=alert(1)>';
  await connectPage({ serosSession: sessionFor('u-owner'), body: {}, query: { err: injected } } as any, out.res);

  assert.equal(out.status, 200);
  assert.match(out.body, /class="notice bad" role="alert"/);
  assert.match(out.body, /did not complete/i, 'an unmapped code gets the written fallback');
  assert.ok(!out.body.includes('onerror=alert(1)'),
    'the query value is never a source of words or markup on the page');
});

test('/connect with no err renders no failure notice', async () => {
  await fresh('connect-clean');
  const out = response();
  await connectPage({ serosSession: sessionFor('u-owner'), body: {}, query: {} } as any, out.res);

  assert.equal(out.status, 200);
  assert.ok(!out.body.includes('class="notice bad"'), 'a normal visit is not an error');
});

// ---------------------------------------------------------------------------
// P1-C — expected refusals are pages, with the status untouched
// ---------------------------------------------------------------------------

test('a bad CSRF token is still 403, and now a page with a way back', async () => {
  await fresh('csrf');
  const out = response();
  let nexted = false;
  requireCsrf(
    { serosSession: sessionFor('u-owner'), path: '/confirm', body: { csrf: 'not-the-token' } } as any,
    out.res, () => { nexted = true; },
  );

  assert.equal(nexted, false, 'CSRF is still enforced, not merely reported');
  assert.equal(out.status, 403, 'the status is unchanged');
  assertErrorPage(out.body, 'CSRF refusal');
  assert.match(out.body, /href="\/queue"/, 'offers the return/reload action');
  assert.ok(!out.body.includes('bad csrf token'), 'the bare string is gone');
  assert.ok(!out.body.includes('not-the-token'), 'the submitted token is never echoed');
});

test('a POST with no session is still 401, and now a signed-out page', async () => {
  await fresh('csrf-nosession');
  const out = response();
  let nexted = false;
  requireCsrf({ path: '/confirm', body: {} } as any, out.res, () => { nexted = true; });

  assert.equal(nexted, false);
  assert.equal(out.status, 401, 'the status is unchanged');
  assert.match(out.body, /role="alert"/);
  assert.match(out.body, /href="\/login"/, 'the only useful action is to sign in again');
});

test('a rate-limited request is still 429, keeps Retry-After, and says when to retry', async () => {
  await fresh('ratelimit');
  resetRateLimits();
  const limiter = rateLimit('chrome-test', 1, 45_000);
  const req = { ip: '10.0.0.9', path: '/confirm', body: {} } as any;

  const first = response();
  let allowed = false;
  limiter(req, first.res, () => { allowed = true; });
  assert.equal(allowed, true, 'the first request is inside the window');

  const blocked = response();
  let secondAllowed = false;
  limiter(req, blocked.res, () => { secondAllowed = true; });

  assert.equal(secondAllowed, false, 'the limit is still enforced');
  assert.equal(blocked.status, 429, 'the status is unchanged');
  assert.ok(Number(blocked.headers['Retry-After']) > 0, 'the header is still set');
  assertErrorPage(blocked.body, 'rate limit');
  assert.match(blocked.body, /Wait about \d+ (second|minute)s?/, 'the wait is stated in the page, not only in a header');
  assert.ok(!blocked.body.includes('too many requests'), 'the bare string is gone');
  resetRateLimits();
});

test('a rate-limited sign-in uses the signed-out chrome, not an unusable app header', async () => {
  await fresh('ratelimit-login');
  resetRateLimits();
  const limiter = rateLimit('chrome-login', 1, 30_000);
  const req = { ip: '10.0.0.10', path: '/login', body: {} } as any;
  limiter(req, response().res, () => {});
  const blocked = response();
  limiter(req, blocked.res, () => { assert.fail('the limit must still block'); });

  assert.equal(blocked.status, 429);
  assert.match(blocked.body, /role="alert"/);
  assert.match(blocked.body, /href="\/login"/);
  assert.ok(!blocked.body.includes('href="/queue"'),
    'a visitor who is not signed in is not sent to a page they cannot open');
  resetRateLimits();
});

test('a malformed review is still 400, and now names the fields to fix', async () => {
  const { scope } = await fresh('confirm-400');
  const session = sessionFor('u-owner');
  const out = response();

  await confirmHandler({ serosSession: session, query: {}, body: {
    draftId: 'd-1', decision: 'banana', csrf: csrfToken(session),
  } } as any, out.res);

  assert.equal(out.status, 400, 'the status is unchanged');
  assertErrorPage(out.body, 'malformed review');
  assertSignedInChrome(out.body, 'Ola Owner', 'owner', 'malformed review');
  assert.match(out.body, /decision/, 'the offending field is named');
  assert.ok(!out.body.includes('did not make sense'), 'the bare string is gone');
  void scope;
});

test('a viewer confirmation is still 403, and now an application page', async () => {
  const { scope } = await fresh('confirm-viewer');
  const message = await scope.ingestMessage({
    channelId: 'C-chrome', ts: '9.1', authorId: 'u-owner', body: 'I will send the report tomorrow',
  });
  const draftId = await scope.createDraft({
    sourceMessageId: message.row.id, title: 'Send the report', outcome: 'Report sent',
    kind: 'commitment', confidence: 88, suggestedOwner: null, suggestedDueDate: null, provider: 'fake',
  });
  const session = sessionFor('u-viewer');
  const out = response();

  await confirmHandler({ serosSession: session, query: {}, body: {
    draftId, decision: 'confirm', csrf: csrfToken(session), title: 'Send the report', outcome: 'Report sent',
  } } as any, out.res);

  assert.equal(out.status, 403, 'the status is unchanged');
  assertErrorPage(out.body, 'viewer confirmation');
  assertSignedInChrome(out.body, 'Vic Viewer', 'viewer', 'viewer confirmation');
  assert.match(out.body, /cannot confirm/i);
  const rows = await scope.auditRows();
  assert.ok(rows.some((r) => r.event === 'draft.confirm_denied' && r.outcome === 'denied'),
    'the refusal is still audited');
});

test('a missing draft is still 404, and now an application page', async () => {
  await fresh('confirm-404');
  const session = sessionFor('u-owner');
  const out = response();

  await confirmHandler({ serosSession: session, query: {}, body: {
    draftId: 'no-such-draft', decision: 'confirm', csrf: csrfToken(session),
  } } as any, out.res);

  assert.equal(out.status, 404, 'the status is unchanged');
  assertErrorPage(out.body, 'missing draft');
  assert.ok(!out.body.includes('no such draft'), 'the bare string is gone');
});

test('a second reviewer of the same draft is still 409, and now an application page', async () => {
  const { scope } = await fresh('confirm-409');
  await scope.addMember('u-other', 'Otto Other', 'confirmer');
  const message = await scope.ingestMessage({
    channelId: 'C-chrome', ts: '9.2', authorId: 'u-owner', body: 'I will book the room tomorrow',
  });
  const draftId = await scope.createDraft({
    sourceMessageId: message.row.id, title: 'Book the room', outcome: 'Room booked',
    kind: 'commitment', confidence: 91, suggestedOwner: null, suggestedDueDate: null, provider: 'fake',
  });
  const first = await scope.confirm(draftId, 'confirmed', 'u-other');
  assert.equal(first.ok, true);

  const session = sessionFor('u-owner');
  const out = response();
  await confirmHandler({ serosSession: session, query: {}, body: {
    draftId, decision: 'confirm', csrf: csrfToken(session), title: 'Book the room', outcome: 'Room booked',
  } } as any, out.res);

  assert.equal(out.status, 409, 'the status is unchanged');
  assertErrorPage(out.body, 'confirmation conflict');
  assert.match(out.body, /already reviewed this draft/i, 'the conflict is explained in words');
  assert.ok(!out.body.includes('already_confirmed'), 'the internal reason code is not the page copy');
});

test('an unauthorized channel save is still 403, and now an application page', async () => {
  const { scope } = await fresh('channels-403');
  await scope.recordChannels([{ id: 'C-one', name: 'one', isPrivate: false }]);
  const session = sessionFor('u-viewer');
  const out = response();

  await channelsSave({ serosSession: session, query: {}, body: {
    channel: 'C-one', csrf: csrfToken(session),
  } } as any, out.res);

  assert.equal(out.status, 403, 'the status is unchanged');
  assertErrorPage(out.body, 'channel save');
  assertSignedInChrome(out.body, 'Vic Viewer', 'viewer', 'channel save');
  assert.deepEqual(await scope.selectedChannels(), [], 'the permission record is untouched');
  assert.ok(!out.body.includes('>not allowed<'), 'the bare string is gone');
});

test('an unauthorized disconnect is still 403 and still connected', async () => {
  const { scope } = await fresh('disconnect-403');
  const session = sessionFor('u-viewer');
  const out = response();

  await disconnect({ serosSession: session, query: {}, body: { csrf: csrfToken(session) } } as any, out.res);

  assert.equal(out.status, 403, 'the status is unchanged');
  assertErrorPage(out.body, 'disconnect');
  assert.match(out.body, /cannot disconnect Slack/i);
  void scope;
});
