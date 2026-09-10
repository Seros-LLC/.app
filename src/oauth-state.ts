/**
 * OAuth CSRF-state and link-intent storage that survives a serverless deployment.
 *
 * passport-oauth2's default state store keeps the state handle in `req.session`.
 * Behind `express-session`'s default MemoryStore that state lives in one Node
 * process's heap, which is correct for a single long-lived server and wrong here:
 * production runs many short-lived lambda instances, so the instance that handles
 * the provider's callback is usually NOT the one that generated the state. The
 * lookup then misses and every OAuth sign-in fails closed with `oauth_failed`.
 * Measured against production: of 30 requests carrying one session cookie, 13
 * instances recognised it and 17 did not.
 *
 * The state is a CSRF nonce, not a secret and not a session: it only has to come
 * back unmodified from the same browser. So it belongs in a signed cookie, which
 * every instance can verify from SEROS_SESSION_SECRET alone with no shared store.
 * This mirrors how the app's own session already works (src/auth.ts).
 *
 * Each value is HMAC-signed, carries its own expiry, and is scoped to one purpose
 * so a cookie minted for one flow cannot be replayed into another.
 */
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { sessionSecret, readCookie } from './auth';

/** A state nonce is only useful between the redirect out and the redirect back. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function mac(purpose: string, body: string): string {
  return crypto.createHmac('sha256', sessionSecret())
    .update(`${purpose}.${body}`)
    .digest('base64url');
}

/** Sign a payload for exactly one purpose, with an embedded expiry. */
export function sealValue(purpose: string, payload: unknown, ttlMs: number): string {
  const body = b64({ v: payload, exp: Date.now() + ttlMs });
  return `${body}.${mac(purpose, body)}`;
}

/**
 * Verify and decode. Returns null for anything that is not a currently valid
 * signature for this exact purpose: tampered, expired, absent, or minted for a
 * different flow. Never throws on caller-supplied input.
 */
export function unsealValue<T>(purpose: string, raw: string | undefined): T | null {
  if (!raw || !raw.includes('.')) return null;
  const idx = raw.lastIndexOf('.');
  const body = raw.slice(0, idx);
  const given = raw.slice(idx + 1);
  const expect = mac(purpose, body);
  const a = Buffer.from(given), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { v: T; exp: number };
    if (typeof parsed?.exp !== 'number' || Date.now() > parsed.exp) return null;
    return parsed.v;
  } catch { return null; }
}

const secure = () => (process.env.NODE_ENV === 'production' ? '; Secure' : '');

/**
 * SameSite=Lax, not Strict: the provider redirects the browser back to us
 * cross-site, and a Strict cookie is withheld on that navigation - which would
 * reintroduce the very failure this file exists to fix. Lax still withholds the
 * cookie from cross-site POSTs, and the value it carries is a nonce that is
 * verified against the query parameter, so a Lax cookie is the correct scope.
 */
export function setFlowCookie(res: Response, name: string, value: string, ttlMs: number) {
  appendCookie(res, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${secure()}`);
}

export function clearFlowCookie(res: Response, name: string) {
  appendCookie(res, `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure()}`);
}

/**
 * Add a cookie without dropping ones already queued. A plain setHeader would
 * silently discard an earlier Set-Cookie - and the callback clears the state
 * cookie and issues the session cookie on the same response.
 */
function appendCookie(res: Response, cookie: string) {
  const prev = res.getHeader('Set-Cookie');
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev.map(String) : [String(prev)];
  list.push(cookie);
  res.setHeader('Set-Cookie', list);
}

export const OAUTH_STATE_COOKIE = 'seros_oauth_state';

/**
 * A passport-oauth2 `StateStore` backed by the signed cookie above.
 *
 * Arity matters: passport-oauth2 dispatches on `store.length` / `verify.length`,
 * so `store` must take exactly (req, state, meta, cb) and `verify` exactly
 * (req, providedState, cb). Do not add or remove parameters.
 */
export class CookieStateStore {
  constructor(private readonly provider: string) {}

  private get purpose() { return `oauth-state:${this.provider}`; }

  store(req: Request, state: unknown, _meta: unknown, callback: (err: Error | null, handle?: string) => void) {
    try {
      const handle = crypto.randomBytes(24).toString('base64url');
      const res = (req as any).res as Response | undefined;
      if (!res) return callback(new Error('oauth state store: no response object on request'));
      setFlowCookie(res, OAUTH_STATE_COOKIE,
        sealValue(this.purpose, { handle, state: state ?? null }, OAUTH_STATE_TTL_MS),
        OAUTH_STATE_TTL_MS);
      callback(null, handle);
    } catch (err) {
      callback(err as Error);
    }
  }

  verify(req: Request, providedState: string, callback: (err: Error | null, ok?: boolean, info?: { message: string }) => void) {
    const res = (req as any).res as Response | undefined;
    // Single use: the nonce is burned whether or not it verifies, so a captured
    // callback URL cannot be replayed.
    if (res) clearFlowCookie(res, OAUTH_STATE_COOKIE);
    const sealed = unsealValue<{ handle: string; state: unknown }>(this.purpose, readCookie(req, OAUTH_STATE_COOKIE));
    if (!sealed) return callback(null, false, { message: 'Unable to verify authorization request state.' });
    const a = Buffer.from(String(sealed.handle ?? ''));
    const b = Buffer.from(String(providedState ?? ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return callback(null, false, { message: 'Invalid authorization request state.' });
    }
    return callback(null, true, sealed.state as any);
  }
}
