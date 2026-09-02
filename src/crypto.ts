/**
 * Secret storage for third-party tokens.
 *
 * A Slack bot token can read every message in every channel the app is in. It is
 * therefore not stored as a column value: it is sealed with AES-256-GCM before
 * it reaches the database, so a leaked backup, a stray SELECT in a log, or a
 * support engineer reading a row does not hand over a customer's Slack.
 *
 * The key comes from SEROS_ENCRYPTION_KEY (32 bytes, base64 or hex). There is no
 * default and no fallback: a deployment that has not set one fails at the moment
 * it tries to store a token, which is the only honest behaviour. Rotating the
 * key invalidates stored tokens, which forces a reconnect rather than a silent
 * decrypt failure.
 */
import crypto from 'node:crypto';

const ALG = 'aes-256-gcm';

function key(): Buffer {
  const raw = process.env.SEROS_ENCRYPTION_KEY;
  if (!raw) throw new Error('SEROS_ENCRYPTION_KEY is required to store third-party tokens');
  const buf = /^[0-9a-fA-F]{64}$/.test(raw.trim())
    ? Buffer.from(raw.trim(), 'hex')
    : Buffer.from(raw.trim(), 'base64');
  if (buf.length !== 32) throw new Error('SEROS_ENCRYPTION_KEY must decode to 32 bytes');
  return buf;
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. Versioned so it can be rotated. */
export function seal(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALG, key(), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** Returns null rather than throwing on a value this key cannot open. */
export function open(sealed: string): string | null {
  try {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) return null;
    const d = crypto.createDecipheriv(ALG, key(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** True when a key is configured, without revealing anything about it. */
export function encryptionConfigured(): boolean {
  try { key(); return true; } catch { return false; }
}
