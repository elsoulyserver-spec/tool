// tests/capi-json-safety.test.js
//
// P1-1 regression suite — JSON injection in native HTTP Request CAPI bodies.
//
// The server container's HTTP Request tags substitute {{Variable}} into the
// request body verbatim: no JSON escaping, and sGTM has no Custom JavaScript
// variable type in which to add any. Before the fix, a product name containing
// a straight quote broke every Meta/TikTok/Snapchat request, and a crafted value
// could inject sibling JSON keys.
//
// These tests prove the fix end to end: they take the ACTUAL escaping JavaScript
// the web container ships, run it over hostile inputs, feed the result through
// the ACTUAL server-container body templates, and assert the result parses and
// carries no injected keys. A static contract test additionally rejects any new
// body field that interpolates a raw, unescaped source.
//
// Run: node --test tests/capi-json-safety.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildWebConfig, buildServerConfig } = require('../lib/gtm-config-builder');

const PIXELS = { meta: '000000000000001', tiktok: 'QATESTTIKTOK001', snap: '00000000-0000-4000-8000-000000000001' };
const TOKENS = { meta: 'QA_FAKE_META', tiktok: 'QA_FAKE_TT', snap: 'QA_FAKE_SNAP' };
const EVENTS = ['page_view', 'view_content', 'add_to_cart', 'initiate_checkout', 'purchase'];

function serverCfg() {
  return buildServerConfig({
    ga4MeasurementId: 'G-QATEST0001', sgtmUrl: 'https://qa-sgtm.example.invalid',
    platforms: ['meta', 'tiktok', 'snap'], events: EVENTS,
    pixelIds: PIXELS, capiTokens: TOKENS,
  });
}
function webCfg(ecommPlatform = 'zid') {
  return buildWebConfig({
    ga4MeasurementId: 'G-QATEST0001', sgtmUrl: 'https://qa-sgtm.example.invalid',
    pixelIds: PIXELS, events: EVENTS, ecommPlatform,
  });
}

const capiTags = cfg => cfg.containerVersion.tag.filter(
  t => t.type === 'http' && /CAPI|Events API/.test(t.name));
const bodyOf = t => t.parameter.find(p => p.key === 'requestBody').value;
const jsOf = (cfg, name) => cfg.containerVersion.variable.find(v => v.name === name)
  .parameter.find(p => p.key === 'javascript').value;

// Run the web container's real escaper over a value. Built once — the whole
// point is that this is the exact function the container ships.
const _escFn = eval('(' + jsOf(webCfg(), 'ET - JS json_escape') + ')');
const webEscape = value => _escFn(value);
const _serverCfg = serverCfg();

// Simulate GTM substitution of a server body.
function render(tpl, vars) {
  return tpl.replace(/\{\{([^}]+)\}\}/g, (m, n) => {
    const k = n.trim();
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : '';
  });
}

