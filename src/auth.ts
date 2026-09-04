/**
 * Session, CSRF, rate limiting - and, since 0006_auth, what a session MEANS.
 *
 * A session is still a signed cookie with no server-side store, but it now says
 * three more things:
 *   - `sid`: a fresh random session id, minted on every sign-in and on every
 *     password change. A cookie that existed before the sign-in is never carried
 *     forward, so a fixated cookie value is not the value the victim ends up with.
 *   - `pv`:  the password version (the member's password_set_at). requireSession
 *     compares it with the stored one, so changing a password logs out every other
 *     session that was issued against the old password - the part of "rotation"
 *     that a stateless cookie cannot get from a new id alone.
 *   - the CSRF token is bound to the session id as well as the member, so a token
 *     minted for a pre-rotation session is refused after rotation.
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type * as expressSession from 'express-session';
import { openDb } from './db/client';
import { MemberCredentials } from './password';

export const sessionSecret = () => {
  const s = process.env.SEROS_SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SEROS_SESSION_SECRET is unset or too short (>=16 chars required)');
  return s;
};

export type Session = {
  workspaceId: string;
  memberId: string;
  issuedAt: number;
  /** Random per sign-in. Absent only on a cookie issued before 0006_auth. */
  sid?: string;
  /** The member's password_set_at at the moment this session was issued (0 = none). */
  pv?: number;
};
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

/** 128 bits of session id. Never derived from anything the caller sent. */
export const newSessionId = () => crypto.randomBytes(16).toString('base64url');

/**
 * Issue a NEW session and hand it to the browser: a new id, a new issue time and
 * therefore a new CSRF token. Called on sign-in, on redeeming an invite and on a
 * password change - never anywhere that merely reads an existing session, so no
 * cookie a caller already holds is ever upgraded in place. Returns the session it
 * wrote, because the caller usually needs the CSRF token for the next page.
 */
export function startSession(res: Response, who: { workspaceId: string; memberId: string; pv?: number }): Session {
  const s: Session = {
    workspaceId: who.workspaceId, memberId: who.memberId,
    issuedAt: Date.now(), sid: newSessionId(), pv: who.pv ?? 0,
  };
  setSession(res, s);
  return s;
}
export function clearSession(res: Response) {
  res.setHeader('Set-Cookie', 'seros_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}

export function currentSession(req: Request): Session | null {
  return unseal(readCookie(req, 'seros_session'));
}

/**
 * CSRF token bound to the session, so it cannot be minted by a third party - and
 * to the session ID, so a token minted before a rotation dies with the session
 * that minted it.
 */
export function csrfToken(s: Session): string {
  return crypto.createHmac('sha256', sessionSecret())
    .update(`csrf:${s.workspaceId}:${s.memberId}:${s.issuedAt}:${s.sid ?? ''}`).digest('base64url');
}
export function csrfOk(s: Session, given: unknown): boolean {
  const expect = Buffer.from(csrfToken(s));
  const got = Buffer.from(typeof given === 'string' ? given : '');
  return expect.length === got.length && crypto.timingSafeEqual(expect, got);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // The app's own signed-cookie session. Kept under a DIFFERENT name from
    // express-session's req.session (which passport needs) to avoid clashing
    // declarations: this one is `serosSession`.
    interface Request { serosSession?: Session }
  }
}

/**
 * One connection for the session check rather than one per request. Keyed by the
 * database path so a test that points SEROS_DB somewhere else still gets its own.
 */
let authDbCache: { key: string; db: ReturnType<typeof openDb> } | null = null;
function authDb() {
  const key = process.env.SEROS_DB ?? '';
  if (!authDbCache || authDbCache.key !== key) authDbCache = { key, db: openDb() };
  return authDbCache.db;
}

/**
 * Is this cookie still speaking for the credential it was issued against?
 * Fails CLOSED: if the credential cannot be read at all, the session is refused
 * rather than trusted.
 */
export async function sessionPasswordCurrent(s: Session): Promise<boolean> {
  try {
    const creds = MemberCredentials.for(authDb(), { workspaceId: s.workspaceId });
    const pv = await creds.passwordVersion(s.memberId);
    return pv === (s.pv ?? 0);
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', event: 'session.check_failed', error: String((err as any)?.message ?? err) }));
    return false;
  }
}

/**
 * Wrap an async middleware so Express properly awaits it and catches errors.
 * Express 5 already forwards a rejected promise returned by a handler, but this
 * keeps the contract explicit for middleware mounted with app.use(), and works
 * whatever the express major is. The return type is deliberately Promise<unknown>:
 * a handler that ends with `return res.status(401).send(...)` resolves to the
 * Response object, and that is not a reason to refuse to wrap it.
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const s = currentSession(req);
  if (!s) return res.redirect(303, '/login');
  // A session issued before the current password is not a session any more: this is
  // what makes a password change end every other sign-in, including a stolen one.
  if (!(await sessionPasswordCurrent(s))) {
    console.log(JSON.stringify({ level: 'warn', event: 'session.superseded' }));
    clearSession(res);
    return res.redirect(303, '/login');
  }
  req.serosSession = s;
  next();
}

/** Every state-changing POST must carry a matching token and a same-origin referer. */
export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  const s = req.serosSession;
  if (!s) return res.status(401).send('no session');
  if (!csrfOk(s, (req.body ?? {}).csrf)) {
    console.log(JSON.stringify({ level: 'warn', event: 'csrf.rejected', path: req.path }));
    return res.status(403).send('bad csrf token');
  }
  next();
}

