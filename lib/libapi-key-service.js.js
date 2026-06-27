'use strict';

const crypto = require('crypto');

const KEY_PREFIX    = 'eas';
const KEY_ID_BYTES  = 6;   // 12 hex chars — used as Firestore doc ID for O(1) lookup
const SECRET_BYTES  = 24;  // 48 hex chars

function _hmacSecret(secret) {
  const k = (process.env.API_KEY_SECRET || '').trim();
  if (!k) throw new Error('API_KEY_SECRET is not set');
  return crypto.createHmac('sha256', k).update(secret).digest('hex');
}

function generate(clientId) {
  const keyId  = crypto.randomBytes(KEY_ID_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
  const rawKey = `${KEY_PREFIX}_${keyId}_${secret}`;
  const keyHash = _hmacSecret(secret);
  return {
    keyId,
    rawKey,
    keyHash,
    prefix:   `${KEY_PREFIX}_${keyId}`,
    clientId,
  };
}

function parse(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return null;
  const parts = rawKey.split('_');
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return null;
  const [, keyId, secret] = parts;
  if (keyId.length !== KEY_ID_BYTES * 2) return null;
  if (secret.length !== SECRET_BYTES * 2) return null;
  return { keyId, secret };
}

function verify(rawKey, storedHash) {
  const parsed = parse(rawKey);
  if (!parsed) return false;
  let expected;
  try { expected = _hmacSecret(parsed.secret); } catch (_) { return false; }
  const a = Buffer.from(expected,       'hex');   // 32 bytes (hex-decoded)
  const b = Buffer.from(storedHash || '', 'hex');   // 32 bytes (hex-decoded)
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generate, parse, verify };
