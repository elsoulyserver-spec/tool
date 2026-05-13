// tests/crypto-vault.test.js
// Run: node --test tests/crypto-vault.test.js  (Node 18+ built-in test runner)

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// Set a test key before loading the module
process.env.MASTER_ENCRYPTION_KEY = 'a'.repeat(64); // 64 hex chars = valid 32-byte key

const { encrypt, decrypt, rotateKey, encryptToken, decryptToken } = require('../lib/crypto-vault');

const TEST_KEY_A = 'a'.repeat(64);
const TEST_KEY_B = 'b'.repeat(64);

// ── Round-trip ────────────────────────────────────────────────────────────────
test('encrypt → decrypt round-trip', function () {
  const plain   = 'my-secret-access-token-12345';
  const payload = encrypt(plain, TEST_KEY_A);

  assert.ok(payload.ciphertext, 'ciphertext must exist');
  assert.ok(payload.iv,         'iv must exist');
  assert.ok(payload.authTag,    'authTag must exist');
  assert.equal(payload.iv.length, 24, 'IV must be 12 bytes = 24 hex chars');
  assert.equal(payload.authTag.length, 32, 'authTag must be 16 bytes = 32 hex chars');

  const recovered = decrypt(payload, TEST_KEY_A);
  assert.equal(recovered, plain, 'decrypted value must match original');
});

test('ciphertext differs from plaintext', function () {
  const plain   = 'EAAAAATestToken';
  const payload = encrypt(plain, TEST_KEY_A);
  assert.notEqual(payload.ciphertext, plain, 'ciphertext must not equal plaintext');
});

test('two encryptions of same plaintext produce different ciphertexts (random IV)', function () {
  const plain = 'same-input';
  const p1    = encrypt(plain, TEST_KEY_A);
  const p2    = encrypt(plain, TEST_KEY_A);
  assert.notEqual(p1.iv,         p2.iv,         'IVs must differ');
  assert.notEqual(p1.ciphertext, p2.ciphertext, 'ciphertexts must differ due to random IV');
});

test('wrong key → decryption throws', function () {
  const payload = encrypt('secret', TEST_KEY_A);
  assert.throws(
    function () { decrypt(payload, TEST_KEY_B); },
    /Unsupported state|bad decrypt|auth tag|authentication/i,
    'decrypting with wrong key must throw'
  );
});

test('tampered authTag → decryption throws', function () {
  const payload = encrypt('secret', TEST_KEY_A);
  const tampered = Object.assign({}, payload, { authTag: '0'.repeat(32) });
  assert.throws(
    function () { decrypt(tampered, TEST_KEY_A); },
    Error,
    'tampered authTag must cause failure'
  );
});

test('tampered ciphertext → decryption throws', function () {
  const payload = encrypt('secret', TEST_KEY_A);
  const tampered = Object.assign({}, payload, { ciphertext: payload.ciphertext.slice(0, -2) + 'ff' });
  assert.throws(
    function () { decrypt(tampered, TEST_KEY_A); },
    Error,
    'tampered ciphertext must cause failure'
  );
});

// ── rotateKey ─────────────────────────────────────────────────────────────────
test('rotateKey re-encrypts under new key', function () {
  const plain    = 'token-to-rotate';
  const underA   = encrypt(plain, TEST_KEY_A);
  const rotated  = rotateKey(TEST_KEY_A, TEST_KEY_B, [underA]);
  const recovered = decrypt(rotated[0], TEST_KEY_B);
  assert.equal(recovered, plain, 'rotated token must decrypt under new key');
});

test('rotateKey preserves null entries', function () {
  const result = rotateKey(TEST_KEY_A, TEST_KEY_B, [null, null]);
  assert.equal(result[0], null);
  assert.equal(result[1], null);
});

// ── encryptToken / decryptToken safe helpers ──────────────────────────────────
test('encryptToken returns null for empty string', function () {
  assert.equal(encryptToken(''),    null);
  assert.equal(encryptToken(null),  null);
  assert.equal(encryptToken('   '), null);
});

test('decryptToken returns empty string for null payload', function () {
  assert.equal(decryptToken(null),      '');
  assert.equal(decryptToken(undefined), '');
});

