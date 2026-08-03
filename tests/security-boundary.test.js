// tests/security-boundary.test.js
//
// EVIDENCE SUITE — not a regression gate for a fix. This file exists to prove,
// executably, exactly how far the P1-1/P1-2 web-container fix reaches and where
// it stops. It documents a KNOWN, ACCEPTED architectural limitation as of
// 2026-08-02: the JSON escaping and PII hashing added in
// lib/gtm-config-builder.js run entirely in the customer's BROWSER, inside
// Custom JavaScript variables that only execute when a hit was produced by the
// EasyTrac-generated web GTM container. Server GTM (sGTM) has no Custom
// JavaScript variable type — confirmed by grep: no such capability exists to
// add server-side escaping or hashing without reintroducing a community
// template, which the architecture explicitly forbids (customTemplate: []).
//
// The server container's GA4 client (`type: 'gaaw_client'`) is a STANDARD
// Measurement Protocol receiver: it accepts whatever `ep.*`/`up.*` values arrive
// in an inbound hit and makes them available to every downstream tag via
// `epVar`/`upVar` (GTM's built-in event_parameter/user_property variable types).
// Those GTM variable types have no concept of "was this hit produced by our web
// container" — they just read whatever arrived.
//
// This suite renders each CAPI body with a value that DID NOT pass through
// `ET - JS json_escape` / `ET - JS pii_hashed` — simulating a hit that reached
// the server container by any path OTHER than the generated web container script
// (a direct Measurement Protocol POST, a hand-written gtag() call, a manually
// edited server tag, or a pre-fix/legacy container). Every test in this file
// documents a case where the CURRENT architecture provides NO protection —
// each is intentionally named "UNPROTECTED:" so it cannot be mistaken for a
// passing security guarantee.
//
// Run: node --test tests/security-boundary.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildServerConfig } = require('../lib/gtm-config-builder');

const PIXELS = { meta: '000000000000001', tiktok: 'QATESTTIKTOK001', snap: '00000000-0000-4000-8000-000000000001' };
const TOKENS = { meta: 'QA_FAKE_META', tiktok: 'QA_FAKE_TT', snap: 'QA_FAKE_SNAP' };

const _serverCfg = buildServerConfig({
  ga4MeasurementId: 'G-QATEST0001', sgtmUrl: 'https://qa-sgtm.example.invalid',
  platforms: ['meta', 'tiktok', 'snap'], events: ['purchase'],
  pixelIds: PIXELS, capiTokens: TOKENS,
});
const capiTags = _serverCfg.containerVersion.tag.filter(t => t.type === 'http' && /CAPI|Events API/.test(t.name));
const bodyOf = t => t.parameter.find(p => p.key === 'requestBody').value;

// Simulates GTM's ep.*/up.* variable resolution reading DIRECTLY off an inbound
// hit's parameters — i.e. bypassing the web container's escaper/hasher entirely,
// exactly as sGTM's real event_parameter/user_property variable types do for a
// Measurement Protocol hit that did not come from our generated pixel.
function renderFromRawInboundHit(tpl, rawParams) {
  return tpl.replace(/\{\{([^}]+)\}\}/g, (m, n) => {
    const k = n.trim();
    return Object.prototype.hasOwnProperty.call(rawParams, k) ? String(rawParams[k]) : '';
  });
}

test('ARCHITECTURE FACT: server GTM has no Custom JavaScript variable type', () => {
  // The escaper/hasher are `type: 'jsm'` variables — Custom JavaScript. They
  // only exist in the WEB container. Confirm the server container declares
  // none, which is exactly why the fix could not be placed there.
  const jsmVars = _serverCfg.containerVersion.variable.filter(v => v.type === 'jsm');
  assert.strictEqual(jsmVars.length, 0,
    'if this ever fails, server GTM gained jsm support — re-evaluate whether ' +
    'server-side escaping/hashing is now possible and update this whole suite');
});

test('ARCHITECTURE FACT: the server GA4 client accepts arbitrary inbound ep./up. values by name', () => {
  const ga4Client = _serverCfg.containerVersion.client.find(c => c.type === 'gaaw_client');
  assert.ok(ga4Client, 'expected a gaaw_client (standard Measurement Protocol receiver)');
  // epVar/upVar just declare "read the request parameter with this name" — there
  // is no allowlist, signature, or origin check tying a value to having been
  // produced by our web container's escaper/hasher.
  const upEm = _serverCfg.containerVersion.variable.find(v => v.name === 'ET - up em');
  assert.deepStrictEqual(
    upEm.parameter.map(p => p.value),
    ['user_property', 'em'],
    'ET - up em is just "read whatever user_property named em arrived on this hit"');
});

// ── UNPROTECTED: direct Measurement Protocol / non-web-container traffic ─────

test('UNPROTECTED: a raw (non-web-container) hit with an unquoted product name still breaks the JSON', () => {
  const metaTag = capiTags.find(t => t.name === 'ET - Meta CAPI - Purchase');
  const rawHit = {
    'ET - ep event_id': 'evt-1', 'ET - ep transaction_id': 'T1', 'ET - ep currency': 'SAR',
    'ET - ep content_type': 'product', 'ET - ep page_url': 'https://x.invalid',
    'ET - ep user_agent': 'curl/8.0', 'ET - client_ip_safe': '203.0.113.1',
    'ET - ep event_time': '1754000000', 'ET - epn value': '10', 'ET - ep num_items': '1',
    'ET - ep items_json': '[]', 'ET - up em': '', 'ET - up ph': '', 'ET - up fn': '', 'ET - up ln': '',
    'ET - up external_id': '', 'ET - up fbp': '', 'ET - up fbc': '',
    // The one field an attacker/direct-hit sender controls, UNESCAPED —
    // exactly what a legitimate browser hit would never send raw, because the
    // web container's ET - JS esc content_name would have run first.
    'ET - ep content_name': 'Samsung 55" TV',
  };
  const out = renderFromRawInboundHit(bodyOf(metaTag), rawHit);
  assert.throws(() => JSON.parse(out),
    'EXPECTED (documents the gap): a raw, non-web-container hit with an unescaped ' +
    'quote still corrupts the CAPI request. The escaper only runs in the browser.');
});

