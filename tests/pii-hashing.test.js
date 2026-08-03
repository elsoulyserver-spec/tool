// tests/pii-hashing.test.js
//
// P1-2 regression suite — plaintext PII leaving for Meta / TikTok / Snapchat.
//
// Before the fix only ecommPlatform 'salla' was safe, because Salla's dataLayer
// supplies customer.email_hashed. Every other storefront (Zid and the generic
// GA4 path) resolved `em` to a lowercased, trimmed PLAINTEXT email, which then
// flowed: user_data.em → GA4 user property → transport_url → sGTM → the em field
// of the Meta, TikTok and Snapchat CAPI bodies. No SHA-256 existed anywhere in
// the shipping pipeline.
//
// sGTM cannot hash without a community template, so hashing happens in the web
// container. These tests execute the ACTUAL generated JavaScript and compare it
// against node:crypto.
//
// Run: node --test tests/pii-hashing.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildWebConfig, buildServerConfig } = require('../lib/gtm-config-builder');

const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const HEX64 = /^[a-f0-9]{64}$/;

function webCfg(ecommPlatform) {
  return buildWebConfig({
    ga4MeasurementId: 'G-QATEST0001', sgtmUrl: 'https://qa-sgtm.example.invalid',
    pixelIds: { meta: '000000000000001', tiktok: 'QATESTTIKTOK001', snap: '00000000-0000-4000-8000-000000000001' },
    events: ['purchase'], ecommPlatform,
  });
}
const jsOf = (cfg, name) => cfg.containerVersion.variable.find(v => v.name === name)
  .parameter.find(p => p.key === 'javascript').value;

// Execute ET - JS pii_hashed for a given platform with a given dataLayer state.
// Substitutes the {{...}} references the way GTM would, then evaluates.
function runPiiHashed(ecommPlatform, dl = {}) {
  const src = jsOf(webCfg(ecommPlatform), 'ET - JS pii_hashed');
  const bind = {
    '{{ET - JS email_normalised}}': (dl.email || '').toLowerCase().trim(),
    '{{ET - JS phone_normalised}}': String(dl.phone || '').replace(/[^0-9]/g, ''),
    '{{ET - JS fn_normalised}}':    (dl.fn || '').toLowerCase().trim(),
    '{{ET - JS ln_normalised}}':    (dl.ln || '').toLowerCase().trim(),
    '{{ET - DLV salla_em_hash}}':   dl.sallaEm || '',
    '{{ET - DLV salla_ph_hash}}':   dl.sallaPh || '',
    '{{ET - DLV salla_fn}}':        dl.sallaFn || '',
    '{{ET - DLV salla_ln}}':        dl.sallaLn || '',
    '{{ET - DLV user_city}}':       dl.ct || '',
    '{{ET - DLV user_state}}':      dl.st || '',
    '{{ET - DLV user_zip}}':        dl.zp || '',
    '{{ET - DLV user_country}}':    dl.country || '',
  };
  let bound = src;
  for (const [ref, val] of Object.entries(bind)) bound = bound.split(ref).join(JSON.stringify(val));
  const remaining = bound.match(/\{\{[^}]+\}\}/g);
  assert.strictEqual(remaining, null, 'unbound GTM reference in pii_hashed: ' + remaining);
  return eval('(' + bound + ')')();
}

// ─────────────────────────────────────────────────────────────────────────────
// The embedded SHA-256 must be a real SHA-256
// ─────────────────────────────────────────────────────────────────────────────

test('embedded browser SHA-256 matches node:crypto, including Arabic and emoji', () => {
  const out = runPiiHashed('zid', { email: 'Test@Example.com' });
  assert.strictEqual(out.em, sha256('test@example.com'));

  for (const name of ['محمد', 'José Peña', '日本語', 'a'.repeat(200)]) {
    const r = runPiiHashed('zid', { fn: name });
    assert.strictEqual(r.fn, sha256(name.toLowerCase().trim()), 'mismatch for ' + name);
  }
});

test('known-answer test — sha256("test@example.com")', () => {
  assert.strictEqual(runPiiHashed('zid', { email: 'test@example.com' }).em,
    '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b');
});

test('embedded SHA-256 matches node:crypto on emoji/surrogate pairs and very long values', () => {
  const cases = [
    '🎁 Gift Box 👍🏽',                    // surrogate pairs + skin-tone modifier
    'محمد بن سلمان آل سعود',                 // Arabic with spaces
    'a'.repeat(1_000_000),                 // 1MB, multi-block, boundary far from any special case
    'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), // block-boundary lengths (SHA-256 block = 64 bytes)
    '', // handled separately below via the empty-input contract, included here for the digest-fn itself
  ].filter(s => s !== '');
  for (const val of cases) {
    const out = runPiiHashed('zid', { fn: val });
    assert.strictEqual(out.fn, sha256(val.toLowerCase().trim()),
      `mismatch for value of length ${val.length}`);
  }
});