test('encryptToken + decryptToken round-trip', function () {
  const token     = 'EAABsbCS4IIQBA...real-meta-token';
  const payload   = encryptToken(token);
  assert.ok(payload !== null, 'valid token must encrypt to non-null');
  const recovered = decryptToken(payload);
  assert.equal(recovered, token, 'must recover original token');
});

// ── Validation ────────────────────────────────────────────────────────────────
test('missing master key throws', function () {
  const savedKey = process.env.MASTER_ENCRYPTION_KEY;
  delete process.env.MASTER_ENCRYPTION_KEY;
  assert.throws(
    function () { encrypt('x'); },
    /MASTER_ENCRYPTION_KEY is not set/,
    'must throw when key env var is missing'
  );
  process.env.MASTER_ENCRYPTION_KEY = savedKey;
});

test('wrong-length master key throws', function () {
  assert.throws(
    function () { encrypt('x', 'abc'); },
    /must be 64 hex chars/,
    'must throw for wrong-length key'
  );
});

// ── AAD (Additional Authenticated Data) ──────────────────────────────────────
test('AAD: encrypt with AAD then decrypt with same AAD round-trips', function () {
  const plain = 'EAAAATestToken123';
  const aad   = 'uid_abc:meta';
  const p     = encrypt(plain, TEST_KEY_A, aad);
  assert.equal(p.aadVersion, 1, 'payload must mark aadVersion=1');
  const back  = decrypt(p, TEST_KEY_A, aad);
  assert.equal(back, plain);
});

test('AAD: payload encrypted without AAD has no aadVersion field', function () {
  const p = encrypt('x', TEST_KEY_A);
  assert.equal(p.aadVersion, undefined);
});

test('AAD: wrong AAD on decrypt → throws', function () {
  const p = encrypt('secret', TEST_KEY_A, 'uid_a:meta');
  assert.throws(
    function () { decrypt(p, TEST_KEY_A, 'uid_b:meta'); },
    Error,
    'AAD mismatch must fail authentication'
  );
});

test('AAD: missing AAD on AAD-encrypted payload → throws', function () {
  const p = encrypt('secret', TEST_KEY_A, 'uid_a:meta');
  assert.throws(
    function () { decrypt(p, TEST_KEY_A); },
    /requires AAD/,
    'aadVersion=1 payload requires AAD'
  );
});

test('AAD: legacy payload (no aadVersion) decrypts even when AAD passed', function () {
  // Simulate a legacy payload — encrypt without AAD, then decrypt with AAD-passed
  const p = encrypt('legacy', TEST_KEY_A);
  const back = decrypt(p, TEST_KEY_A, 'irrelevant-aad');
  assert.equal(back, 'legacy', 'legacy payloads ignore the supplied AAD');
});

test('AAD: encryptToken / decryptToken accept aad', function () {
  const t   = encryptToken('tok-123', 'uid_x:tiktok');
  assert.equal(t.aadVersion, 1);
  const v   = decryptToken(t, 'uid_x:tiktok');
  assert.equal(v, 'tok-123');
});

test('AAD: decryptToken with wrong AAD returns "" (safe wrapper)', function () {
  const t = encryptToken('tok-456', 'uid_x:meta');
  // decryptToken swallows errors and returns '' — defense for callers that
  // would otherwise throw. The fact that it returns '' (not 'tok-456') is
  // the security guarantee we care about here.
  assert.equal(decryptToken(t, 'uid_y:meta'), '');
});

test('AAD: rotateKey preserves AAD binding', function () {
  const aad   = 'uid_z:ga4';
  const p     = encrypt('rotate-me', TEST_KEY_A, aad);
  const [r]   = rotateKey(TEST_KEY_A, TEST_KEY_B, [p], aad);
  assert.equal(r.aadVersion, 1, 'rotated payload still has aadVersion=1');
  assert.equal(decrypt(r, TEST_KEY_B, aad), 'rotate-me');
  // AAD binding still enforced after rotation
  assert.throws(function () { decrypt(r, TEST_KEY_B, 'wrong-aad'); }, Error);
});
