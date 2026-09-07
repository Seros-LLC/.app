/**
 * tests/crypto.test.ts — sealed third-party token storage (AES-256-GCM).
 *
 * src/crypto.ts seals Slack/tracker tokens before they reach the database. The
 * round-trip and the "a value this key cannot open returns null" case are
 * already exercised in tests/slack-connection.test.ts; this file pins the parts
 * that are not: key format handling (hex vs base64, wrong length, missing key),
 * encryptionConfigured(), authenticated-encryption tamper detection, and that
 * two seals of the same plaintext differ (fresh IV).
 *
 * The key is set per test via process.env; key() reads it at call time by
 * design, so there is no module-load ordering hazard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { seal, open, encryptionConfigured } from '../src/crypto';

const KEY_BYTES = crypto.randomBytes(32);
const KEY_B64 = KEY_BYTES.toString('base64');
const KEY_HEX = KEY_BYTES.toString('hex');

function withKey<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.SEROS_ENCRYPTION_KEY;
  if (value === undefined) delete process.env.SEROS_ENCRYPTION_KEY;
  else process.env.SEROS_ENCRYPTION_KEY = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SEROS_ENCRYPTION_KEY;
    else process.env.SEROS_ENCRYPTION_KEY = prev;
  }
}

test('a base64 key seals and opens round-trip', () => {
  withKey(KEY_B64, () => {
    const sealed = seal('xoxb-a-secret-token');
    assert.match(sealed, /^v1\./);
    assert.equal(open(sealed), 'xoxb-a-secret-token');
  });
});

test('a hex key is accepted as an equivalent form of the same 32 bytes', () => {
  const sealed = withKey(KEY_B64, () => seal('shared-secret'));
  // sealed under base64, opened under the hex form of the identical bytes
  assert.equal(withKey(KEY_HEX, () => open(sealed)), 'shared-secret');
});

test('each seal uses a fresh IV, so identical plaintext seals differ', () => {
  withKey(KEY_B64, () => {
    const a = seal('same-token');
    const b = seal('same-token');
    assert.notEqual(a, b);
    assert.equal(open(a), 'same-token');
    assert.equal(open(b), 'same-token');
  });
});

test('a tampered ciphertext or tag fails authentication and returns null', () => {
  withKey(KEY_B64, () => {
    const sealed = seal('tamper-target');
    const parts = sealed.split('.');
    // flip a byte in the ciphertext segment
    const ctBuf = Buffer.from(parts[3]!, 'base64url');
    ctBuf[0] = ctBuf[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], ctBuf.toString('base64url')].join('.');
    assert.equal(open(tampered), null, 'GCM auth tag rejects a modified ciphertext');

    // a wrong version prefix is refused outright
    assert.equal(open(['v2', parts[1], parts[2], parts[3]].join('.')), null);
    // a structurally short value is refused
    assert.equal(open('v1.only'), null);
  });
});

test('a value sealed under one key does not open under another', () => {
  const sealed = withKey(KEY_B64, () => seal('cross-key'));
  const otherKey = crypto.randomBytes(32).toString('base64');
  assert.equal(withKey(otherKey, () => open(sealed)), null);
});

test('encryptionConfigured reflects a valid, present key only', () => {
  assert.equal(withKey(KEY_B64, () => encryptionConfigured()), true);
  assert.equal(withKey(KEY_HEX, () => encryptionConfigured()), true);
  assert.equal(withKey(undefined, () => encryptionConfigured()), false);
  // present but the wrong length -> not configured
  assert.equal(withKey(Buffer.alloc(16).toString('base64'), () => encryptionConfigured()), false);
});

test('seal throws when no key is configured', () => {
  withKey(undefined, () => {
    assert.throws(() => seal('no-key-present'), /SEROS_ENCRYPTION_KEY/);
  });
});