test('at least several diverse real-world-shaped PII values match node:crypto exactly', () => {
  const samples = [
    ['ahmed.ali@example.com', 'em'],
    ['SARA.MOHAMMED@SHOP.SA', 'em'],
    ['  spaced.out@mail.com  ', 'em'],
    ['966501234567', 'ph'],
    ['+20 100 123 4567', 'ph'],
    ['عبدالله', 'fn'],
    ["O'Brien-Smith", 'ln'],
    ['Al Riyadh', 'ct'],
  ];
  for (const [raw, field] of samples) {
    const key = { em: 'email', ph: 'phone', fn: 'fn', ln: 'ln', ct: 'ct' }[field];
    const out = runPiiHashed('zid', { [key]: raw });
    let normalised;
    if (field === 'ph') normalised = String(raw).replace(/[^0-9]/g, '');
    else normalised = String(raw).toLowerCase().trim();
    assert.strictEqual(out[field], sha256(normalised), `mismatch for ${field}=${JSON.stringify(raw)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Zid / generic — the reported hole
// ─────────────────────────────────────────────────────────────────────────────

test('Zid: plaintext email and phone become SHA-256', () => {
  const out = runPiiHashed('zid', { email: 'Buyer@Shop.SA', phone: '+966 50 000 0000' });
  assert.match(out.em, HEX64);
  assert.match(out.ph, HEX64);
  assert.strictEqual(out.em, sha256('buyer@shop.sa'));
  assert.strictEqual(out.ph, sha256('966500000000'));
  assert.ok(!out.em.includes('@'), 'email must not survive as plaintext');
});

test('generic (no ecommPlatform): plaintext PII is hashed the same way', () => {
  const out = runPiiHashed('', { email: 'Buyer@Shop.SA', phone: '966-50-000-0000', fn: ' Ali ', ln: 'AL-Saud' });
  assert.strictEqual(out.em, sha256('buyer@shop.sa'));
  assert.strictEqual(out.ph, sha256('966500000000'));
  assert.strictEqual(out.fn, sha256('ali'));
  assert.strictEqual(out.ln, sha256('al-saud'));
});

test('normalisation is canonical before hashing', () => {
  // Case and surrounding whitespace must not change the digest.
  const a = runPiiHashed('zid', { email: '  Buyer@Shop.SA  ' }).em;
  const b = runPiiHashed('zid', { email: 'buyer@shop.sa' }).em;
  assert.strictEqual(a, b);
  // Phone punctuation must not change the digest.
  const p1 = runPiiHashed('zid', { phone: '+966 (50) 000-0000' }).ph;
  const p2 = runPiiHashed('zid', { phone: '966500000000' }).ph;
  assert.strictEqual(p1, p2);
});

// Phone normalization rule, made explicit and DETERMINISTIC:
//   String(value).replace(/[^0-9]/g, '')  — strip every non-digit character.
// This is deliberately dumber than full E.164 canonicalization: it does NOT
// add/strip a country code, and does NOT collapse a local-format number and its
// international-format equivalent to the same digest.
test('DOCUMENTED phone rule: strips all non-digits, deterministically, digit order preserved', () => {
  const cases = [
    ['+966501234567', '966501234567'],
    ['00966501234567', '00966501234567'],   // '00' international prefix is NOT stripped
    ['(050) 123-4567', '0501234567'],
    ['050 123 4567 ext. 12', '050123456712'],
  ];
  for (const [input, expectedDigits] of cases) {
    const out = runPiiHashed('zid', { phone: input });
    assert.strictEqual(out.ph, sha256(expectedDigits), `phone normalisation mismatch for ${JSON.stringify(input)}`);
  }
});

test('DOCUMENTED LIMITATION: Arabic-Indic digits (٠-٩) are not recognised as phone digits', () => {
  // The normaliser is `/[^0-9]/g` — ASCII digits only. A phone number typed
  // entirely in Arabic-Indic numerals normalises to an empty string, which the
  // fail-safe path (see "missing/empty PII yields empty strings, never throws")
  // correctly treats as absent data rather than hashing an accidental empty
  // string. Net effect: such a phone number is silently DROPPED, not
  // corrupted or leaked — a data-quality gap, not a security one. Recorded so
  // it's a known, intentional characteristic rather than a future surprise.
  const out = runPiiHashed('zid', { phone: '٠٥٠١٢٣٤٥٦٧' });
  assert.strictEqual(out.ph, '', 'Arabic-Indic-only phone input should resolve to empty (dropped, not hashed)');
});

test('DOCUMENTED LIMITATION: local-format and international-format phone numbers hash differently', () => {
  // The same physical phone number, written with a Saudi leading-zero local
  // prefix vs. a +966 country code, normalises to two DIFFERENT digit strings
  // and therefore two DIFFERENT SHA-256 digests. This is a data-quality /
  // match-rate concern for the ad platforms (lower advanced-matching rate if a
  // merchant's dataLayer is inconsistent about format) — NOT a security issue,
  // since both forms are still hashed one-way before leaving the browser.
  // Recorded here so the behavior is intentional and visible, not accidental.
  const local = runPiiHashed('zid', { phone: '0501234567' }).ph;
  const intl  = runPiiHashed('zid', { phone: '+966501234567' }).ph;
  assert.notStrictEqual(local, intl,
    'if this ever becomes equal, the normalisation rule changed — update this test intentionally');
  assert.strictEqual(local, sha256('0501234567'));
  assert.strictEqual(intl, sha256('966501234567'));
});

test('city/state/zip/country are hashed too', () => {
  const out = runPiiHashed('zid', { ct: 'Riyadh', st: 'RY', zp: '12345', country: 'SA' });
  assert.strictEqual(out.ct, sha256('riyadh'));
  assert.strictEqual(out.st, sha256('ry'));
  assert.strictEqual(out.zp, sha256('12345'));
  assert.strictEqual(out.country, sha256('sa'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Already-hashed values must pass through untouched
// ─────────────────────────────────────────────────────────────────────────────

test('Salla: pre-hashed dataLayer values pass through, never double-hashed', () => {
  const pre = sha256('customer@salla.sa');
  const out = runPiiHashed('salla', { sallaEm: pre, sallaPh: sha256('966500000000') });
  assert.strictEqual(out.em, pre, 'must not re-hash an existing digest');
  assert.notStrictEqual(out.em, sha256(pre), 'double hashing detected');
});

test('an uppercase hex digest is accepted and lowercased, not re-hashed', () => {
  const pre = sha256('customer@salla.sa').toUpperCase();
  const out = runPiiHashed('salla', { sallaEm: pre });
  assert.strictEqual(out.em, pre.toLowerCase());
});

test('a merchant on Zid who already pre-hashes is also passed through', () => {
  const pre = sha256('already@hashed.sa');
  const out = runPiiHashed('zid', { email: pre });
  assert.strictEqual(out.em, pre);
});

test('Salla falls back to hashing plaintext when the pre-hashed field is absent', () => {
  const out = runPiiHashed('salla', { sallaEm: '', email: 'fallback@salla.sa' });
  assert.strictEqual(out.em, sha256('fallback@salla.sa'));
});

test('a 64-char string that is NOT hex is treated as plaintext and hashed', () => {
  const notHex = 'z'.repeat(64);
  const out = runPiiHashed('zid', { email: notHex });
  assert.strictEqual(out.em, sha256(notHex));
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-safe behaviour
// ─────────────────────────────────────────────────────────────────────────────

test('missing / empty PII yields empty strings, never throws', () => {
  for (const platform of ['salla', 'zid', '']) {
    const out = runPiiHashed(platform, {});
    for (const k of ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country']) {
      assert.strictEqual(out[k], '', `${platform}.${k} should be empty`);
    }
  }
});

test('malformed PII fails safe without breaking the event', () => {
  // A phone with no digits at all normalises to '' — hash nothing rather than
  // hashing punctuation.
  assert.strictEqual(runPiiHashed('zid', { phone: '---' }).ph, '');
  assert.strictEqual(runPiiHashed('zid', { email: '   ' }).em, '');
});

test('every hashed output is either empty or a 64-char lowercase hex digest', () => {
  const out = runPiiHashed('zid', {
    email: 'a@b.sa', phone: '966500000000', fn: 'Ali', ln: 'Saud',
    ct: 'Riyadh', st: 'RY', zp: '12345', country: 'SA' });
  for (const [k, v] of Object.entries(out)) {
    assert.ok(v === '' || HEX64.test(v), `${k} = ${v} is neither empty nor a hex digest`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// No plaintext PII may reach any tag, on any platform
// ─────────────────────────────────────────────────────────────────────────────

test('no CAPI body references a raw PII dataLayer variable', () => {
  const srv = buildServerConfig({
    ga4MeasurementId: 'G-QATEST0001', sgtmUrl: 'https://qa-sgtm.example.invalid',
    platforms: ['meta', 'tiktok', 'snap'], events: ['purchase', 'add_to_cart'],
    pixelIds: { meta: '1', tiktok: '2', snap: '3' },
    capiTokens: { meta: 't', tiktok: 't', snap: 't' },
  });
  const RAW_PII = ['ET - DLV user_email', 'ET - DLV user_phone', 'ET - DLV user_first_name',
                   'ET - DLV user_last_name', 'ET - DLV user_city', 'ET - DLV user_state',
                   'ET - DLV user_zip', 'ET - DLV user_country',
                   'ET - JS email_normalised', 'ET - JS phone_normalised',
                   'ET - JS fn_normalised', 'ET - JS ln_normalised'];
  for (const t of srv.containerVersion.tag) {
    const blob = JSON.stringify(t.parameter || []);
    for (const raw of RAW_PII) {
      assert.ok(!blob.includes('{{' + raw + '}}'),
        `${t.name} references the plaintext PII variable ${raw}`);
    }
  }
});

test('CAPI bodies read PII only from up.* slots fed by hashed variables', () => {
  const srv = buildServerConfig({
    ga4MeasurementId: 'G-X', sgtmUrl: 'https://s.invalid',
    platforms: ['meta', 'tiktok', 'snap'], events: ['purchase'],
    pixelIds: { meta: '1', tiktok: '2', snap: '3' },
    capiTokens: { meta: 't', tiktok: 't', snap: 't' },
  });
  const capi = srv.containerVersion.tag.filter(t => t.type === 'http' && /CAPI|Events API/.test(t.name));
  assert.ok(capi.length > 0);
  for (const t of capi) {
    const body = t.parameter.find(p => p.key === 'requestBody').value;
    for (const field of ['em', 'ph']) {
      if (!body.includes('"' + field + '"') && !body.includes('"email"')) continue;
    }
    // Whatever PII the body carries must come from the up.* slots only.
    assert.ok(!/\{\{ET - (DLV|JS) (user_|email_|phone_|fn_|ln_)/.test(body),
      t.name + ' pulls PII from a web-side plaintext variable');
  }

  // ...and the web container must populate those up.* slots from hashed vars.
  const web = webCfg('zid');
  const ga4Tags = web.containerVersion.tag.filter(t => JSON.stringify(t).includes('userProperties'));
  assert.ok(ga4Tags.length > 0, 'expected GA4 tags relaying user properties');
  for (const t of ga4Tags) {
    const blob = JSON.stringify(t);
    for (const plaintext of ['ET - JS email_normalised', 'ET - JS phone_normalised',
                             'ET - DLV user_email', 'ET - DLV user_phone',
                             'ET - DLV user_city', 'ET - DLV user_zip']) {
      assert.ok(!blob.includes('{{' + plaintext + '}}'),
        `${t.name} relays plaintext ${plaintext} to sGTM`);
    }
    assert.ok(blob.includes('{{ET - JS resolved_em}}'), 'em must come from the hashed resolver');
  }
});

test('rendered CAPI payloads contain no plaintext email or phone', () => {
  const srv = buildServerConfig({
    ga4MeasurementId: 'G-X', sgtmUrl: 'https://s.invalid',
    platforms: ['meta', 'tiktok', 'snap'], events: ['purchase'],
    pixelIds: { meta: '1', tiktok: '2', snap: '3' },
    capiTokens: { meta: 't', tiktok: 't', snap: 't' },
  });
  const hashes = runPiiHashed('zid', { email: 'buyer@shop.sa', phone: '+966500000000' });
  const vars = {
    'ET - up em': hashes.em, 'ET - up ph': hashes.ph,
    'ET - up fn': '', 'ET - up ln': '', 'ET - up external_id': 'c1',
    'ET - up fbp': '', 'ET - up fbc': '', 'ET - up scid': '',
    'ET - client_ip_safe': '203.0.113.1', 'ET - ep user_agent': 'Mozilla/5.0',
    'ET - ep page_url': 'https://shop.example.invalid/', 'ET - ep page_referrer': '',
    'ET - ep event_time': '1754000000', 'ET - epn value': '10', 'ET - ep num_items': '1',
    'ET - ep items_json': '[]', 'ET - ep event_id': 'e1', 'ET - ep currency': 'SAR',
    'ET - ep transaction_id': 'T1', 'ET - ep content_name': 'X', 'ET - ep content_type': 'product',
    'ET - ep ttclid': '', 'ET - ep ScCid': '', 'ET - TikTok Pixel ID': '2',
  };
  const render = (tpl) => tpl.replace(/\{\{([^}]+)\}\}/g, (m, n) =>
    Object.prototype.hasOwnProperty.call(vars, n.trim()) ? String(vars[n.trim()]) : '');

  for (const t of srv.containerVersion.tag.filter(x => x.type === 'http' && /CAPI|Events API/.test(x.name))) {
    const out = render(t.parameter.find(p => p.key === 'requestBody').value);
    assert.doesNotThrow(() => JSON.parse(out), t.name);
    assert.ok(!out.includes('buyer@shop.sa'), t.name + ' leaked the plaintext email');
    assert.ok(!out.includes('+966500000000'), t.name + ' leaked the plaintext phone');
    assert.ok(!out.includes('966500000000'), t.name + ' leaked the normalised phone');
    assert.ok(out.includes(hashes.em), t.name + ' should carry the hashed email');
  }
});

test('browser pixel snippets receive hashed PII in hashed-specific fields', () => {
  const web = webCfg('zid');
  const html = t => (t.parameter.find(p => p.key === 'html') || {}).value || '';
  const snap = web.containerVersion.tag.find(t => /Snapchat Pixel - Base/.test(t.name) || /snaptr\('init'/.test(html(t)));
  if (snap) {
    const h = html(snap);
    assert.ok(h.includes('user_hashed_email'), 'Snapchat must use user_hashed_email for a digest');
    assert.ok(!/'user_email'\s*:/.test(h), 'Snapchat must not put a digest in the plaintext user_email field');
  }
  // No pixel snippet may embed a raw plaintext PII variable.
  for (const t of web.containerVersion.tag) {
    const h = html(t);
    if (!h) continue;
    for (const raw of ['ET - JS email_normalised', 'ET - JS phone_normalised',
                       'ET - DLV user_email', 'ET - DLV user_phone']) {
      assert.ok(!h.includes('{{' + raw + '}}'), `${t.name} embeds plaintext ${raw}`);
    }
  }
});

test('attribution and non-PII fields are NOT hashed', () => {
  const web = webCfg('zid');
  const blob = JSON.stringify(web.containerVersion);
  // Click IDs, UTMs and cookies must still be readable, not digests.
  for (const notHashed of ['ET - URL utm_source', 'ET - URL gclid', 'ET - URL fbclid',
                           'ET - Cookie _ga', 'ET - Cookie _gid']) {
    assert.ok(blob.includes(notHashed), notHashed + ' should still exist unhashed');
  }
  // pii_hashed must read exactly the PII sources and nothing else — asserted on
  // the GTM references it consumes, not on incidental substrings.
  const refs = (jsOf(web, 'ET - JS pii_hashed').match(/\{\{[^}]+\}\}/g) || [])
    .map(r => r.slice(2, -2).trim()).sort();
  assert.deepStrictEqual(refs, [
    'ET - DLV user_city', 'ET - DLV user_country', 'ET - DLV user_state', 'ET - DLV user_zip',
    'ET - JS email_normalised', 'ET - JS fn_normalised', 'ET - JS ln_normalised', 'ET - JS phone_normalised',
  ], 'pii_hashed must consume only PII sources');

  // Attribution values must reach tags unhashed.
  const tagBlob = JSON.stringify(web.containerVersion.tag);
  for (const attribution of ['utm_source', 'gclid', 'fbclid', 'ttclid', 'ScCid']) {
    assert.ok(tagBlob.includes(attribution), attribution + ' must still be forwarded');
  }
});

test('external_id is escaped but deliberately not hashed', () => {
  const web = webCfg('zid');
  const blob = JSON.stringify(web.containerVersion.tag);
  assert.ok(blob.includes('{{ET - JS esc external_id}}'), 'external_id must be escaped');
  const piiHashedJs = jsOf(web, 'ET - JS pii_hashed');
  assert.ok(!piiHashedJs.includes('external_id'), 'external_id is an opaque merchant ref, not hashed PII');
});

test('the normalisation variables stay plaintext but reach no tag', () => {
  // They are inputs to pii_hashed only — proving the hashing cannot be bypassed.
  const web = webCfg('zid');
  const tagBlob = JSON.stringify(web.containerVersion.tag);
  for (const v of ['ET - JS email_normalised', 'ET - JS phone_normalised',
                   'ET - JS fn_normalised', 'ET - JS ln_normalised']) {
    assert.ok(!tagBlob.includes('{{' + v + '}}'), v + ' must not be referenced by any tag');
  }
});
