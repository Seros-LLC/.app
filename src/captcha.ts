/** Durable, one-time CAPTCHA challenges for authentication forms. */
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from './db/client';
import { dialect } from './db/client';
import { sessionSecret } from './auth';

export type CaptchaPurpose = 'login' | 'signup';
export interface CaptchaChallenge {
  id: string;
  num1: number;
  num2: number;
  question: string;
  svg: string;
}

const TTL_MS = 10 * 60 * 1000;
const mac = (label: string, value: string) => crypto.createHmac('sha256', sessionSecret())
  .update(`${label}:${value}`).digest('hex');
const subject = (ip: string) => mac('captcha-subject', ip || 'unknown');
const answer = (id: string, value: string) => mac('captcha-answer', `${id}:${value.trim()}`);

function svg(num1: number, num2: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="46" viewBox="0 0 180 46">
    <rect width="180" height="46" fill="#F4F1EA" rx="4" stroke="#D9D0C3" stroke-width="1"/>
    <path d="M 10 38 Q 45 10 90 35 T 170 12" fill="none" stroke="rgba(96,138,205,0.3)" stroke-width="2"/>
    <path d="M 5 15 Q 60 40 120 10 T 175 30" fill="none" stroke="rgba(0,9,173,0.15)" stroke-width="1.5"/>
    <line x1="20" y1="8" x2="160" y2="40" stroke="rgba(40,48,83,0.1)" stroke-width="1"/>
    <text x="90" y="29" font-family="Georgia, serif" font-size="18" font-weight="bold" fill="#283053" text-anchor="middle" letter-spacing="1">${num1} + ${num2} = ?</text>
  </svg>`;
}

/** Issues a random opaque challenge; no raw answer or client address is persisted. */
export async function issueCaptcha(db: Db, purpose: CaptchaPurpose, ip: string, now = Date.now()): Promise<CaptchaChallenge> {
  const num1 = crypto.randomInt(3, 15);
  const num2 = crypto.randomInt(2, 14);
  const id = crypto.randomBytes(32).toString('base64url');
  const result = sql`INSERT INTO captcha_challenges
    (id, purpose, answer_mac, subject_hash, created_at, expires_at)
    VALUES (${id}, ${purpose}, ${answer(id, String(num1 + num2))}, ${subject(ip)}, ${now}, ${now + TTL_MS})`;
  if (dialect() === 'pg') await (db as any).execute(result); else db.run(result);
  return { id, num1, num2, question: `What is ${num1} + ${num2}?`, svg: svg(num1, num2) };
}

/** Atomically checks and spends a challenge; failed answers leave it usable. */
export async function consumeCaptcha(db: Db, id: string, submitted: string, purpose: CaptchaPurpose, ip: string, now = Date.now()): Promise<boolean> {
  if (!id || !submitted) return false;
  const q = sql`UPDATE captcha_challenges SET used_at = ${now}
    WHERE id = ${id} AND purpose = ${purpose} AND answer_mac = ${answer(id, submitted)}
      AND subject_hash = ${subject(ip)} AND used_at IS NULL AND expires_at > ${now}
    RETURNING id`;
  const rows = dialect() === 'pg' ? (await (db as any).execute(q)).rows : db.all(q);
  return (rows as any[]).length === 1;
}
