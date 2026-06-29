// ══════════════════════════════════════════════════════════════════════════════
// lib/crypto-vault.js
// AES-256-GCM symmetric encryption for storing platform access tokens.
//
// Required env var:
//   MASTER_ENCRYPTION_KEY — 64 hex chars (32 bytes).
//   Generate: node -e "require('crypto').randomBytes(32).toString('hex')"
//
// AAD (Additional Authenticated Data) — optional. When supplied to encrypt(),
// the auth tag binds the ciphertext to the AAD so a token cannot be
// silently moved between configs (e.g. user A's Meta token swapped into
// user B's Stape API key slot). Payloads encrypted with AAD carry an
// `aadVersion:1` marker; payloads without it (legacy) decrypt without AAD
// for backward compatibility.
//
// ⚠️  SECURITY: master key is never logged, never returned in API responses,
//     and never stored anywhere except the server process environment.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const crypto        = require('crypto');
const secretManager = require('./secret-manager');

const ALG    = 'aes-256-gcm';
const IV_LEN = 12;   // 96-bit IV (GCM recommended)
const TAG_LEN = 16;  // 128-bit auth tag

// ── Validate + return master key Buffer ──────────────────────────────────────
// Synchronous path for encrypt/decrypt (called many times per request).
// Reads from the in-memory cache populated by secretManager.resolveMasterKey().
// The cache is primed at startup via validateAtStartup() — if it hasn't been
// primed yet (e.g. tests), falls back to the env var directly.
function getMasterKey(override) {
  const hex = override || process.env.MASTER_ENCRYPTION_KEY || '';
  if (!hex) throw new Error('MASTER_ENCRYPTION_KEY is not set in environment');
  if (hex.length !== 64) throw new Error('MASTER_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('MASTER_ENCRYPTION_KEY must be hex-encoded');
  return Buffer.from(hex, 'hex');
}

// Async version — resolves via Secret Manager first, then ENV.
// Use for the startup check; encrypt/decrypt still use the sync path
// (via cached ENV after resolveMasterKey() has primed process.env).
async function getMasterKeyAsync() {
  const { hexKey } = await secretManager.resolveMasterKey();
  // Write back to env so the sync getMasterKey() path keeps working without
  // requiring every call site to be async. This is safe: the value is the
  // same secret, just sourced from Secret Manager instead of the initial env.
  if (hexKey && !process.env.MASTER_ENCRYPTION_KEY) {
    process.env.MASTER_ENCRYPTION_KEY = hexKey;
  }
  return Buffer.from(hexKey, 'hex');
}

// ── Coerce AAD argument to Buffer (or null when absent) ──────────────────────
function _aadToBuffer(aad) {
  if (aad == null || aad === '') return null;
  if (Buffer.isBuffer(aad)) return aad;
  return Buffer.from(String(aad), 'utf8');
}

// ── Encrypt plaintext string ─────────────────────────────────────────────────
// Returns { ciphertext, iv, authTag, aadVersion? } — all hex.
// When `aad` is provided, the result includes aadVersion:1 so decrypt knows
// to require the same AAD on the way back.
function encrypt(plaintext, masterKeyHex, aad) {
  if (typeof plaintext !== 'string') throw new TypeError('encrypt: plaintext must be a string');
  const key    = getMasterKey(masterKeyHex);
  const iv     = crypto.randomBytes(IV_LEN);
  const ciph   = crypto.createCipheriv(ALG, key, iv, { authTagLength: TAG_LEN });
  const aadBuf = _aadToBuffer(aad);
  if (aadBuf) ciph.setAAD(aadBuf);

  let ciphertext = ciph.update(plaintext, 'utf8', 'hex');
  ciphertext    += ciph.final('hex');
  const authTag  = ciph.getAuthTag().toString('hex');

  const payload = {
    ciphertext,
    iv:      iv.toString('hex'),
    authTag,
  };
  if (aadBuf) payload.aadVersion = 1;
  return payload;
}

// ── Decrypt payload ───────────────────────────────────────────────────────────
// payload = { ciphertext, iv, authTag, aadVersion? } — all hex strings.
// When payload.aadVersion === 1, the same `aad` used at encrypt-time MUST be
// supplied. Legacy payloads (no aadVersion) decrypt without AAD regardless
// of what the caller passes, so old records keep working through migration.
function decrypt(payload, masterKeyHex, aad) {
  if (!payload || typeof payload !== 'object') throw new TypeError('decrypt: payload must be an object');
  const { ciphertext, iv, authTag } = payload;
  if (!ciphertext || !iv || !authTag) throw new Error('decrypt: payload missing ciphertext, iv, or authTag');

  const key    = getMasterKey(masterKeyHex);
  const deciph = crypto.createDecipheriv(ALG, key, Buffer.from(iv, 'hex'), { authTagLength: TAG_LEN });

  if (payload.aadVersion === 1) {
    const aadBuf = _aadToBuffer(aad);
    if (!aadBuf) throw new Error('decrypt: payload requires AAD but none was provided');
    deciph.setAAD(aadBuf);
  }

  deciph.setAuthTag(Buffer.from(authTag, 'hex'));
  let plaintext  = deciph.update(ciphertext, 'hex', 'utf8');
  plaintext     += deciph.final('utf8');
  return plaintext;
}

// ── Re-encrypt a list of encrypted payloads under a new master key ───────────
// encryptedItems = Array<{ ciphertext, iv, authTag, aadVersion? } | null>
// `aad` is passed through to both decrypt() and encrypt() so AAD-bound items
// stay AAD-bound after rotation. Pass undefined to rotate legacy items.
function rotateKey(oldKeyHex, newKeyHex, encryptedItems, aad) {
  if (!Array.isArray(encryptedItems)) throw new TypeError('rotateKey: encryptedItems must be an array');
  return encryptedItems.map(function (item) {
    if (!item) return null;
    const plain = decrypt(item, oldKeyHex, aad);
    return encrypt(plain, newKeyHex, aad);
  });
}

// ── Safe encrypt: returns null for empty/null tokens ─────────────────────────
function encryptToken(token, aad) {
  if (!token || !String(token).trim()) return null;
  return encrypt(String(token).trim(), undefined, aad);
}

// ── Safe decrypt: returns '' for null payloads or any error ──────────────────
function decryptToken(payload, aad) {
  if (!payload) return '';
  try { return decrypt(payload, undefined, aad); }
  catch (e) { return ''; }
}

module.exports = { encrypt, decrypt, rotateKey, encryptToken, decryptToken, getMasterKey, getMasterKeyAsync };
