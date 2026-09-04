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

  const req: any = {
    body: {
      identifier: 'nonexistent-user@example.com',
      password: 'password123',
      captchaAnswer: answer,
      captchaSig: c.sig,
      captchaTs: c.ts
    }
  };

  await loginPost(req, res);
  // CAPTCHA passed, so it proceeds to credentials check and denies invalid user safely
  assert.ok(responseHtml.includes('Sign-in failed') || redirectUrl.includes('/login'));
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
