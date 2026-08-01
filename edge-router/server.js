'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_BASE_DOMAIN = 'sgtm.easytrac.io';
const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const DEFAULT_MAX_CACHE = 10_000;

function env(name, fallback) {
  const value = (process.env[name] || '').trim();
  return value || fallback;
}

function parseHost(hostHeader, baseDomain = DEFAULT_BASE_DOMAIN) {
  const host = String(hostHeader || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  const suffix = `.${String(baseDomain).toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes('.')) return null;
  if (label.endsWith('-preview')) {
    const slug = label.slice(0, -'-preview'.length);
    if (!slug) return null;
    return { slug, target: 'preview', hostname: host };
  }
  return { slug: label, target: 'tagging', hostname: host };
}

class TtlLruCache {
  constructor(maxSize = DEFAULT_MAX_CACHE) {
    this.maxSize = maxSize;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

function firestoreString(fields, name) {
  const field = fields && fields[name];
  if (!field) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  return null;
}

function parseFirestoreRoute(doc) {
  const fields = doc && doc.fields || {};
  return {
    clientId: firestoreString(fields, 'clientId'),
    taggingRunUrl: firestoreString(fields, 'taggingRunUrl'),
    previewRunUrl: firestoreString(fields, 'previewRunUrl'),
    status: firestoreString(fields, 'status') || 'active',
  };
}

function metadataToken() {
  const staticToken = env('EDGE_FIRESTORE_TOKEN', '');
  if (staticToken) return Promise.resolve(staticToken);

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'metadata.google.internal',
      path: '/computeMetadata/v1/instance/service-accounts/default/token',
      method: 'GET',
      headers: { 'Metadata-Flavor': 'Google' },
      timeout: 2000,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (res.statusCode < 200 || res.statusCode >= 300 || !parsed.access_token) {
            reject(new Error(`metadata token failed: ${res.statusCode}`));
            return;
          }
          resolve(parsed.access_token);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('metadata token timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchFirestoreRoute(slug, opts = {}) {
  const projectId = opts.projectId || env('FIRESTORE_PROJECT_ID', env('GOOGLE_CLOUD_PROJECT', ''));
  if (!projectId) throw new Error('FIRESTORE_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required');
  const token = opts.token || await (opts.getToken || metadataToken)();
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
    `/databases/(default)/documents/managed_routes/${encodeURIComponent(slug)}`;
  const response = await (opts.fetch || fetch)(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Firestore route lookup failed: ${response.status}`);
  return parseFirestoreRoute(await response.json());
}

function makeRouteResolver(opts = {}) {
  const cache = opts.cache || new TtlLruCache(opts.maxCache || DEFAULT_MAX_CACHE);
  const lookup = opts.lookupRoute || (slug => fetchFirestoreRoute(slug, opts));

  return async function resolveRoute(slug) {
    const cached = cache.get(slug);
    if (cached !== undefined) return cached;
    const route = await lookup(slug);
    if (!route || route.status !== 'active') {
      cache.set(slug, null, NEGATIVE_TTL_MS);
      return null;
    }
    cache.set(slug, route, POSITIVE_TTL_MS);
    return route;
  };
}

function proxyTo(req, res, targetUrl, parsedHost) {
  let target;
  try { target = new URL(targetUrl); }
  catch (_) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid upstream route' }));
    return;
  }

  const transport = target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  headers.host = target.host;
  headers['x-forwarded-host'] = parsedHost.hostname;
  headers['x-forwarded-proto'] = 'https';

  const upstream = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: req.url,
    headers,
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', err => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream unavailable', message: err.message }));
  });
  req.pipe(upstream);
}

function createEdgeServer(opts = {}) {
  const baseDomain = opts.baseDomain || env('SGTM_BASE_DOMAIN', DEFAULT_BASE_DOMAIN);
  const resolveRoute = opts.resolveRoute || makeRouteResolver(opts);

  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/__edge/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const parsed = parseHost(req.headers.host, baseDomain);
    if (!parsed) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown host' }));
      return;
    }

    try {
      const route = await resolveRoute(parsed.slug);
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'route not found' }));
        return;
      }
      const targetUrl = parsed.target === 'preview' ? route.previewRunUrl : route.taggingRunUrl;
      if (!targetUrl) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'route target not configured' }));
        return;
      }
      proxyTo(req, res, targetUrl, parsed);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'route lookup failed', message: err.message }));
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  createEdgeServer().listen(port, () => {
    console.log(`[edge-router] listening on :${port}`);
  });
}

module.exports = {
  TtlLruCache,
  createEdgeServer,
  fetchFirestoreRoute,
  makeRouteResolver,
  metadataToken,
  parseFirestoreRoute,
  parseHost,
  proxyTo,
};
