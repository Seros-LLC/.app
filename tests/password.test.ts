/**
 * tests/password.test.ts — password hashing, invite tokens, and policy.
 *
 * src/password.ts is security-critical (scrypt via node:crypto only) and had no
 * test. These cover its pure, deterministic surface without any database:
 *
 *   - passwordPolicyError: the one gate on an acceptable password;
 *   - hash/verify round-trip, including the salt making two hashes of the same
 *     password differ, and verify refusing a null/garbage record;
 *   - parseHash: accepts a well-formed record, rejects malformed or hostile ones;
 *   - needsRehash: true for weaker-than-current params and for junk;
 *   - invite tokens: only a SHA-256 digest is stored, and hashToken is stable;
 *   - normaliseEmail: trims/lowercases valid addresses, rejects the rest.
 *
 * scrypt cost is turned down via SEROS_SCRYPT_* so the suite is fast; the code
 * reads those at call time (defaultParams) by design.
 */
process.env.SEROS_SCRYPT_N = '1024';
process.env.SEROS_SCRYPT_R = '8';
process.env.SEROS_SCRYPT_P = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  passwordPolicyError,
  passwordMinLength,
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  parseHash,
  needsRehash,
  newInviteToken,
  hashToken,
  normaliseEmail,
  defaultParams,
} from '../src/password';

test('passwordPolicyError accepts a good password and rejects bad ones', () => {
  assert.equal(passwordPolicyError('correct horse battery'), null);
  assert.equal(typeof passwordPolicyError(''), 'string');
  assert.equal(typeof passwordPolicyError(undefined), 'string');
  assert.equal(typeof passwordPolicyError(12345678901234), 'string'); // not a string
  // too short
  assert.match(passwordPolicyError('short') ?? '', /too short/);
  // too few distinct characters (fewer than 4)
  assert.match(passwordPolicyError('aaaaaaaaaaaaaaaa') ?? '', /distinct/);
  // too long
  assert.match(passwordPolicyError('a1B2'.repeat(100)) ?? '', /too long/);
  // exactly at the minimum length with enough variety is accepted
  const min = passwordMinLength();
  assert.equal(passwordPolicyError('aB3d'.repeat(Math.ceil(min / 4)).slice(0, min)), null);
});

test('hashPassword produces a scrypt record that verifies, and is salted', async () => {
  const h1 = await hashPassword('a-good-password-1');
  const h2 = await hashPassword('a-good-password-1');
  assert.match(h1, /^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
  assert.notEqual(h1, h2, 'a fresh salt makes identical passwords hash differently');

  assert.equal(await verifyPassword('a-good-password-1', h1), true);
  assert.equal(await verifyPassword('a-good-password-1', h2), true);
  assert.equal(await verifyPassword('wrong-password', h1), false);
});

test('hashPasswordSync matches the async format and verifies', async () => {
  const h = hashPasswordSync('sync-password-123');
  assert.match(h, /^scrypt\$/);
  assert.equal(await verifyPassword('sync-password-123', h), true);
  assert.equal(await verifyPassword('sync-password-124', h), false);
});

test('verifyPassword never returns true for a null, empty, or malformed record', async () => {
  assert.equal(await verifyPassword('anything', null), false);
  assert.equal(await verifyPassword('anything', undefined), false);
  assert.equal(await verifyPassword('anything', ''), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(await verifyPassword('anything', 'scrypt$1$1$1$short$short'), false);
  // a non-string candidate is treated as empty and still refused
  assert.equal(await verifyPassword(undefined, await hashPassword('some-password-9')), false);
});

test('parseHash accepts a well-formed record and rejects malformed or hostile ones', () => {
  const good = hashPasswordSync('parse-me-please');
  assert.ok(parseHash(good), 'a real record parses');

  assert.equal(parseHash('nope'), null);
  assert.equal(parseHash(42), null);
  assert.equal(parseHash('scrypt$3$8$1$AAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA'), null); // N not a power of two
  assert.equal(parseHash('bcrypt$16384$8$1$AAAA$AAAA'), null); // wrong scheme
  assert.equal(parseHash('scrypt$8388608$8$1$AAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA'), null); // N > 2^22, hostile
  assert.equal(parseHash('scrypt$16384$8$1$AA$AA'), null); // salt/hash too short
});

test('needsRehash is true for weaker-than-current params and for junk, false for current', () => {
  const want = defaultParams();
  const current = hashPasswordSync('rehash-check-pw');
  assert.equal(needsRehash(current), false);

  const weaker = `scrypt$${want.N / 2 >= 2 ? want.N / 2 : 2}$${want.r}$${want.p}$` +
    Buffer.alloc(16).toString('base64') + '$' + Buffer.alloc(32).toString('base64');
  assert.equal(needsRehash(weaker), true);

  assert.equal(needsRehash(null), true);
  assert.equal(needsRehash('garbage'), true);
});

test('invite tokens are stored only as a stable SHA-256 digest', () => {
  const { token, hash } = newInviteToken();
  assert.ok(token.length >= 32);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, token, 'the stored value is a digest, not the token');
  assert.equal(hashToken(token), hash, 'hashToken is deterministic');
  assert.notEqual(hashToken('other'), hash);
});

test('normaliseEmail trims and lowercases valid addresses and rejects the rest', () => {
  assert.equal(normaliseEmail('  Alice@Example.COM '), 'alice@example.com');
  assert.equal(normaliseEmail('bob@sub.example.co.uk'), 'bob@sub.example.co.uk');
  assert.equal(normaliseEmail('not-an-email'), null);
  assert.equal(normaliseEmail('two@@example.com'), null);
  assert.equal(normaliseEmail('spaces in@example.com'), null);
  assert.equal(normaliseEmail(''), null);
  assert.equal(normaliseEmail(null), null);
  assert.equal(normaliseEmail('a@b.c' + 'x'.repeat(300)), null); // over 254 chars
});
