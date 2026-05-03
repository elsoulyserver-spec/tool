// ══════════════════════════════════════════════════════════════════════════════
// lib/providers/base.js
// Abstract base class for Server-Side GTM providers.
// All three providers (Stape, GCP, Self-hosted) extend this class.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

let axios = null;
try { axios = require('axios'); } catch (_) {}

const dns = require('dns').promises;
const net = require('net');

// ══════════════════════════════════════════════════════════════════════════════
// SSRF GUARD
// All outbound requests to user-supplied URLs go through assertSafeUrl(). It:
//   1. Forces https:// (or http:// for explicit dev) — no file://, gopher://, etc.
//   2. Resolves DNS and rejects ANY IP in private/loopback/link-local ranges.
//   3. Rejects cloud metadata IPs (169.254.169.254, 100.100.100.200, fd00:ec2::254).
//   4. Validates port whitelist (80, 443, 8080, 8443).
// ══════════════════════════════════════════════════════════════════════════════

const ALLOWED_PORTS    = new Set([80, 443, 8080, 8443]);
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
]);

const METADATA_IPS = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
]);

function _ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function _isPrivateIPv4(ip) {
  if (METADATA_IPS.has(ip)) return true;
  const n = _ipv4ToInt(ip);
  // JS bitwise ops produce signed int32 — coerce back to uint32 with >>> 0.
  function inRange(masked, base) { return ((n & masked) >>> 0) === (base >>> 0); }
  if (inRange(0xff000000, 0x0a000000)) return true; // 10.0.0.0/8
  if (inRange(0xfff00000, 0xac100000)) return true; // 172.16.0.0/12
  if (inRange(0xffff0000, 0xc0a80000)) return true; // 192.168.0.0/16
  if (inRange(0xff000000, 0x7f000000)) return true; // 127.0.0.0/8 loopback
  if (inRange(0xffff0000, 0xa9fe0000)) return true; // 169.254.0.0/16 link-local
  if (inRange(0xff000000, 0x00000000)) return true; // 0.0.0.0/8
  if (inRange(0xffc00000, 0x64400000)) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function _isPrivateIPv6(ip) {
  if (METADATA_IPS.has(ip)) return true;
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    if (net.isIPv4(v4)) return _isPrivateIPv4(v4);
  }
  return false;
}

async function assertSafeUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch (_) { throw new Error('Invalid URL'); }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http/https protocols are allowed');
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new Error('Hostname is blocked');
  }

  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : (parsed.protocol === 'https:' ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) {
    throw new Error('Port ' + port + ' is not allowed');
  }

  if (net.isIP(host)) {
    if (net.isIPv4(host) && _isPrivateIPv4(host)) throw new Error('Private/internal IP is blocked');
    if (net.isIPv6(host) && _isPrivateIPv6(host)) throw new Error('Private/internal IPv6 is blocked');
    return parsed;
  }

  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new Error('DNS lookup failed: ' + e.message);
  }

  for (const a of addrs) {
    if (a.family === 4 && _isPrivateIPv4(a.address)) {
      throw new Error('Hostname resolves to a private IP — blocked');
    }
    if (a.family === 6 && _isPrivateIPv6(a.address)) {
      throw new Error('Hostname resolves to a private IPv6 — blocked');
    }
  }
  return parsed;
}

async function withRetry(fn, maxAttempts) {
  maxAttempts = maxAttempts || 3;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e.response && e.response.status;
      if (status && status >= 400 && status < 500) throw e;
      if (i < maxAttempts - 1) {
        await new Promise(function (r) { setTimeout(r, Math.pow(2, i) * 1000); });
      }
    }
  }
  throw lastErr;
}

function getAxios() {
  if (!axios) throw new Error('axios is not installed. Run `npm install axios`.');
  return axios.create({ timeout: 8000, validateStatus: null });
}

class BaseProvider {
  constructor(config) {
    this.config = config || {};
  }

  async deployContainer(_config) {
    throw new Error(this.constructor.name + ': deployContainer() is not implemented');
  }

  async validateUrl(url) {
    if (!url || !/^https?:\/\/.+\..+/.test(url)) {
      return { valid: false, latencyMs: null, status: null, error: 'Invalid URL format' };
    }
    try { await assertSafeUrl(url); }
    catch (e) { return { valid: false, latencyMs: null, status: null, error: e.message }; }

    const http  = getAxios();
    const start = Date.now();
    try {
      const resp = await withRetry(async function () {
        return http.head(url, { timeout: 5000, maxRedirects: 0 });
      }, 2);
      const latencyMs = Date.now() - start;
      const valid     = resp.status >= 200 && resp.status < 500;
      const version   = resp.headers && (resp.headers['x-gtm-server-preview'] || resp.headers['x-sgtm-version'] || null);
      return { valid, latencyMs, status: resp.status, version };
    } catch (e) {
      return { valid: false, latencyMs: Date.now() - start, status: null, error: e.message };
    }
  }

  async sendTestEvent(url, payload) {
    if (!url) return { ok: false, error: 'Missing server URL' };
    try { await assertSafeUrl(url); }
    catch (e) { return { ok: false, status: null, latencyMs: null, error: e.message }; }

    const http  = getAxios();
    const start = Date.now();
    const endpoint = url.replace(/\/$/, '') + '/g/collect';
    try {
      const resp = await withRetry(async function () {
        return http.post(endpoint, payload, {
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'EasyTrack-SST-Tester/1.0' },
          timeout: 5000,
          maxRedirects: 0,
        });
      });
      const latencyMs = Date.now() - start;
      const ok        = resp.status >= 200 && resp.status < 300;
      return {
        ok,
        status:    resp.status,
        latencyMs,
        body:      typeof resp.data === 'object' ? resp.data : String(resp.data || '').slice(0, 200),
      };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, error: e.message, status: null };
    }
  }

  async getContainerStatus(url) {
    if (!url) return { healthy: false, error: 'Missing server URL' };
    const result = await this.validateUrl(url);
    return {
      healthy:   result.valid,
      latencyMs: result.latencyMs,
      status:    result.status,
    };
  }
}

module.exports = { BaseProvider, withRetry, getAxios, assertSafeUrl };
