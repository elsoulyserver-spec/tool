// tests/public-pages.test.js
//
// Launch-hazard regression suite for the public marketing/legal pages.
//
// Two things this guards against:
//
// 1. P1-3 — the Growth plan advertising delivered features that don't exist
//    (Auto Repair Engine, ROAS Attribution Dashboard). They must carry a قريباً
//    badge, and the approved pricing (25/49 SAR monthly, no annual plan) must
//    not regress.
//
// 2. The stale netlify-site/index.html snapshot that shipped obsolete annual
//    pricing (٤٩٩/٩٩٩ ر.س, "Starter" plan, a سنوي/شهري toggle). That file was
//    archived to netlify-site/_archive/ — this test fails loudly if a file ever
//    reappears at a path a static host would serve as that folder's root, or if
//    stale pricing markers reappear in any currently-servable public page.
//
// Run: node --test tests/public-pages.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── Guard: no servable index.html under netlify-site/ ────────────────────────

test('netlify-site/ has no index.html at its root (would be served as the site root)', () => {
  const p = path.join(ROOT, 'netlify-site', 'index.html');
  assert.ok(!fs.existsSync(p),
    'netlify-site/index.html exists again — see netlify-site/README.md before restoring it. ' +
    'If this is intentional, verify pricing against index.html first.');
});

test('the archived stale snapshot is preserved, not deleted', () => {
  const archived = path.join(ROOT, 'netlify-site', '_archive', 'index.stale-2026-07-12.html.bak');
  assert.ok(fs.existsSync(archived), 'the archived snapshot should still exist — history must not be deleted');
});

test('the archived snapshot does NOT use a server.js-servable extension', () => {
  // server.js's static handler serves ANY file under the repo root whose extension is
  // in STATIC_ALLOW_EXT (.html, .css, images, fonts, .txt, .map) — it is a generic file
  // server keyed on path, not an allowlist of specific pages. A file preserved with the
  // .html extension would still be directly fetchable at
  // /netlify-site/_archive/<name>.html on the real deployed app, unlinked but not inert.
  // See tests/stale-artifact-safeguard.test.js for the live-server proof of this.
  const ALLOWED = new Set(['.html', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp',
    '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.txt', '.map']);
  const archiveDir = path.join(ROOT, 'netlify-site', '_archive');
  for (const name of fs.readdirSync(archiveDir)) {
    const ext = path.extname(name).toLowerCase();
    assert.ok(!ALLOWED.has(ext),
      `netlify-site/_archive/${name} uses extension "${ext}", which server.js's static ` +
      'handler WILL serve by path. Rename it off the allowlist (e.g. .bak) before archiving.');
  }
});

// ── Guard: approved pricing on the real landing page ──────────────────────────

