/**
 * CAPTCHA generation and verification for authentication forms.
 *
 * Lightweight, offline-safe, CSP-compliant inline SVG CAPTCHA.
 * Uses HMAC signature over (answer + timestamp) using the server's session secret
 * so no state needs to be stored in the database.
 */
import crypto from 'node:crypto';
import { sessionSecret } from './auth';

export interface CaptchaChallenge {
  num1: number;
  num2: number;
  question: string;
  svg: string;
  sig: string;
  ts: number;
}

/**
 * Generate a new math CAPTCHA challenge with an HMAC signature.
 */
export function generateCaptcha(): CaptchaChallenge {
  const num1 = Math.floor(Math.random() * 12) + 3; // 3..14
  const num2 = Math.floor(Math.random() * 12) + 2; // 2..13
  const answer = String(num1 + num2);
  const ts = Date.now();

  const secret = sessionSecret();
  const sig = crypto.createHmac('sha256', secret).update(`${answer}:${ts}`).digest('hex');

  const question = `What is ${num1} + ${num2}?`;

  // Generate a styled SVG image with security noise lines and wavy text
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="46" viewBox="0 0 180 46">
    <rect width="180" height="46" fill="#F4F1EA" rx="4" stroke="#D9D0C3" stroke-width="1"/>
    <!-- Noise lines -->
    <path d="M 10 38 Q 45 10 90 35 T 170 12" fill="none" stroke="rgba(96,138,205,0.3)" stroke-width="2"/>
    <path d="M 5 15 Q 60 40 120 10 T 175 30" fill="none" stroke="rgba(0,9,173,0.15)" stroke-width="1.5"/>
    <line x1="20" y1="8" x2="160" y2="40" stroke="rgba(40,48,83,0.1)" stroke-width="1"/>
    <!-- Challenge text -->
    <text x="90" y="29" font-family="Georgia, serif" font-size="18" font-weight="bold" fill="#283053" text-anchor="middle" letter-spacing="1">${num1} + ${num2} = ?</text>
  </svg>`;

  return { num1, num2, question, svg, sig, ts };
}

/**
 * Verify a submitted CAPTCHA answer against the signature and timestamp.
 */
export function verifyCaptcha(submittedAnswer: string, sig: string, ts: number): boolean {
  if (!submittedAnswer || !sig || !ts || typeof ts !== 'number') return false;

  // Expire challenges older than 10 minutes (600,000 ms)
  const now = Date.now();
  if (now - ts > 10 * 60 * 1000 || ts > now + 60 * 1000) return false;

  const cleanAnswer = submittedAnswer.trim();
  const secret = sessionSecret();
  const expectedSig = crypto.createHmac('sha256', secret).update(`${cleanAnswer}:${ts}`).digest('hex');

  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');

  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
