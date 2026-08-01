'use strict';

const crypto = require('crypto');

function hashEmail(email) {
  if (!email) return null;
  const secret = (process.env.AUDIT_HASH_SECRET || process.env.API_KEY_SECRET || '').trim();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(String(email).toLowerCase()).digest('hex');
}

function computeDiff(before, after) {
  const diff = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  keys.forEach(k => {
    const bVal = (before || {})[k];
    const aVal = (after || {})[k];
    if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
      diff[k] = { before: bVal !== undefined ? bVal : null, after: aVal !== undefined ? aVal : null };
    }
  });
  return Object.keys(diff).length ? diff : null;
}

module.exports = { hashEmail, computeDiff };