const STALE_MARKERS = [
  /499\s*ر\.?س|٤٩٩\s*ر\.?س/,           // old Starter annual price
  /999\s*ر\.?س|٩٩٩\s*ر\.?س/,           // old Growth annual price
  /وفّر\s*حتى\s*١٦٪/,                    // annual-discount FAQ copy
  /class="billing-btn"/,                // annual/monthly toggle control
  /setBilling\(['"]annual['"]\)/,       // annual toggle handler
  />\s*Starter\s*</,                    // retired plan name
];

const PUBLIC_PAGES = ['index.html', 'privacy.html', 'terms.html'];

for (const page of PUBLIC_PAGES) {
  test(`${page}: no stale annual-pricing markers`, () => {
    const html = read(page);
    for (const re of STALE_MARKERS) {
      assert.ok(!re.test(html), `${page} matches stale marker ${re}`);
    }
  });
}

test('index.html: approved pricing is present and unchanged', () => {
  const html = read('index.html');
  assert.match(html, /<span class="plan-amt">25<\/span>/, 'Basic plan must show 25');
  assert.match(html, /<span class="plan-amt">49<\/span>/, 'Growth plan must show 49');
  assert.match(html, /متجر واحد/, 'Basic plan must say one store');
  assert.match(html, /حتى\s*٣\s*متاجر|حتى\s*3\s*متاجر/, 'Growth plan must say up to 3 stores');
  assert.match(html, /تجربة مجانية لمدة 7 أيام/, '7-day free trial must be advertised');
});

test('index.html: no annual billing toggle or annual price blocks', () => {
  const html = read('index.html');
  assert.ok(!/id="btn-annual"/.test(html), 'no annual billing button');
  assert.ok(!/class="price-annual"/.test(html), 'no price-annual blocks');
  assert.ok(!/سنوياً/.test(html) || /\/ شهرياً/.test(html), 'sanity: page still monthly-first');
});

// ── Guard: unsupported Growth-plan claims must be badged قريباً ───────────────

test('index.html: Auto Repair Engine is marked قريباً, not delivered', () => {
  const html = read('index.html');
  const m = html.match(/Auto Repair Engine[\s\S]{0,400}?<\/li>/);
  assert.ok(m, 'Auto Repair Engine line item not found on the Growth plan');
  assert.match(m[0], /قريباً/, 'Auto Repair Engine must carry a قريباً badge until it ships');
});

test('index.html: ROAS Attribution Dashboard is marked قريباً, not delivered', () => {
  const html = read('index.html');
  const m = html.match(/ROAS Attribution Dashboard[\s\S]{0,400}?<\/li>/);
  assert.ok(m, 'ROAS Attribution Dashboard line item not found on the Growth plan');
  assert.match(m[0], /قريباً/, 'ROAS Attribution Dashboard must carry a قريباً badge until it ships');
});

test('index.html: Server-side Tracking and GTM auto-deploy badges remain accurate', () => {
  const html = read('index.html');
  // These two are correctly badged today — assert they still are, so a future
  // edit that accidentally strips the badge (making them look delivered) is caught.
  const ssMatches = [...html.matchAll(/Server-side Tracking[^<]*(?:<span[^>]*>[^<]*<\/span>)?/g)];
  assert.ok(ssMatches.length > 0, 'expected at least one Server-side Tracking mention');
  for (const m of ssMatches) assert.match(m[0], /قريباً/, 'Server-side Tracking must stay badged قريباً: ' + m[0]);

  assert.match(html, /GTM Managed[\s\S]{0,200}?قريباً/, 'GTM auto-deploy must stay badged قريباً');
});

// ── Guard: footer links must point at real pages, not "#" ────────────────────

test('index.html: Privacy and Terms footer links are wired to real pages', () => {
  const html = read('index.html');
  assert.match(html, /href="privacy\.html"[^>]*class="footer-link"/, 'Privacy link must point to privacy.html');
  assert.match(html, /href="terms\.html"[^>]*class="footer-link"/, 'Terms link must point to terms.html');
  assert.ok(!/href="#"\s*class="footer-link">(?:Privacy|Terms|سياسة الخصوصية|شروط الاستخدام)/.test(html),
    'no placeholder "#" href on the Privacy/Terms footer links');
});

test('privacy.html and terms.html exist, are non-empty, and cross-link each other', () => {
  for (const page of ['privacy.html', 'terms.html']) {
    const html = read(page);
    assert.ok(html.length > 2000, page + ' should not be a stub');
    assert.match(html, /<title>/, page + ' should have a <title>');
  }
  const privacy = read('privacy.html');
  const terms = read('terms.html');
  assert.match(privacy, /href="terms\.html"/, 'privacy.html should link to terms.html');
  assert.match(terms, /href="privacy\.html"/, 'terms.html should link to privacy.html');
  assert.match(privacy, /href="index\.html"/, 'privacy.html should link back home');
  assert.match(terms, /href="index\.html"/, 'terms.html should link back home');
});

test('privacy.html and terms.html visibly flag themselves as pending legal review', () => {
  for (const page of ['privacy.html', 'terms.html']) {
    const html = read(page);
    assert.match(html, /المراجعة القانونية/, page + ' must visibly say it needs legal review');
  }
});

test('privacy.html and terms.html make no fabricated legal claims', () => {
  // These pages must not invent a CR number, VAT number, physical address, or an
  // uptime SLA percentage — none of which were available to confirm.
  const FORBIDDEN = [/رقم\s*السجل\s*التجاري/, /الرقم\s*الضريبي/, /\d{1,2}\.\d{1,3}%\s*(?:uptime|SLA|توفر)/i];
  for (const page of ['privacy.html', 'terms.html']) {
    const html = read(page);
    for (const re of FORBIDDEN) assert.ok(!re.test(html), page + ' contains a fabricated legal claim matching ' + re);
  }
});
