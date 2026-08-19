/**
 * Passwords, invite tokens, and the row that holds them.
 *
 * node:crypto ONLY - no bcrypt, no argon2, no new dependency. The hash is scrypt
 * with a per-user random salt and the parameters stored alongside it, so the cost
 * can be raised later without a migration and without invalidating old rows:
 *
 *     scrypt$16384$8$1$<salt-base64>$<hash-base64>
 *      ^      ^     ^ ^  ^            ^
 *      |      N     r p  16 random bytes, per user
 *      version tag: everything after it is interpreted by that version's rules
 *
 * Three rules this file exists to keep:
 *   1. a stored credential is never compared with `===`; only crypto.timingSafeEqual;
 *   2. a caller that asks about an identity that does not exist pays the SAME cost
 *      as one that asks about an identity that does (verifyPassword hashes against
 *      a dummy record rather than returning early), so response time does not leak
 *      which member ids and addresses are real;
 *   3. an invite token is stored only as a SHA-256 digest, so the database never
 *      holds anything that can be replayed as a credential.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { openDb } from './db/client';
import { affectedRows } from './db/client';
import { memberCredentials } from './db/schema';

const scryptAsync = promisify(crypto.scrypt) as
  (password: crypto.BinaryLike, salt: crypto.BinaryLike, keylen: number,
   options: crypto.ScryptOptions) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// parameters
// ---------------------------------------------------------------------------

export type ScryptParams = { N: number; r: number; p: number };

const KEY_LEN = 32;
const SALT_LEN = 16;

const int = (name: string, fallback: number, min: number, max: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.floor(n);
};

/** Read at call time, never cached, so a test or an operator can turn the cost down. */
export function defaultParams(): ScryptParams {
  return {
    N: int('SEROS_SCRYPT_N', 16384, 1024, 1 << 20),   // 16384 => ~16 MB, ~50-90 ms
    r: int('SEROS_SCRYPT_R', 8, 1, 32),
    p: int('SEROS_SCRYPT_P', 1, 1, 16),
  };
}

/** scrypt needs 128*N*r bytes; node's default maxmem (32 MB) is below that for N>=16384. */
const memFor = (q: ScryptParams) => Math.max(32 * 1024 * 1024, 256 * q.N * q.r);

export function passwordMinLength(): number { return int('SEROS_PASSWORD_MIN_LEN', 12, 8, 128); }
const PASSWORD_MAX_LENGTH = 256;   // scrypt cost is independent of length; this caps request size only

/**
 * The one place that decides whether a proposed password is acceptable.
 * Returns null when it is, or the sentence to show the human when it is not.
 */