test('UNPROTECTED: a raw hit can inject a sibling JSON key into the request body', () => {
  const metaTag = capiTags.find(t => t.name === 'ET - Meta CAPI - Purchase');
  const rawHit = {
    'ET - ep event_id': 'evt-1', 'ET - ep transaction_id': 'T1', 'ET - ep currency': 'SAR',
    'ET - ep content_type': 'product', 'ET - ep page_url': 'https://x.invalid',
    'ET - ep user_agent': 'curl/8.0', 'ET - client_ip_safe': '203.0.113.1',
    'ET - ep event_time': '1754000000', 'ET - epn value': '10', 'ET - ep num_items': '1',
    'ET - ep items_json': '[]', 'ET - up em': '', 'ET - up ph': '', 'ET - up fn': '', 'ET - up ln': '',
    'ET - up external_id': '', 'ET - up fbp': '', 'ET - up fbc': '',
    'ET - ep content_name': 'x","injected_field":"OWNED',
  };
  const parsed = JSON.parse(renderFromRawInboundHit(bodyOf(metaTag), rawHit));
  assert.ok(Object.prototype.hasOwnProperty.call(parsed.data[0].custom_data, 'injected_field'),
    'EXPECTED (documents the gap): the server accepted an injected sibling key from a raw hit.');
});

test('UNPROTECTED: a raw hit can put a plaintext email directly into the Meta/TikTok/Snap request', () => {
  const rawEmail = 'real.customer@example.com';
  for (const t of capiTags) {
    const rawHit = {
      'ET - ep event_id': 'evt-1', 'ET - ep transaction_id': 'T1', 'ET - ep currency': 'SAR',
      'ET - ep content_type': 'product', 'ET - ep content_name': 'X', 'ET - ep page_url': 'https://x.invalid',
      'ET - ep user_agent': 'curl/8.0', 'ET - client_ip_safe': '203.0.113.1',
      'ET - ep event_time': '1754000000', 'ET - epn value': '10', 'ET - ep num_items': '1',
      'ET - ep items_json': '[]', 'ET - up ph': '', 'ET - up fn': '', 'ET - up ln': '',
      'ET - up external_id': '', 'ET - up fbp': '', 'ET - up fbc': '',
      'ET - TikTok Pixel ID': PIXELS.tiktok,
      // A raw hit sets the user_property directly — nothing here ran through
      // ET - JS pii_hashed, because that variable lives in the web container,
      // which this hit never touched.
      'ET - up em': rawEmail,
    };
    const out = renderFromRawInboundHit(bodyOf(t), rawHit);
    assert.ok(out.includes(rawEmail),
      `EXPECTED (documents the gap): ${t.name} forwarded a plaintext email from a raw hit — ` +
      'the server has no independent check that up.em looks like a SHA-256 digest.');
  }
});

// ── UNPROTECTED: legacy/already-deployed containers ───────────────────────────

test('CODE-PATH FACT: create_gtm only builds/imports a config for a client with NO existing server container', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'provision', 'steps', 'create-gtm.js'), 'utf8');
  assert.match(src, /if \(!serverContainerId\)/,
    'the provisioning step must gate container creation on "no existing container" — ' +
    'if this changes, re-check whether existing containers get re-synced automatically');
});

test('CODE-PATH FACT: no code path calls importServerContainerVersion for an ALREADY-provisioned client', () => {
  // importServerContainerVersion (versions:import) is the only mechanism that
  // pushes a freshly-built buildServerConfig() onto an existing live container.
  // There is currently no "republish" / "resync" endpoint for an existing
  // managed server — this means a fix to lib/gtm-config-builder.js protects NEW
  // signups from the moment it ships, but does NOT retroactively reach any
  // customer's already-deployed, already-published container.
  const fs = require('node:fs');
  const path = require('node:path');
  const gtmService = fs.readFileSync(path.join(__dirname, '..', 'gtm-service.js'), 'utf8');
  const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // Distinguish the function's own declaration from actual invocations.
  const isCall = line => /(?:await\s+|=\s*)?importServerContainerVersion\(/.test(line)
    && !/^\s*(?:async\s+)?function\s+importServerContainerVersion/.test(line)
    && !/^module\.exports/.test(line);
  const callLines = [...gtmService.split('\n'), ...serverJs.split('\n')].filter(isCall);

  assert.strictEqual(callLines.length, 1,
    `expected exactly 1 call site (inside provisionServerOnly), found ${callLines.length}: ` +
    JSON.stringify(callLines) +
    ' — if this grew, existing customers may now have a republish path; verify and update ' +
    'the "imported/legacy containers" finding in the security review before trusting it.');
  assert.match(callLines[0], /const imp = await importServerContainerVersion/,
    'the one call site should be the known one inside provisionServerOnly');
});
