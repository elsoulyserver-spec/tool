'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// next-proxy — the UI migration seam (strangler-fig, launch-safe)
//
// The Next.js frontend runs as a SEPARATE service. The legacy `server.js` app
// server owns the front door and proxies ONLY explicitly-migrated UI routes to
// that service. Everything else — /api/*, tool.html, existing static — is left
// completely untouched.
//
// Safety properties (see docs/EASYTRAC-P0-IMPLEMENTATION-PLAN.html):
//   • INERT BY DEFAULT — does nothing unless NEXT_UI_ENABLED === 'true'.
//   • EXPLICIT ALLOWLIST — only paths in MIGRATED_ROUTES (+ Next runtime assets)
//     are ever proxied. Never matches /api/*.
//   • FAIL-SAFE — on upstream error OR timeout, falls back to the legacy app so a
//     dead/slow Next service can never make EasyTrac unavailable.
//   • REVERSIBLE — flip NEXT_UI_ENABLED / edit MIGRATED_ROUTES via env, no code
//     redeploy required.
//
// This module has ZERO dependencies (http/https only) and no side effects at
// require time — all env is read per-request so it is independently testable.
// ══════════════════════════════════════════════════════════════════════════════

const http  = require('http');
const https = require('https');

const DEFAULT_UPSTREAM      = 'http://127.0.0.1:3000';
const DEFAULT_TIMEOUT_MS    = 5000;
const DEFAULT_FALLBACK      = '/dashboard';
const DEFAULT_MIGRATED      = '/home';

function parseList(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function isEnabled(env = process.env) {
  return String(env.NEXT_UI_ENABLED || '').trim().toLowerCase() === 'true';
}

function cleanPath(urlPath) {
  const noQuery = String(urlPath || '/').split('?')[0].split('#')[0];
  return noQuery.replace(/\/+$/, '') || '/';
}

// Decide whether a request path should be proxied to the Next.js service.
// Returns false whenever the feature flag is off, so the default deployment
// behaves EXACTLY as it does today.
function shouldProxyToNext(urlPath, env = process.env) {
  if (!isEnabled(env)) return false;

  const clean = cleanPath(urlPath);

  // Hard guard: NEVER proxy the API surface. The backend keeps owning /api/*.
  if (clean === '/api' || clean.startsWith('/api/')) return false;

  // Next.js runtime assets & data must reach the Next service so the page hydrates.
  if (clean === '/_next' || clean.startsWith('/_next/')) return true;
  if (clean.startsWith('/__nextjs')) return true; // dev error overlay (harmless in prod)

  // Explicit route allowlist — this is the strangler boundary.
  const migrated = new Set(parseList(env.MIGRATED_ROUTES || DEFAULT_MIGRATED));
  return migrated.has(clean);
}

// Default fail-safe: bounce the browser to the legacy app so it stays usable.
// A 302 (not an error page) means a flaky Next service degrades to "you're back
// in the app you had yesterday" rather than a broken screen.
function defaultFallback(req, res, fallbackRoute, err) {
  if (err) {
    // eslint-disable-next-line no-console
    console.warn('[next-proxy] upstream failed → fallback', fallbackRoute, '·', err.message);
  }
  try {
    if (!res.headersSent) {
      res.writeHead(302, { Location: fallbackRoute, 'Cache-Control': 'no-store' });
    }
  } catch (_) { /* headers already sent — nothing safe to do */ }
  try { res.end(); } catch (_) {}
}

// Reverse-proxy the request to the Next.js service. Same-origin from the
// browser's perspective (the browser only ever talks to the legacy origin),
// which is what keeps the Firebase auth session shared across both UIs.
function proxyToNext(req, res, opts = {}) {
  const env           = opts.env || process.env;
  const upstream      = opts.upstream || env.NEXT_UPSTREAM || DEFAULT_UPSTREAM;
  const timeoutMs     = Number(opts.timeoutMs || env.NEXT_PROXY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const fallbackRoute = opts.fallbackRoute || env.NEXT_FALLBACK_ROUTE || DEFAULT_FALLBACK;
  const onFallback    = opts.onFallback || defaultFallback;

  let target;
  try {
    target = new URL(upstream);
  } catch (_) {
    return onFallback(req, res, fallbackRoute, new Error('invalid NEXT_UPSTREAM: ' + upstream));
  }

  const transport = target.protocol === 'https:' ? https : http;

  const headers = { ...req.headers };
  headers.host = target.host;
  headers['x-forwarded-host']  = req.headers.host || '';
  headers['x-forwarded-proto'] = (req.socket && req.socket.encrypted) ? 'https' : 'http';

  // Guarantee we only ever respond once (success OR fallback, never both).
  let settled = false;
  const settle = fn => { if (settled) return; settled = true; fn(); };

  const upstreamReq = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port:     target.port || (target.protocol === 'https:' ? 443 : 80),
    method:   req.method,
    path:     req.url,
    headers,
    timeout:  timeoutMs,
  }, upstreamRes => {
    settle(() => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
  });

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('next upstream timeout after ' + timeoutMs + 'ms'));
  });
  upstreamReq.on('error', err => {
    settle(() => onFallback(req, res, fallbackRoute, err));
  });

  req.pipe(upstreamReq);
}

module.exports = {
  isEnabled,
  shouldProxyToNext,
  proxyToNext,
  defaultFallback,
  parseList,
  cleanPath,
};