export function passwordPolicyError(plain: unknown): string | null {
  if (typeof plain !== 'string' || plain.length === 0) return 'Choose a password.';
  const min = passwordMinLength();
  if (plain.length < min) return `That password is too short. Use at least ${min} characters.`;
  if (plain.length > PASSWORD_MAX_LENGTH) return `That password is too long. Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (plain.trim().length === 0) return 'Choose a password.';
  if (new Set(plain).size < 4) return 'That password repeats too few distinct characters.';
  return null;
}

// ---------------------------------------------------------------------------
// hash / verify
// ---------------------------------------------------------------------------

/** `scrypt$N$r$p$<salt-b64>$<hash-b64>`, with a fresh 16-byte salt every time. */
export async function hashPassword(plain: string, params: ScryptParams = defaultParams()): Promise<string> {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scryptAsync(Buffer.from(plain, 'utf8'), salt, KEY_LEN,
    { N: params.N, r: params.r, p: params.p, maxmem: memFor(params) });
  return [
    'scrypt', params.N, params.r, params.p,
    salt.toString('base64'), key.toString('base64'),
  ].join('$');
}

/**
 * The same record, computed on this thread. For scripts and test fixtures that
 * cannot await (this project is CommonJS, so there is no top-level await); the
 * request path uses the async `hashPassword` and never this.
 */
export function hashPasswordSync(plain: string, params: ScryptParams = defaultParams()): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(Buffer.from(plain, 'utf8'), salt, KEY_LEN,
    { N: params.N, r: params.r, p: params.p, maxmem: memFor(params) });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$');
}

type Parsed = { params: ScryptParams; salt: Buffer; hash: Buffer };

export function parseHash(stored: unknown): Parsed | null {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const [scheme, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  if (scheme !== 'scrypt') return null;                 // a future version tag lands here
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(params.N) || params.N < 2 || (params.N & (params.N - 1)) !== 0) return null;
  if (!Number.isInteger(params.r) || params.r < 1 || params.r > 64) return null;
  if (!Number.isInteger(params.p) || params.p < 1 || params.p > 64) return null;
  if (params.N > (1 << 22) || params.r * params.p > 1024) return null;   // refuse a hostile cost
  const saltBuf = Buffer.from(salt, 'base64');
  const hashBuf = Buffer.from(hash, 'base64');
  if (saltBuf.length < 8 || hashBuf.length < 16) return null;
  return { params, salt: saltBuf, hash: hashBuf };
}

/** A real, well-formed record used when there is no record: see rule 2 in the header. */
let dummyCache: { key: string; value: string } | null = null;
function dummyHash(): string {
  const q = defaultParams();
  const key = `${q.N}:${q.r}:${q.p}`;
  if (dummyCache?.key === key) return dummyCache.value;
  const salt = crypto.randomBytes(SALT_LEN);
  const digest = crypto.scryptSync(crypto.randomBytes(32), salt, KEY_LEN,
    { N: q.N, r: q.r, p: q.p, maxmem: memFor(q) });
  const value = ['scrypt', q.N, q.r, q.p, salt.toString('base64'), digest.toString('base64')].join('$');
  dummyCache = { key, value };
  return value;
}

/**
 * Constant-time in the two ways that matter: the digests are compared with
 * timingSafeEqual, and a missing or malformed record still pays for a full scrypt
 * against `dummyHash()` before answering false. Never returns true for a null record.
 */
export async function verifyPassword(plain: unknown, stored: string | null | undefined): Promise<boolean> {
  const real = parseHash(stored);
  const rec = real ?? parseHash(dummyHash())!;
  const candidate = typeof plain === 'string' ? plain : '';
  const key = await scryptAsync(Buffer.from(candidate, 'utf8'), rec.salt, rec.hash.length,
    { N: rec.params.N, r: rec.params.r, p: rec.params.p, maxmem: memFor(rec.params) });
  const ok = key.length === rec.hash.length && crypto.timingSafeEqual(key, rec.hash);
  return real !== null && ok;
}

/** True when a stored hash was made with weaker parameters than we now use. */
export function needsRehash(stored: string | null | undefined): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  const want = defaultParams();
  return parsed.params.N < want.N || parsed.params.r < want.r || parsed.params.p < want.p;
}

// ---------------------------------------------------------------------------
// invite tokens
// ---------------------------------------------------------------------------

/** 32 random bytes. Shown to the admin once; only `hash` is ever stored. */
export function newInviteToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
/** Tokens are full-entropy random, so a fast digest is the right tool (no salt, no stretching). */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

export function inviteTtlMs(): number { return int('SEROS_INVITE_TTL_MS', 24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000); }

// ---------------------------------------------------------------------------
// lockout policy
// ---------------------------------------------------------------------------

export function lockoutPolicy(): { maxAttempts: number; cooldownMs: number } {
  return {
    maxAttempts: int('SEROS_LOGIN_MAX_ATTEMPTS', 5, 1, 1000),
    cooldownMs: int('SEROS_LOGIN_LOCKOUT_MS', 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
  };
}

// ---------------------------------------------------------------------------
// the credential row
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof openDb>;
export type CredentialRow = typeof memberCredentials.$inferSelect;

export const normaliseEmail = (raw: unknown): string | null => {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
};

/**
 * Tenancy, the same shape as WorkspaceScope: this cannot be constructed without a
 * scope that already proved its workspace exists, and every statement below
 * injects that workspace id itself. There is no raw-db accessor on this class.
 *
 * (These reads and writes belong on WorkspaceScope. They live here because that
 * file is owned elsewhere this cycle; the exact signatures to move are listed in
 * the handover note.)
 */
export class MemberCredentials {
  private constructor(private readonly db: Db, readonly workspaceId: string) {}

  static for(db: Db, scope: { workspaceId: string }): MemberCredentials {
    if (!scope?.workspaceId) throw new Error('MemberCredentials needs a workspace scope');
    return new MemberCredentials(db, scope.workspaceId);
  }

  private mine(memberId: string) {
    return and(eq(memberCredentials.workspaceId, this.workspaceId), eq(memberCredentials.memberId, memberId));
  }

  async get(memberId: string): Promise<CredentialRow | undefined> {
    return (await this.db.select().from(memberCredentials).where(this.mine(memberId)).limit(1))[0];
  }

  async byEmail(email: string): Promise<CredentialRow | undefined> {
    const e = normaliseEmail(email);
    if (!e) return undefined;
    return (await this.db.select().from(memberCredentials)
      .where(and(eq(memberCredentials.workspaceId, this.workspaceId), eq(memberCredentials.email, e))).limit(1))[0];
  }

  /** Has anyone in this workspace ever set a password? Gates the bootstrap path in src/auth.ts. */
  async workspaceHasPasswords(): Promise<boolean> {
    return (await this.db.select({ memberId: memberCredentials.memberId }).from(memberCredentials)
      .where(and(eq(memberCredentials.workspaceId, this.workspaceId), isNotNull(memberCredentials.passwordHash)))
      .limit(1)).length > 0;
  }

  /** The value a session carries so that changing a password invalidates older sessions. */
  async passwordVersion(memberId: string): Promise<number> {
    return (await this.get(memberId))?.passwordSetAt ?? 0;
  }

  private async ensureRow(memberId: string) {
    await this.db.insert(memberCredentials)
      .values({ workspaceId: this.workspaceId, memberId, failedAttempts: 0 })
      .onConflictDoNothing();
  }

  async setEmail(memberId: string, email: string) {
    const e = normaliseEmail(email);
    if (!e) throw new Error('not an email address');
    await this.ensureRow(memberId);
    await this.db.update(memberCredentials).set({ email: e }).where(this.mine(memberId));
  }

  /**
   * Setting a password always clears the failure counter, the lock and any
   * outstanding invite: a redeemed or replaced credential must not leave a second
   * live way in.
   */
  async setPassword(memberId: string, passwordHash: string, at = Date.now()) {
    await this.ensureRow(memberId);
    await this.db.update(memberCredentials).set({
      passwordHash, passwordSetAt: at,
      failedAttempts: 0, lockedUntil: null,
      inviteTokenHash: null, inviteExpiresAt: null,
    }).where(this.mine(memberId));
  }

  /** A transparent parameter upgrade: the hash changes, the password does NOT, so
   *  password_set_at (and therefore every live session) is deliberately untouched. */
  async updateHash(memberId: string, passwordHash: string) {
    await this.db.update(memberCredentials).set({ passwordHash }).where(this.mine(memberId));
  }

  /** Non-consuming check, so GET /set-password can say "expired" without spending the token. */
  async inviteValid(rawToken: string, now = Date.now()): Promise<boolean> {
    const row = (await this.db.select().from(memberCredentials).where(and(
      eq(memberCredentials.workspaceId, this.workspaceId),
      eq(memberCredentials.inviteTokenHash, hashToken(rawToken)),
    )).limit(1))[0];
    return !!row && !!row.inviteExpiresAt && row.inviteExpiresAt > now;
  }

  async recordSuccess(memberId: string, at = Date.now()) {
    await this.ensureRow(memberId);
    await this.db.update(memberCredentials)
      .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: at })
      .where(this.mine(memberId));
  }

  /** One statement, so two racing attempts cannot both read "4 failures" and write "5". */
  async recordFailure(memberId: string, at = Date.now()): Promise<CredentialRow | undefined> {
    const { maxAttempts, cooldownMs } = lockoutPolicy();
    await this.ensureRow(memberId);
    await this.db.update(memberCredentials).set({
      failedAttempts: sql`${memberCredentials.failedAttempts} + 1`,
      lockedUntil: sql`CASE WHEN ${memberCredentials.failedAttempts} + 1 >= ${maxAttempts}
                            THEN ${at + cooldownMs} ELSE ${memberCredentials.lockedUntil} END`,
    }).where(this.mine(memberId));
    return this.get(memberId);
  }

  /** Only for an operator tool: forget the failures without touching the password. */
  async clearLock(memberId: string) {
    await this.ensureRow(memberId);
    await this.db.update(memberCredentials).set({ failedAttempts: 0, lockedUntil: null })
      .where(this.mine(memberId));
  }

  async issueInvite(memberId: string, tokenHash: string, at = Date.now(), ttlMs = inviteTtlMs()): Promise<number> {
    await this.ensureRow(memberId);
    await this.db.update(memberCredentials).set({
      inviteTokenHash: tokenHash, inviteIssuedAt: at, inviteExpiresAt: at + ttlMs, inviteUsedAt: null,
    }).where(this.mine(memberId));
    return at + ttlMs;
  }

  /**
   * Single use, enforced by the UPDATE itself: the row is claimed by clearing the
   * token hash, and only the caller whose statement changed a row may proceed.
   * A second redemption of the same token changes nothing and gets undefined.
   */
  async claimInvite(rawToken: string, now = Date.now()): Promise<CredentialRow | undefined> {
    const hash = hashToken(rawToken);
    const row = (await this.db.select().from(memberCredentials).where(and(
      eq(memberCredentials.workspaceId, this.workspaceId),
      eq(memberCredentials.inviteTokenHash, hash),
    )).limit(1))[0];
    if (!row) return undefined;                                   // unknown, or already spent
    if (!row.inviteExpiresAt || row.inviteExpiresAt <= now) return undefined;   // time-limited
    const res: any = await this.db.update(memberCredentials)
      .set({ inviteTokenHash: null, inviteUsedAt: now })
      .where(and(this.mine(row.memberId), eq(memberCredentials.inviteTokenHash, hash)));
    if (affectedRows(res) === 0) return undefined;                // someone else spent it first
    return { ...row, inviteTokenHash: null, inviteUsedAt: now };
  }

  /** Ids, timestamps and counts only - never a hash, never a token. */
  async status(memberId: string) {
    const row = await this.get(memberId);
    return {
      member_id: memberId,
      has_password: !!row?.passwordHash,
      password_set_at: row?.passwordSetAt ?? null,
      failed_attempts: row?.failedAttempts ?? 0,
      locked_until: row?.lockedUntil ?? null,
      last_login_at: row?.lastLoginAt ?? null,
      invite_outstanding: !!row?.inviteTokenHash,
      invite_expires_at: row?.inviteTokenHash ? row?.inviteExpiresAt ?? null : null,
    };
  }
}
