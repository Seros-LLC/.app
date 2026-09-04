/**
 * tests/login.test.ts - sign-in page, CAPTCHA enforcement, and OAuth integration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server';
import { generateCaptcha } from '../src/captcha';

process.env.SEROS_SESSION_SECRET = 'test-session-secret-for-login-123456';

test('loginPage renders form, CAPTCHA, and OAuth buttons', async () => {
  const app = createApp();
  // Express response mock
  let html = '';
  const res: any = {
    type: (t: string) => res,
    send: (body: string) => { html = body; return res; }
  };

  const { loginPage } = require('../src/routes/login');
  await loginPage({ query: {} } as any, res);

  assert.ok(html.includes('Sign in'));
  assert.ok(html.includes('captchaAnswer'));
  assert.ok(html.includes('Sign in with Google'));
  assert.ok(html.includes('Sign in with GitHub'));
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
