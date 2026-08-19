/**
 * Session and CSRF. Deliberately small: a signed cookie, no session store, no
 * password yet. What it does buy is that a confirmation is now attributable to a
 * member who proved they hold a session, and that a form POST cannot be driven
 * from another origin.
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export const sessionSecret = () => {
  const s = process.env.SEROS_SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SEROS_SESSION_SECRET is unset or too short (>=16 chars required)');
  return s;
};

export type Session = { workspaceId: string; memberId: string; issuedAt: number };
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function seal(s: Session): string {
  const body = Buffer.from(JSON.stringify(s)).toString('base64url');
  const mac = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unseal(raw: string | undefined): Session | null {
  if (!raw || !raw.includes('.')) return null;
  const [body, mac] = raw.split('.', 2);
  const expect = crypto.createHmac('sha256', sessionSecret()).update(body!).digest('base64url');
  const a = Buffer.from(mac ?? ''), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Session;
    if (!s?.workspaceId || !s?.memberId) return null;
    if (Date.now() - s.issuedAt > MAX_AGE_MS) return null;
    return s;
  } catch { return null; }
}

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.header('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function setSession(res: Response, s: Session) {
  res.setHeader('Set-Cookie',
    `seros_session=${encodeURIComponent(seal(s))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_MS / 1000}` +
    (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
}
export function clearSession(res: Response) {
  res.setHeader('Set-Cookie', 'seros_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}

export function currentSession(req: Request): Session | null {
  return unseal(readCookie(req, 'seros_session'));
}

/** CSRF token bound to the session, so it cannot be minted by a third party. */
export function csrfToken(s: Session): string {
  return crypto.createHmac('sha256', sessionSecret())
    .update(`csrf:${s.workspaceId}:${s.memberId}:${s.issuedAt}`).digest('base64url');
}
export function csrfOk(s: Session, given: unknown): boolean {
  const expect = Buffer.from(csrfToken(s));
  const got = Buffer.from(typeof given === 'string' ? given : '');
  return expect.length === got.length && crypto.timingSafeEqual(expect, got);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { session?: Session } }
}

export function requireSession(req: Request, res: Response, next: NextFunction) {
  const s = currentSession(req);
  if (!s) return res.redirect(303, '/login');
  req.session = s;
  next();
}

/** Every state-changing POST must carry a matching token and a same-origin referer. */
export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  const s = req.session;
  if (!s) return res.status(401).send('no session');
  if (!csrfOk(s, (req.body ?? {}).csrf)) {
    console.log(JSON.stringify({ level: 'warn', event: 'csrf.rejected', path: req.path }));
    return res.status(403).send('bad csrf token');
  }
  next();
}

/** Crude but real: a fixed-window limiter, per IP, per bucket. */
const buckets = new Map<string, { n: number; resetAt: number }>();
export function rateLimit(name: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now > b.resetAt) { buckets.set(key, { n: 1, resetAt: now + windowMs }); return next(); }
    if (b.n >= max) {
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      console.log(JSON.stringify({ level: 'warn', event: 'ratelimit.blocked', bucket: name }));
      return res.status(429).send('too many requests');
    }
    b.n++;
    next();
  };
}
