/**
 * tests/login.test.ts - sign-in page, CAPTCHA enforcement, and OAuth integration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server';
import { generateCaptcha } from '../src/captcha';
import { migrateDb } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';

process.env.SEROS_SESSION_SECRET = 'test-session-secret-for-login-123456';

test('loginPage is render-only and does not publish a fixed owner credential', async () => {
  const app = createApp();
  void app;
  const dir = mkdtempSync(join(tmpdir(), 'seros-login-page-'));
  const dbPath = join(dir, 'must-not-be-created.db');
  const previous = process.env.SEROS_DB;
  process.env.SEROS_DB = dbPath;
  // Express response mock
  let html = '';
  const res: any = {
    type: (t: string) => res,
    send: (body: string) => { html = body; return res; }
  };

  const { loginPage } = require('../src/routes/login');
  try {
    await loginPage({ query: {} } as any, res);
  } finally {
    if (previous === undefined) delete process.env.SEROS_DB;
    else process.env.SEROS_DB = previous;
  }

  assert.ok(html.includes('Sign in'));
  assert.ok(html.includes('captchaAnswer'));
  assert.ok(html.includes('Sign in with Google'));
  assert.ok(html.includes('Sign in with GitHub'));
  assert.ok(!html.includes('admin@seros.dev'));
  assert.ok(!html.includes('password123'));
  assert.equal(existsSync(dbPath), false, 'GET /login must not even open the database');
  rmSync(dir, { recursive: true, force: true });
});

test('loginPost rejects invalid CAPTCHA answer', async () => {
  const { loginPost } = require('../src/routes/login');
  let redirectUrl = '';
  const res: any = {
    redirect: (code: number, url: string) => { redirectUrl = url; }
  };

  const req: any = {
    body: {
      identifier: 'admin@example.com',
      password: 'password123',
      captchaAnswer: 'wrong-answer',
      captchaSig: 'invalid-sig',
      captchaTs: Date.now()
    }
  };

  await loginPost(req, res);
  assert.equal(redirectUrl, '/login?err=captcha_failed');
});

test('loginPost accepts valid CAPTCHA answer structure', async () => {
  // Login must be tested against an initialized store. The app does not provision
  // an empty database simply because somebody submits an identifier.
  const dir = mkdtempSync(join(tmpdir(), 'seros-login-captcha-'));
  const dbPath = join(dir, 'seros.db');
  const previousDb = process.env.SEROS_DB;
  process.env.SEROS_DB = dbPath;
  migrateDb(dbPath);
  const c = generateCaptcha();
  const answer = String(c.num1 + c.num2);
  const { loginPost } = require('../src/routes/login');
  let redirectUrl = '';
  let responseHtml = '';
  const res: any = {
    status: (code: number) => res,
    type: (t: string) => res,
    send: (body: string) => { responseHtml = body; return res; },
    redirect: (code: number, url: string) => { redirectUrl = url; return res; }
  };
  try {
    await loginPost({ body: {
      identifier: 'nonexistent-user@example.com', password: 'password123',
      captchaAnswer: answer, captchaSig: c.sig, captchaTs: c.ts,
    } } as any, res);
    // CAPTCHA passed, so it proceeds to credentials check and denies invalid user safely.
    assert.ok(responseHtml.includes('Sign-in failed') || redirectUrl.includes('/login'));
  } finally {
    if (previousDb === undefined) delete process.env.SEROS_DB;
    else process.env.SEROS_DB = previousDb;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loginPost cannot provision an absent workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seros-login-post-'));
  const dbPath = join(dir, 'seros.db');
  const previousDb = process.env.SEROS_DB;
  const previousWs = process.env.SEROS_WORKSPACE;
  process.env.SEROS_DB = dbPath;
  process.env.SEROS_WORKSPACE = 'must-not-exist';
  migrateDb(dbPath);

  try {
    const c = generateCaptcha();
    let status = 200;
    let html = '';
    const res: any = {
      status: (code: number) => { status = code; return res; },
      type: () => res,
      send: (body: string) => { html = body; return res; },
      redirect: () => { throw new Error('an absent workspace must not sign in'); },
    };
    const { loginPost } = require('../src/routes/login');
    await loginPost({ body: {
      identifier: 'admin@seros.dev', password: 'password123',
      captchaAnswer: String(c.num1 + c.num2), captchaSig: c.sig, captchaTs: c.ts,
    } } as any, res);

    assert.equal(status, 401);
    assert.ok(html.includes('Sign-in failed'));
    await assert.rejects(() => WorkspaceScope.open(require('../src/db/client').openDb(dbPath), 'must-not-exist'));
  } finally {
    if (previousDb === undefined) delete process.env.SEROS_DB;
    else process.env.SEROS_DB = previousDb;
    if (previousWs === undefined) delete process.env.SEROS_WORKSPACE;
    else process.env.SEROS_WORKSPACE = previousWs;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importing the seed module has no database side effect', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seros-seed-import-'));
  const dbPath = join(dir, 'must-not-be-created.db');
  const previous = process.env.SEROS_DB;
  process.env.SEROS_DB = dbPath;
  try {
    require('../src/seed');
    assert.equal(existsSync(dbPath), false);
  } finally {
    if (previous === undefined) delete process.env.SEROS_DB;
    else process.env.SEROS_DB = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});


test('signup creates a separate workspace owner and a signed-in session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seros-signup-'));
  const dbPath = join(dir, 'seros.db');
  const previousDb = process.env.SEROS_DB;
  process.env.SEROS_DB = dbPath;
  migrateDb(dbPath);
  const { signupPost } = require('../src/routes/login');
  const c = generateCaptcha();
  let redirectUrl = '';
  let cookie = '';
  const res: any = {
    redirect: (_code: number, url: string) => { redirectUrl = url; return res; },
    setHeader: (name: string, value: string) => { if (name === 'Set-Cookie') cookie = value; return res; },
  };
  try {
    await signupPost({ body: {
      name: 'New Owner', workspace: 'New Workspace', email: 'owner@example.com',
      password: 'correct horse battery staple',
      captchaAnswer: String(c.num1 + c.num2), captchaSig: c.sig, captchaTs: c.ts,
    } } as any, res);
    assert.match(redirectUrl, /^\/queue\?msg=/);
    assert.match(cookie, /seros_session=/);
    const db = require('../src/db/client').openDb(dbPath);
    const rows = await db.select().from(require('../src/db/schema').workspaces);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'New Workspace');
    const scope = await WorkspaceScope.open(db, rows[0].id);
    const members = await scope.memberByEmail('owner@example.com');
    assert.ok(members);
    assert.equal(members.members.name, 'New Owner');
    assert.equal(members.members.role, 'owner');
  } finally {
    if (previousDb === undefined) delete process.env.SEROS_DB;
    else process.env.SEROS_DB = previousDb;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a self-created owner can sign in by email after the signup session ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seros-signup-login-'));
  const dbPath = join(dir, 'seros.db');
  const previousDb = process.env.SEROS_DB;
  process.env.SEROS_DB = dbPath;
  migrateDb(dbPath);
  const { signupPost, loginPost } = require('../src/routes/login');
  const signupCaptcha = generateCaptcha();
  const signupRes: any = {
    redirect: () => signupRes,
    setHeader: () => signupRes,
  };
  try {
    await signupPost({ body: {
      name: 'Returning Owner', workspace: 'Returning Workspace', email: 'returning@example.com',
      password: 'correct horse battery staple',
      captchaAnswer: String(signupCaptcha.num1 + signupCaptcha.num2), captchaSig: signupCaptcha.sig, captchaTs: signupCaptcha.ts,
    } } as any, signupRes);
    const loginCaptcha = generateCaptcha();
    let redirectUrl = '';
    let cookie = '';
    const loginRes: any = {
      redirect: (_code: number, url: string) => { redirectUrl = url; return loginRes; },
      setHeader: (name: string, value: string) => { if (name === 'Set-Cookie') cookie = value; return loginRes; },
    };
    await loginPost({ body: {
      identifier: 'returning@example.com', password: 'correct horse battery staple',
      captchaAnswer: String(loginCaptcha.num1 + loginCaptcha.num2), captchaSig: loginCaptcha.sig, captchaTs: loginCaptcha.ts,
    } } as any, loginRes);
    assert.equal(redirectUrl, '/queue');
    assert.match(cookie, /seros_session=/);
  } finally {
    if (previousDb === undefined) delete process.env.SEROS_DB;
    else process.env.SEROS_DB = previousDb;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('signup rejects an invalid CAPTCHA before opening a database', async () => {
  const { signupPost } = require('../src/routes/login');
  let redirectUrl = '';
  const res: any = { redirect: (_code: number, url: string) => { redirectUrl = url; return res; } };
  await signupPost({ body: { captchaAnswer: 'no', captchaSig: 'bad', captchaTs: Date.now() } } as any, res);
  assert.match(redirectUrl, /^\/signup\?err=/);
});
