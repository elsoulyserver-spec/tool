// tests/stale-artifact-safeguard.test.js
//
// Live-server proof for the netlify-site/ stale-pricing safeguard and for the
// P1-4 legal-page footer links, against the REAL server.js static file handler
// — not a standalone QA static server. server.js serves any file under an
// allowed extension by its literal repo-root-relative path (see server.js's
// STATIC_ALLOW_EXT + serveStatic), so "the file is unlinked" is not the same
// claim as "the file is unreachable"; this test proves the latter directly.
//
// Boots a real server.js child process with production credentials blanked
// (no Firestore/GTM reachable) — this only exercises the static file layer.
//
// Run: node --test tests/stale-artifact-safeguard.test.js

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const { spawn } = require('node:child_process');
const path   = require('node:path');

const PORT = 3143;
const ROOT = path.resolve(__dirname, '..');
let child;

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, text: buf }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await req('GET', '/'); return true; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not become ready');
}

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development',
      ADMIN_SECRET_KEY: '', ADMIN_TOKEN: '', ADMIN_EMAILS: '',
      FIREBASE_SA_KEY_JSON: '', GTM_SA_KEY_JSON: '', GTM_ACCOUNT_ID: '' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitReady();
});

after(() => { if (child) child.kill(); });

test('archived stale-pricing snapshot is NOT servable by the real static handler', async () => {
  const r = await req('GET', '/netlify-site/_archive/index.stale-2026-07-12.html.bak');
  assert.strictEqual(r.status, 403, 'expected 403 Forbidden (extension not in STATIC_ALLOW_EXT)');
  assert.ok(!r.text.includes('499') && !r.text.includes('999'),
    'the 403 response body must not leak the archived stale pricing content');
});

test('the old netlify-site/index.html path no longer resolves', async () => {
  const r = await req('GET', '/netlify-site/index.html');
  assert.strictEqual(r.status, 404);
});

test('no live public path serves the old annual pricing', async () => {
  for (const p of ['/netlify-site/_archive/index.stale-2026-07-12.html',
                    '/netlify-site/index.html',
                    '/netlify-site/_archive/index.stale-2026-07-12.html.bak']) {
    const r = await req('GET', p);
    assert.ok(![200].includes(r.status) || (!r.text.includes('499 ') && !r.text.includes('999 ')),
      `${p} must not return 200 with the old pricing (got ${r.status})`);
  }
});

test('privacy.html and terms.html ARE servable on the real app (P1-4 footer links resolve in production)', async () => {
  const priv = await req('GET', '/privacy.html');
  const terms = await req('GET', '/terms.html');
  assert.strictEqual(priv.status, 200, 'privacy.html should be servable');
  assert.strictEqual(terms.status, 200, 'terms.html should be servable');
  assert.match(priv.text, /سياسة الخصوصية/);
  assert.match(terms.text, /شروط الاستخدام/);
});

test('the real landing page footer links point at pages that actually resolve', async () => {
  const home = await req('GET', '/index.html');
  assert.strictEqual(home.status, 200);
  const privHref = home.text.match(/href="([^"]+)"\s*class="footer-link">سياسة الخصوصية/);
  const termsHref = home.text.match(/href="([^"]+)"\s*class="footer-link">شروط الاستخدام/);
  assert.ok(privHref, 'Privacy footer link not found');
  assert.ok(termsHref, 'Terms footer link not found');
  const privResolved = await req('GET', '/' + privHref[1]);
  const termsResolved = await req('GET', '/' + termsHref[1]);
  assert.strictEqual(privResolved.status, 200, privHref[1] + ' must resolve');
  assert.strictEqual(termsResolved.status, 200, termsHref[1] + ' must resolve');
});
