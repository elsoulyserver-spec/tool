// tests/edge-router.test.js
// Focused tests for edge-router/server.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const {
  TtlLruCache,
  createEdgeServer,
  fetchFirestoreRoute,
  makeRouteResolver,
  parseFirestoreRoute,
  parseHost,
} = require('../edge-router/server');

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: opts.method || 'GET',
      path: opts.path || '/',
      headers: opts.headers || {},
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('parseHost maps slug and preview hosts under the configured base domain', () => {
  assert.deepEqual(parseHost('abc123.sgtm.easytrac.io', 'sgtm.easytrac.io'), {
    slug: 'abc123',
    target: 'tagging',
    hostname: 'abc123.sgtm.easytrac.io',
  });
  assert.deepEqual(parseHost('abc123-preview.sgtm.easytrac.io:443', 'sgtm.easytrac.io'), {
    slug: 'abc123',
    target: 'preview',
    hostname: 'abc123-preview.sgtm.easytrac.io',
  });
  assert.equal(parseHost('bad.other.example', 'sgtm.easytrac.io'), null);
  assert.equal(parseHost('too.deep.sgtm.easytrac.io', 'sgtm.easytrac.io'), null);
});

test('TtlLruCache expires entries and evicts oldest keys', async () => {
  const cache = new TtlLruCache(2);
  cache.set('a', 1, 50);
  cache.set('b', 2, 1000);
  cache.set('c', 3, 1000);
  assert.equal(cache.get('a'), undefined, 'oldest entry should be evicted');
  assert.equal(cache.get('b'), 2);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(cache.get('b'), 2);
  cache.set('short', 4, 1);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(cache.get('short'), undefined);
});

test('makeRouteResolver caches positive and negative lookups', async () => {
  let calls = 0;
  const resolver = makeRouteResolver({
    lookupRoute: async slug => {
      calls++;
      return slug === 'missing' ? null : { status: 'active', taggingRunUrl: 'https://tag.run.app' };
    },
  });

  assert.ok(await resolver('abc'));
  assert.ok(await resolver('abc'));
  assert.equal(calls, 1);
  assert.equal(await resolver('missing'), null);
  assert.equal(await resolver('missing'), null);
  assert.equal(calls, 2);
});

test('parseFirestoreRoute converts Firestore REST fields to plain route object', () => {
  const route = parseFirestoreRoute({
    fields: {
      clientId: { stringValue: 'client-1' },
      taggingRunUrl: { stringValue: 'https://tag.run.app' },
      previewRunUrl: { stringValue: 'https://prev.run.app' },
      status: { stringValue: 'active' },
    },
  });
  assert.equal(route.clientId, 'client-1');
  assert.equal(route.taggingRunUrl, 'https://tag.run.app');
  assert.equal(route.previewRunUrl, 'https://prev.run.app');
  assert.equal(route.status, 'active');
});

test('edge server health endpoint returns ok without route lookup', async () => {
  const server = createEdgeServer({ lookupRoute: async () => { throw new Error('must not lookup'); } });
  const port = await listen(server);
  try {
    const res = await request(port, { path: '/__edge/healthz' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  } finally {
    server.close();
  }
});

test('edge server proxies tagging and preview hosts to route targets', async () => {
  const upstreamHits = [];
  const upstream = http.createServer((req, res) => {
    upstreamHits.push({
      url: req.url,
      host: req.headers.host,
      forwardedHost: req.headers['x-forwarded-host'],
    });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-ok');
  });
  const upstreamPort = await listen(upstream);
  const target = `http://127.0.0.1:${upstreamPort}`;
  const edge = createEdgeServer({
    baseDomain: 'sgtm.easytrac.io',
    lookupRoute: async slug => {
      assert.equal(slug, 'abc123');
      return {
        status: 'active',
        taggingRunUrl: target,
        previewRunUrl: target,
      };
    },
  });
  const edgePort = await listen(edge);

  try {
    const tag = await request(edgePort, {
      path: '/healthy?x=1',
      headers: { host: 'abc123.sgtm.easytrac.io' },
    });
    const prev = await request(edgePort, {
      path: '/debug',
      headers: { host: 'abc123-preview.sgtm.easytrac.io' },
    });

    assert.equal(tag.status, 200);
    assert.equal(tag.body, 'upstream-ok');
    assert.equal(prev.status, 200);
    assert.equal(upstreamHits[0].url, '/healthy?x=1');
    assert.equal(upstreamHits[0].host, `127.0.0.1:${upstreamPort}`);
    assert.equal(upstreamHits[0].forwardedHost, 'abc123.sgtm.easytrac.io');
    assert.equal(upstreamHits[1].forwardedHost, 'abc123-preview.sgtm.easytrac.io');
  } finally {
    edge.close();
    upstream.close();
  }
});

test('edge server returns 404 for missing route', async () => {
  const server = createEdgeServer({ lookupRoute: async () => null });
  const port = await listen(server);
  try {
    const res = await request(port, { headers: { host: 'missing.sgtm.easytrac.io' } });
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error, 'route not found');
  } finally {
    server.close();
  }
});

test('edge server returns 500 when route lookup throws', async () => {
  const server = createEdgeServer({
    lookupRoute: async () => { throw new Error('firestore unavailable'); },
  });
  const port = await listen(server);
  try {
    const res = await request(port, { headers: { host: 'abc123.sgtm.easytrac.io' } });
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body);
    assert.ok(body.error, 'error field must be set');
  } finally {
    server.close();
  }
});

test('fetchFirestoreRoute: returns parsed route on 200', async () => {
  const doc = {
    fields: {
      clientId:      { stringValue: 'c1' },
      taggingRunUrl: { stringValue: 'https://t.run.app' },
      previewRunUrl: { stringValue: 'https://p.run.app' },
      status:        { stringValue: 'active' },
    },
  };
  const mockFetch = async () => ({ ok: true, status: 200, json: async () => doc });
  const route = await fetchFirestoreRoute('abc123', { projectId: 'proj', token: 'tok', fetch: mockFetch });
  assert.equal(route.taggingRunUrl, 'https://t.run.app');
  assert.equal(route.status, 'active');
});

test('fetchFirestoreRoute: returns null on 404', async () => {
  const mockFetch = async () => ({ ok: false, status: 404 });
  const route = await fetchFirestoreRoute('no-slug', { projectId: 'proj', token: 'tok', fetch: mockFetch });
  assert.equal(route, null);
});

test('fetchFirestoreRoute: throws on non-2xx non-404 status', async () => {
  const mockFetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    () => fetchFirestoreRoute('slug', { projectId: 'proj', token: 'tok', fetch: mockFetch }),
    /route lookup failed/,
  );
});
