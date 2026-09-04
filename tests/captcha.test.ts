/**
 * tests/captcha.test.ts - CAPTCHA generation and verification tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCaptcha, verifyCaptcha } from '../src/captcha';

// Set up env for session secret
process.env.SEROS_SESSION_SECRET = 'test-session-secret-for-captcha-12345';

test('generateCaptcha returns valid question, svg, and signature', () => {
  const c = generateCaptcha();
  assert.ok(c.num1 >= 3 && c.num1 <= 14);
  assert.ok(c.num2 >= 2 && c.num2 <= 13);
  assert.ok(c.question.includes('What is'));
  assert.ok(c.svg.includes('<svg'));
  assert.ok(c.sig.length > 20);
  assert.ok(c.ts > 0);
});

test('verifyCaptcha accepts correct answer with valid signature', () => {
  const c = generateCaptcha();
  const answer = String(c.num1 + c.num2);
  assert.equal(verifyCaptcha(answer, c.sig, c.ts), true);
  assert.equal(verifyCaptcha(` ${answer} `, c.sig, c.ts), true);
});

test('verifyCaptcha rejects incorrect answers or tampered signatures', () => {
  const c = generateCaptcha();
  const wrongAnswer = String(c.num1 + c.num2 + 1);

  assert.equal(verifyCaptcha(wrongAnswer, c.sig, c.ts), false);
  assert.equal(verifyCaptcha('', c.sig, c.ts), false);
  assert.equal(verifyCaptcha(String(c.num1 + c.num2), 'bad-sig', c.ts), false);
});

test('verifyCaptcha rejects expired challenges', () => {
  const c = generateCaptcha();
  const answer = String(c.num1 + c.num2);
  const oldTs = Date.now() - 11 * 60 * 1000; // 11 minutes ago

  assert.equal(verifyCaptcha(answer, c.sig, oldTs), false);
});