// A realistic resolved event, with every string slot passed through the web
// container's escaper exactly as it would be in production.
function eventVars(overrides = {}) {
  const raw = {
    'ET - ep event_id':       'evt-qa-0001',
    'ET - ep transaction_id': 'ORD-QA-9001',
    'ET - ep currency':       'SAR',
    'ET - ep content_name':   'QA Product',
    'ET - ep content_type':   'product',
    'ET - ep page_url':       'https://shop.example.invalid/checkout/thanks',
    'ET - ep page_referrer':  'https://shop.example.invalid/cart',
    'ET - ep user_agent':     'Mozilla/5.0 (QA)',
    'ET - ep ttclid':         'ttclid-qa',
    'ET - ep ScCid':          'sccid-qa',
    'ET - up external_id':    'cust-9001',
    'ET - up fbp':            'fb.1.1754000000.1234567890',
    'ET - up fbc':            'fb.1.1754000000.QAfbclid',
    'ET - up scid':           'sc-qa-1',
    ...overrides,
  };
  const escaped = {};
  for (const [k, v] of Object.entries(raw)) escaped[k] = webEscape(v);
  return {
    ...escaped,
    // hashed PII — always 64-hex, never free text
    'ET - up em': 'a'.repeat(64), 'ET - up ph': 'b'.repeat(64),
    'ET - up fn': 'c'.repeat(64), 'ET - up ln': 'd'.repeat(64),
    // GTM-parsed / numeric / pre-serialized slots
    'ET - client_ip_safe':  '203.0.113.10',
    'ET - ep event_time':   '1754000000',
    'ET - epn value':       '349.5',
    'ET - ep num_items':    '2',
    'ET - ep items_json':   '[{"id":"SKU-1","quantity":1}]',
    'ET - TikTok Pixel ID': PIXELS.tiktok,
    'ET - Meta Pixel ID':   PIXELS.meta,
    'ET - Snapchat Pixel ID': PIXELS.snap,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hostile inputs
// ─────────────────────────────────────────────────────────────────────────────

const HOSTILE_STRINGS = [
  ['straight quote',        'Samsung 55" TV'],
  ['backslash',             'Cable A\\B'],
  ['trailing backslash',    'Model X\\'],
  ['newline',               'line one\nline two'],
  ['carriage return + tab', 'a\r\tb'],
  ['control characters',    'a'+String.fromCharCode(1)+'b'+String.fromCharCode(31)+'c'],
  ['unicode arabic',        'منتج "مميز" بجودة عالية'],
  ['emoji surrogate pair',  'Gift 🎁 Box'],
  ['line/para separators',  'a'+String.fromCharCode(0x2028)+'b'+String.fromCharCode(0x2029)+'c'],
  ['json object literal',   '{"a":1}'],
  ['json array literal',    '[1,2,3]'],
  ['key injection',         'x","injected_field":"OWNED'],
  ['nested key injection',  'x"},"user_data":{"em":["POISONED'],
  ['array break-out',       'x"],"injected":["Y'],
  ['quote storm',           '"""""'],
  ['escaped quote payload', 'a\\",\\"b'],
  ['script close tag',      'Widget</script><script>alert(1)</script>'],
  ['very long string (10k)', 'x'.repeat(10000) + '"injected":"OWNED'],
];

// Every string slot that a merchant, a product feed or a visitor can influence.
const HOSTILE_SLOTS = [
  'ET - ep content_name', 'ET - ep transaction_id', 'ET - ep currency',
  'ET - ep content_type', 'ET - ep page_url', 'ET - ep page_referrer',
  'ET - ep user_agent', 'ET - ep event_id', 'ET - up external_id',
  'ET - ep ttclid', 'ET - ep ScCid', 'ET - up fbc',
];

// ─────────────────────────────────────────────────────────────────────────────

test('every generated CAPI body parses as valid JSON with realistic values', () => {
  const tags = capiTags(_serverCfg);
  assert.ok(tags.length >= 15, 'expected CAPI tags for all three platforms');
  const vars = eventVars();
  for (const t of tags) {
    const out = render(bodyOf(t), vars);
    assert.doesNotThrow(() => JSON.parse(out), t.name + ' produced invalid JSON: ' + out);
  }
});

test('hostile values in any influenced slot never break the JSON', () => {
  const tags = capiTags(_serverCfg);
  for (const slot of HOSTILE_SLOTS) {
    for (const [label, payload] of HOSTILE_STRINGS) {
      const vars = eventVars({ [slot]: payload });
      for (const t of tags) {
        const out = render(bodyOf(t), vars);
        assert.doesNotThrow(
          () => JSON.parse(out),
          `${t.name} broke on ${slot} = ${label} (${JSON.stringify(payload)})\n${out}`);
      }
    }
  }
});

test('hostile values never inject sibling keys', () => {
  const tags = capiTags(_serverCfg);
  const probes = ['injected_field', 'injected', 'POISONED'];
  for (const slot of HOSTILE_SLOTS) {
    for (const [, payload] of HOSTILE_STRINGS) {
      const vars = eventVars({ [slot]: payload });
      for (const t of tags) {
        const parsed = JSON.parse(render(bodyOf(t), vars));
        const flat = JSON.stringify(parsed);
        for (const probe of probes) {
          assert.ok(!flat.includes('"' + probe + '":'),
            `${t.name} leaked injected key "${probe}" via ${slot}`);
        }
        // The Meta user_data object must keep exactly its declared shape.
        if (parsed.data && parsed.data[0] && parsed.data[0].user_data) {
          assert.ok(!Object.prototype.hasOwnProperty.call(parsed.data[0].user_data, 'POISONED'));
        }
      }
    }
  }
});

test('hostile values survive escaping intact (no data corruption)', () => {
  const metaTag = capiTags(_serverCfg).find(t => t.name === 'ET - Meta CAPI - Purchase');
  for (const [label, payload] of HOSTILE_STRINGS) {
    const parsed = JSON.parse(render(bodyOf(metaTag), eventVars({ 'ET - ep content_name': payload })));
    assert.strictEqual(parsed.data[0].custom_data.content_name, payload,
      'content_name was corrupted for: ' + label);
  }
});

test('the exact reported repro — a quote in a product name — now works', () => {
  const metaTag = capiTags(_serverCfg).find(t => t.name === 'ET - Meta CAPI - Purchase');
  const parsed = JSON.parse(render(bodyOf(metaTag), eventVars({ 'ET - ep content_name': 'Samsung 55" TV' })));
  assert.strictEqual(parsed.data[0].custom_data.content_name, 'Samsung 55" TV');
  assert.strictEqual(parsed.data[0].custom_data.order_id, 'ORD-QA-9001');
});

test('the exact reported repro — key injection payload — is neutralised', () => {
  const metaTag = capiTags(_serverCfg).find(t => t.name === 'ET - Meta CAPI - Purchase');
  const parsed = JSON.parse(render(bodyOf(metaTag), eventVars({ 'ET - ep content_name': 'x","injected_field":"OWNED' })));
  const cd = parsed.data[0].custom_data;
  assert.ok(!Object.prototype.hasOwnProperty.call(cd, 'injected_field'), 'injected_field must not exist');
  assert.strictEqual(cd.content_name, 'x","injected_field":"OWNED', 'payload must survive as inert text');
});

test('hostile client_user_agent cannot break or inject', () => {
  const tags = capiTags(_serverCfg);
  const ua = 'Mozilla/5.0","injected_field":"OWNED';
  for (const t of tags) {
    const parsed = JSON.parse(render(bodyOf(t), eventVars({ 'ET - ep user_agent': ua })));
    assert.ok(!JSON.stringify(parsed).includes('"injected_field":'), t.name + ' leaked via user_agent');
  }
});

test('hostile page URL and referrer cannot break or inject', () => {
  const tags = capiTags(_serverCfg);
  const url = 'https://shop.example.invalid/?q="},"injected_field":"OWNED';
  for (const t of tags) {
    const parsed = JSON.parse(render(bodyOf(t), eventVars({
      'ET - ep page_url': url, 'ET - ep page_referrer': url })));
    assert.ok(!JSON.stringify(parsed).includes('"injected_field":'), t.name + ' leaked via page url/referrer');
  }
});

test('unquoted numeric slots stay numeric and valid', () => {
  const metaTag = capiTags(_serverCfg).find(t => t.name === 'ET - Meta CAPI - Purchase');
  const parsed = JSON.parse(render(bodyOf(metaTag), eventVars()));
  assert.strictEqual(typeof parsed.data[0].custom_data.value, 'number');
  assert.strictEqual(typeof parsed.data[0].custom_data.num_items, 'number');
  assert.strictEqual(typeof parsed.data[0].event_time, 'number');
  assert.ok(Array.isArray(parsed.data[0].custom_data.contents));
});

test('web container coerces hostile numeric input to a finite number', () => {
  const cfg = webCfg();
  for (const varName of ['ET - JS num value', 'ET - JS num num_items']) {
    const src = jsOf(cfg, varName);
    const srcRef = src.match(/\{\{[^}]+\}\}/)[0];
    for (const [input, want] of [['349.5', 349.5], ['', 0], ['abc', 0], ['1"x', 1], ['NaN', 0]]) {
      const fn = eval('(' + src.replace(srcRef, JSON.stringify(input)) + ')');
      assert.strictEqual(fn(), want, `${varName}(${JSON.stringify(input)})`);
    }
  }
});

test('items_json is embedded unquoted and stays a JSON array', () => {
  const metaTag = capiTags(_serverCfg).find(t => t.name === 'ET - Meta CAPI - Purchase');
  // A product name with a quote inside the items array — already JSON.stringify'd
  // by the web container, so it must survive verbatim.
  const items = JSON.stringify([{ id: 'SKU-1', name: 'Samsung 55" TV', price: 1, quantity: 1 }]);
  const parsed = JSON.parse(render(bodyOf(metaTag), eventVars({}, {})).replace(
    JSON.stringify([{ id: 'SKU-1', quantity: 1 }]), items));
  assert.ok(Array.isArray(parsed.data[0].custom_data.contents));
});

// ── Static contract: no raw source may reach a quoted JSON slot ───────────────

test('CONTRACT: every quoted body slot reads an escaped, hashed or parsed source', () => {
  // Sources that are safe by construction:
  //  • ET - JS esc * upstream → arrives as an escaped ep.*/up.* value
  //  • hashed PII (always 64-char hex)
  //  • container constants we generate ourselves (pixel IDs, tokens, client id)
  //  • ET - client_ip_safe (GTM-parsed IP, not a raw header)
  const SAFE_QUOTED = new Set([
    'ET - ep event_id', 'ET - ep transaction_id', 'ET - ep currency',
    'ET - ep content_name', 'ET - ep content_type', 'ET - ep page_url',
    'ET - ep page_referrer', 'ET - ep user_agent', 'ET - ep ttclid', 'ET - ep ScCid',
    'ET - up em', 'ET - up ph', 'ET - up fn', 'ET - up ln', 'ET - up external_id',
    'ET - up fbp', 'ET - up fbc', 'ET - up scid',
    'ET - client_ip_safe', 'ET - ep event_time',
    'ET - Meta Pixel ID', 'ET - TikTok Pixel ID', 'ET - Snapchat Pixel ID',
    'ET - Meta CAPI Token', 'ET - TikTok Events Token', 'ET - Snapchat CAPI Token',
    'ET - EasyTrac Client ID', 'ET - Beacon API Key', 'ET - event_name',
  ]);
  // Explicitly banned in any body: raw request headers and raw sGTM page metadata.
  const BANNED = ['ET - Header user_agent', 'ET - Header client_ip', 'ET - Header referer',
                  'ET - Header origin', 'ET - page_location', 'ET - page_referrer',
                  'ET - client_ip_clean'];

  const cfg = _serverCfg;
  const httpTags = cfg.containerVersion.tag.filter(t => t.type === 'http');
  assert.ok(httpTags.length > 0);

  for (const t of httpTags) {
    const body = bodyOf(t);
    for (const banned of BANNED) {
      assert.ok(!body.includes('{{' + banned + '}}'),
        `${t.name} interpolates the raw source ${banned} — see the JSON SAFETY CONTRACT`);
    }
    // Find every reference sitting inside a quoted slot: "key":"{{Var}}"
    const quoted = [...body.matchAll(/"\s*:\s*\[?"\{\{([^}]+)\}\}"/g)].map(m => m[1].trim());
    for (const ref of quoted) {
      assert.ok(SAFE_QUOTED.has(ref),
        `${t.name} places ${ref} inside a JSON string literal, but it is not a known-safe source. ` +
        'Route it through an ET - JS esc * variable first, or add it to SAFE_QUOTED with a reason.');
    }
  }
});

// ── Additional field coverage requested by security review ────────────────────

test('event_name is a fixed platform-mapped literal, never merchant/attacker text', () => {
  // _metaBody/_tiktokBody/_snapBody take `eventName` as a plain JS string
  // parameter, concatenated directly (not via a GTM {{Variable}}). This is
  // provably safe ONLY because every call site passes a value looked up from
  // our own fixed META_EVENT/TIKTOK_EVENT/SNAP_EVENT maps — never a
  // merchant-supplied custom-event name. Assert that invariant directly against
  // the actual generated tag bodies, so a future edit that starts passing a
  // free-text event name in cannot land silently.
  const KNOWN_META_EVENTS = ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout',
    'Purchase', 'Lead', 'CompleteRegistration', 'Search', 'Contact'];
  const KNOWN_TIKTOK_EVENTS = ['Pageview', 'ViewContent', 'AddToCart', 'InitiateCheckout',
    'PlaceAnOrder', 'SubmitForm', 'CompleteRegistration', 'Search', 'Contact'];
  const KNOWN_SNAP_EVENTS = ['PAGE_VIEW', 'VIEW_CONTENT', 'ADD_CART', 'START_CHECKOUT',
    'PURCHASE', 'SIGN_UP', 'SEARCH'];

  for (const t of _serverCfg.containerVersion.tag.filter(x => x.type === 'http')) {
    const body = bodyOf(t);
    const eventNameMatch = body.match(/"event_name":"([^"]*)"|"event":"([^"]*)"/);
    if (!eventNameMatch) continue;
    const val = eventNameMatch[1] || eventNameMatch[2];
    const allKnown = [...KNOWN_META_EVENTS, ...KNOWN_TIKTOK_EVENTS, ...KNOWN_SNAP_EVENTS];
    assert.ok(allKnown.includes(val),
      `${t.name} has event_name/event = "${val}", not one of the fixed platform enum values — ` +
      'this field must never carry merchant/attacker-controlled text.');
  }
});

test('custom (merchant-supplied) event names never generate a CAPI tag', () => {
  // customEvents are arbitrary GA4 event-name strings a merchant can set. They
  // must only ever produce a plain sGTM trigger — never reach _metaBody /
  // _tiktokBody / _snapBody's eventName parameter, which is string-concatenated
  // with zero escaping (by design — it's meant only for our fixed enum values).
  const HOSTILE_EVENT_NAME = 'evil","injected":"OWNED';
  const cfg = buildServerConfig({
    ga4MeasurementId: 'G-X', sgtmUrl: 'https://s.invalid',
    platforms: ['meta', 'tiktok', 'snap'], events: ['purchase'],
    customEvents: [HOSTILE_EVENT_NAME],
    pixelIds: PIXELS, capiTokens: TOKENS,
  });
  for (const t of cfg.containerVersion.tag.filter(x => x.type === 'http')) {
    const body = bodyOf(t);
    assert.ok(!body.includes(HOSTILE_EVENT_NAME),
      `${t.name} embedded a custom event name directly in its request body`);
  }
  // It DOES still produce a (harmless) sGTM trigger for the custom event.
  const trigNames = cfg.containerVersion.trigger.map(x => x.name);
  assert.ok(trigNames.some(n => n.includes('Custom Event')), 'expected a custom-event trigger to exist');
});

test('product id/name/category/brand/variant: items_json survives hostile values via JSON.stringify', () => {
  // items_json is built browser-side by JSON.stringify (ITEMS_JSON_JS), so its
  // own escaping is Node/browser-native — but this proves the OUTER body still
  // parses correctly once that pre-serialized array is spliced in unquoted, and
  // that nothing inside it can break out into the surrounding CAPI body.
  const hostileItem = {
    id: 'SKU-"1', name: 'Widget</script><script>alert(1)</script>', price: 10, quantity: 1,
    brand: 'Brand\\"Injected', category: 'Cat, "x":"y', variant: 'Größe: 42" — Édition Spéciale™',
  };
  const itemsJson = JSON.stringify([hostileItem]);
  const metaTag = capiTags(_serverCfg).find(t => t.name === 'ET - Meta CAPI - Purchase');
  const out = render(bodyOf(metaTag), { ...eventVars(), 'ET - ep items_json': itemsJson });
  const parsed = JSON.parse(out);
  assert.deepStrictEqual(parsed.data[0].custom_data.contents, [hostileItem],
    'the items array must round-trip through the outer CAPI body unchanged');
});

test('product fields: a very long item name does not corrupt the surrounding body', () => {
  const longItem = { id: 'SKU-1', name: 'x'.repeat(20000), price: 1, quantity: 1 };
  const itemsJson = JSON.stringify([longItem]);
  for (const t of capiTags(_serverCfg)) {
    const out = render(bodyOf(t), { ...eventVars(), 'ET - ep items_json': itemsJson });
    assert.doesNotThrow(() => JSON.parse(out), t.name + ' broke on a 20k-char item name');
  }
});

test('coupon, affiliation, search_string: escaped variables exist but are not yet wired into any CAPI body', () => {
  // These ep.* parameters ARE routed through the escaper (ET - JS esc coupon /
  // affiliation / search_string), matching the JSON SAFETY CONTRACT — but no
  // _metaBody/_tiktokBody/_snapBody currently references them. Documented here
  // so that whoever wires them into a body next is forced to reuse the escaped
  // source (this test will need the new reference added to the CONTRACT test's
  // SAFE_QUOTED set, which will fail loudly if a raw source is used instead).
  const webBlob = JSON.stringify(webCfg().containerVersion.variable);
  for (const name of ['ET - JS esc coupon', 'ET - JS esc affiliation', 'ET - JS esc search_string']) {
    assert.ok(webBlob.includes(name), name + ' should exist as an escaped web-container variable');
  }
  for (const t of capiTags(_serverCfg)) {
    const body = bodyOf(t);
    assert.ok(!/coupon|affiliation|search_string/i.test(body),
      t.name + ' unexpectedly references coupon/affiliation/search_string — ' +
      'if this is intentional, add tests proving the escaped source is used, not a raw one');
  }
});

test('currency field rejects hostile input safely (already covered by HOSTILE_SLOTS, isolated here for clarity)', () => {
  const metaTag = capiTags(_serverCfg).find(t => t.name === 'ET - Meta CAPI - Purchase');
  for (const payload of ['SAR","injected":"OWNED', 'USD\\', '"""', 'ر.س']) {
    // eventVars() escapes every override for us — pass the RAW hostile value.
    const out = render(bodyOf(metaTag), eventVars({ 'ET - ep currency': payload }));
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.data[0].custom_data.currency, payload);
  }
});

test('CONTRACT: architecture invariants still hold after the fix', () => {
  const cfg = _serverCfg;
  assert.strictEqual(cfg.containerVersion.customTemplate.length, 0, 'customTemplate must stay empty');
  for (const t of capiTags(cfg)) {
    assert.strictEqual(t.type, 'http', t.name + ' must remain a native http tag');
    assert.ok(!/^cvt_/.test(String(t.type)), 'no community template types');
  }
  // GTM variable substitution must still be in use — not baked-in literals.
  const metaTag = capiTags(cfg).find(t => t.name === 'ET - Meta CAPI - Purchase');
  assert.match(bodyOf(metaTag), /\{\{ET - /, 'body must still use GTM variable substitution');
});