/*
 * There is NO password-less sign-in path. There was one, gated on NODE_ENV and an
 * env switch, so that a workspace nobody had provisioned yet could still be
 * reached; it was removed deliberately. An authentication story that depends on a
 * deployment getting NODE_ENV right is not an authentication story, and the way in
 * to an unprovisioned workspace is `npm run seed`, `npm run set-password` or
 * `npm run invite` - all of which need a shell on the host, which is the point.
 * The only thing that turns a request into a session is src/routes/login.ts
 * verifying a scrypt record. Do not add a second one.
 */

/** Crude but real: a fixed-window limiter, per IP, per bucket. */
const buckets = new Map<string, { n: number; resetAt: number }>();
/** Test support only: no route reaches this, and it clears counters rather than raising them. */
export function resetRateLimits() { buckets.clear(); }
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

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------
function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.floor(n);
}
export function resetTokenExpiryMs(): number {
  return int('SEROS_RESET_TOKEN_EXPIRY_MS', 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000); // default 1 hour
}

/**
 * Secret used to sign reset tokens. Must be at least 16 characters.
 */
export function resetSecret() {
  const s = process.env.SEROS_RESET_SECRET;
  if (!s || s.length < 16) throw new Error('SEROS_RESET_SECRET is unset or too short (>=16 chars required)');
  return s;
}

/**
 * Generate a reset token for the given email.
 * The token is a base64url-encoded string of:
 *   iv:16 bytes | hmac:32 bytes | payload: JSON string
 * where hmac is HMAC-SHA256(iv + payload, resetSecret()).
 * payload: { email: string, exp: number } (expiry in milliseconds since epoch).
 */
export function resetToken(email: string): string {
  const payload = { email, exp: Date.now() + resetTokenExpiryMs() };
  const payloadBuf = Buffer.from(JSON.stringify(payload));
  const iv = crypto.randomBytes(16);
  const hmac = crypto.createHmac('sha256', resetSecret()).update(Buffer.concat([iv, payloadBuf])).digest();
  const tokenBuf = Buffer.concat([iv, hmac, payloadBuf]);
  return tokenBuf.toString('base64url');
}

/**
 * Verify a reset token and return the email if valid and not expired.
 * Returns null if the token is invalid, expired, or malformed.
 */
export function verifyResetToken(token: string): string | null {
  try {
    const buf = Buffer.from(token, 'base64url');
    if (buf.length < 16 + 32) return null; // iv + hmac at minimum
    const iv = buf.slice(0, 16);
    const hmac = buf.slice(16, 16 + 32);
    const payloadBuf = buf.slice(16 + 32);
    const expected = crypto.createHmac('sha256', resetSecret()).update(Buffer.concat([iv, payloadBuf])).digest();
    if (!crypto.timingSafeEqual(hmac, expected)) return null;
    const payload = JSON.parse(payloadBuf.toString('utf8'));
    if (typeof payload.email !== 'string' || typeof payload.exp !== 'number') return null;
    if (Date.now() > payload.exp) return null;
    return payload.email;
  } catch {
    return null;
  }
}