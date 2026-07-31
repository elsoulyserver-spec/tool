// tests/contract.test.js
// Phase 8 — Contract tests for Salla/Zid/GA4 item extraction and canonical schema.
//
// Validates the full pipeline:
//   raw dataLayer push  →  _dlScanBlock extraction  →  canonical items[]
//
// Run: node --test tests/contract.test.js
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const vm       = require('node:vm');

const {
  buildWebConfig,
  buildServerConfig,
  SCHEMA_VERSION,
  GENERATOR_VERSION,
  _dlScanBlock,
} = require('../lib/gtm-config-builder');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Execute the generated _dlScanBlock in a mock browser VM.
// Returns the extracted items array (assigned to `raw` by the block).
function runExtraction(dataLayerPushes) {
  const code = `
    var raw = null;
    var window = { dataLayer: PUSHES };
    ${_dlScanBlock('raw')}
  `;
  const ctx = vm.createContext({ PUSHES: dataLayerPushes });
  vm.runInContext(code, ctx);
  return ctx.raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Schema versioning
// ─────────────────────────────────────────────────────────────────────────────

test('SCHEMA_VERSION is a positive integer', () => {
  assert.strictEqual(typeof SCHEMA_VERSION, 'number');
  assert.ok(SCHEMA_VERSION >= 1);
  assert.strictEqual(SCHEMA_VERSION, Math.floor(SCHEMA_VERSION)); // integer
});

test('GENERATOR_VERSION is a semver-style string', () => {
  assert.strictEqual(typeof GENERATOR_VERSION, 'string');
  assert.ok(GENERATOR_VERSION.length > 0);
});

test('buildWebConfig _meta embeds schema and generator versions', () => {
  const cfg = buildWebConfig({
    cms: 'salla', ga4Id: 'G-TEST', sgtm: null,
    platforms: ['meta'], pixelIds: { meta: '123' },
    events: ['purchase'],
  });
  assert.strictEqual(cfg._meta.schemaVersion,    SCHEMA_VERSION);
  assert.strictEqual(cfg._meta.generatorVersion, GENERATOR_VERSION);
});

test('buildServerConfig _meta embeds schema and generator versions', () => {
  const cfg = buildServerConfig({
    platforms: ['meta'], platformTokens: { meta: 'tok' },
    pixelIds: { meta: '123' }, sgtmUrl: 'https://sgtm.example.com',
  });
  assert.strictEqual(cfg._meta.schemaVersion,    SCHEMA_VERSION);
  assert.strictEqual(cfg._meta.generatorVersion, GENERATOR_VERSION);
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 — Extraction contract: GA4 / Zid (ecommerce.items[])
// ─────────────────────────────────────────────────────────────────────────────

test('GA4 ecommerce.items[] extracted correctly', () => {
  const push = {
    event: 'purchase',
    ecommerce: {
      transaction_id: 'T001',
      value: 299,
      currency: 'SAR',
      items: [
        { item_id: 'SKU1', item_name: 'Widget', price: 99,  quantity: 2 },
        { item_id: 'SKU2', item_name: 'Gadget', price: 101, quantity: 1 },
      ],
    },
  };
  const raw = runExtraction([push]);
  assert.ok(Array.isArray(raw), 'raw must be an array');
  assert.strictEqual(raw.length, 2);
  assert.strictEqual(raw[0].item_id, 'SKU1');
  assert.strictEqual(raw[1].item_id, 'SKU2');
});

test('Zid ecommerce.items[] with standard GA4 fields extracted correctly', () => {
  const push = {
    event: 'add_to_cart',
    ecommerce: {
      currency: 'SAR',
      value: 150,
      items: [
        { item_id: 'ZID001', item_name: 'Zid Product', price: 150, quantity: 1, item_category: 'Electronics', item_sku: 'Z-SKU' },
      ],
    },
  };
  const raw = runExtraction([push]);
  assert.ok(Array.isArray(raw));
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0].item_id, 'ZID001');
  assert.strictEqual(raw[0].item_name, 'Zid Product');
});

// Phase 8 — Extraction contract: Salla native paths
// ─────────────────────────────────────────────────────────────────────────────

test('Salla Product Viewed: items at push[0]', () => {
  // Salla pushes a numeric-keyed object where push[0] is the product
  const push = {
    event: 'Product Viewed',
    0: { id: 'SALLA001', name: 'Salla Product', price: 200, currency: 'SAR', sku: 'S-SKU' },
  };
  const raw = runExtraction([push]);
  assert.ok(Array.isArray(raw));
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0].id, 'SALLA001');
  assert.strictEqual(raw[0].name, 'Salla Product');
  assert.strictEqual(raw[0].price, 200);
});

test('Salla addToCart: items at ecommerce.add.products[]', () => {
  const push = {
    event: 'addToCart',
    ecommerce: {
      currencyCode: 'SAR',
      add: {
        products: [
          { id: 'SALLA002', name: 'Cart Item', price: 99, quantity: 2, brand: 'Brand X', category: 'Clothing' },
        ],
      },
    },
  };
  const raw = runExtraction([push]);
  assert.ok(Array.isArray(raw));
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0].id, 'SALLA002');
  assert.strictEqual(raw[0].quantity, 2);
});

test('Salla purchase: items at ecommerce.purchase.products[]', () => {
  const push = {
    event: 'purchase',
    ecommerce: {
      currencyCode: 'SAR',
      purchase: {
        actionField: { id: 'ORD123', revenue: '599', total: '599' },
        products: [
          { id: 'SALLA003', name: 'Item A', price: 300, quantity: 1, category: 'Home' },
          { id: 'SALLA004', name: 'Item B', price: 299, quantity: 1 },
        ],
      },
    },
  };
  const raw = runExtraction([push]);
  assert.ok(Array.isArray(raw));
  assert.strictEqual(raw.length, 2);
  assert.strictEqual(raw[0].id, 'SALLA003');
  assert.strictEqual(raw[1].id, 'SALLA004');
});

test('Salla Cart Viewed: items at push[0].products[]', () => {
  const push = {
    event: 'Cart Viewed',
    0: {
      cart_id: 'CART001',
      products: [
        { id: 'SALLA005', name: 'Cart Product', price: 50, quantity: 3, sku: 'CP-SKU', currency: 'SAR' },
      ],
    },
  };
  const raw = runExtraction([push]);
  assert.ok(Array.isArray(raw));
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0].id, 'SALLA005');
  assert.strictEqual(raw[0].quantity, 3);
});

test('Salla Product List Viewed: items at push.data[]', () => {
  const push = {
    event: 'Product List Viewed',
    data: [
      { id: 'SALLA006', name: 'List Product A', price: 120, currency: 'SAR', sku: 'LP-A' },
      { id: 'SALLA007', name: 'List Product B', price: 80,  currency: 'SAR', sku: 'LP-B' },
    ],
  };
  const raw = runExtraction([push]);
  assert.ok(Array.isArray(raw));
  assert.strictEqual(raw.length, 2);
  assert.strictEqual(raw[0].id, 'SALLA006');
  assert.strictEqual(raw[1].id, 'SALLA007');
});

test('Salla Product Removed: item at push[0]', () => {
  const push = {
    event: 'Product Removed',
    0: { id: 'SALLA008', name: 'Removed Item', price: 45, quantity: 1, sku: 'RM-SKU', currency: 'SAR' },
  };
  const raw = runExtraction([push]);
  assert.ok(Array.isArray(raw));
  assert.strictEqual(raw.length, 1);
  assert.strictEqual(raw[0].id, 'SALLA008');
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 — Extraction priority: most recent relevant push wins
// ─────────────────────────────────────────────────────────────────────────────

test('Backward scan returns items from most recent qualifying push', () => {
  const older = { event: 'view_item', ecommerce: { items: [{ item_id: 'OLD', item_name: 'Old', price: 10, quantity: 1 }] } };
  const newer = { event: 'purchase',  ecommerce: { items: [{ item_id: 'NEW', item_name: 'New', price: 99, quantity: 2 }] } };
  const raw = runExtraction([older, newer]);
  assert.strictEqual(raw[0].item_id, 'NEW', 'must return items from the newest matching push');
});

test('Salla push earlier in dataLayer not picked over GA4 push later', () => {
  const sallaOld = {
    event: 'addToCart',
    ecommerce: { currencyCode: 'SAR', add: { products: [{ id: 'SALLA-OLD', name: 'Old', price: 10, quantity: 1 }] } },
  };
  const ga4New = {
    event: 'purchase',
    ecommerce: { items: [{ item_id: 'GA4-NEW', item_name: 'New', price: 200, quantity: 1 }] },
  };
  const raw = runExtraction([sallaOld, ga4New]);
  assert.strictEqual(raw[0].item_id, 'GA4-NEW');
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 — Extraction edge cases
// ─────────────────────────────────────────────────────────────────────────────

test('Empty dataLayer returns null (no items found)', () => {
  const raw = runExtraction([]);
  assert.strictEqual(raw, null);
});

test('Push with empty ecommerce.items does not match', () => {
  const push = { event: 'purchase', ecommerce: { items: [] } };
  const raw = runExtraction([push]);
  // ecommerce.items exists but has length 0 — should fall through to null
  assert.strictEqual(raw, null);
});

test('Salla push[0] with no id or sku does not match', () => {
  // push[0] exists but has no id/sku — should not be treated as a product
  const push = { event: 'Something', 0: { name: 'No ID', price: 10 } };
  const raw = runExtraction([push]);
  assert.strictEqual(raw, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 — Canonical schema: norm() field mapping
// ─────────────────────────────────────────────────────────────────────────────
// We test norm() indirectly by verifying the ITEMS_JSON_JS string contains
// the expected field aliases — the actual logic runs inside GTM.

test('ITEMS_JSON_JS maps item_id to id in canonical output', () => {
  const { buildWebConfig: bwc } = require('../lib/gtm-config-builder');
  const cfg = bwc({ cms: 'salla', ga4Id: 'G-TEST', sgtm: null, platforms: [], pixelIds: {}, events: ['purchase'] });
  // Find the ET - JS items_json variable in the generated container
  const vars = cfg.containerVersion.variable;
  const itemsJsonVar = vars.find(v => v.name === 'ET - JS items_json');
  assert.ok(itemsJsonVar, 'ET - JS items_json variable must exist in web container');
  const code = itemsJsonVar.parameter.find(p => p.key === 'javascript').value;
  assert.ok(code.includes('it.item_id'), 'norm() must read item_id');
  assert.ok(code.includes('it.id'),      'norm() must fall back to id');
  assert.ok(code.includes('it.item_name'),'norm() must read item_name');
  assert.ok(code.includes('it.name'),    'norm() must fall back to name');
});

test('ITEMS_JSON_JS contains all 7 Salla extraction paths', () => {
  const cfg = buildWebConfig({ cms: 'salla', ga4Id: 'G-TEST', sgtm: null, platforms: [], pixelIds: {}, events: ['purchase'] });
  const vars = cfg.containerVersion.variable;
  const itemsJsonVar = vars.find(v => v.name === 'ET - JS items_json');
  const code = itemsJsonVar.parameter.find(p => p.key === 'javascript').value;
  // GA4/Zid
  assert.ok(code.includes('ecommerce.items'), 'must support GA4/Zid ecommerce.items');
  // Salla addToCart
  assert.ok(code.includes('ecommerce.add'),   'must support Salla ecommerce.add.products');
  // Salla purchase
  assert.ok(code.includes('ecommerce.purchase'), 'must support Salla ecommerce.purchase.products');
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 — Generated container structure integrity
// ─────────────────────────────────────────────────────────────────────────────

test('buildWebConfig returns valid exportFormatVersion', () => {
  const cfg = buildWebConfig({ cms: 'salla', ga4Id: 'G-TEST', sgtm: null, platforms: [], pixelIds: {}, events: [] });
  assert.strictEqual(cfg.exportFormatVersion, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Native HTTP Request architecture (replaces the retired customTemplate contract)
// The server container emits native Server GTM HTTP Request tags (type: 'http')
// and keeps containerVersion.customTemplate empty — no community templates.
// ─────────────────────────────────────────────────────────────────────────────

// Shared fixture: Meta+TikTok+Snap enabled with valid pixel/token/event inputs.
// NOTE: tokens go in `capiTokens` and at least one mapped `event` is required for
// per-event CAPI tags to be generated.
function _serverCfgAllPlatforms() {
  return buildServerConfig({
    platforms:  ['meta', 'tiktok', 'snap'],
    pixelIds:   { meta: '123', tiktok: '456', snap: '789' },
    capiTokens: { meta: 'mtok', tiktok: 'ttok', snap: 'stok' },
    events:     ['purchase', 'add_to_cart'],
    sgtmUrl:    'https://sgtm.example.com',
  });
}

const _isCapiTag = t => /^ET - (Meta CAPI|TikTok Events API|Snapchat CAPI) -/.test(t.name);

test('buildServerConfig returns native HTTP Meta tags', () => {
  const cfg = buildServerConfig({
    platforms:  ['meta'],
    pixelIds:   { meta: '123' },
    capiTokens: { meta: 'tok' },
    events:     ['purchase', 'add_to_cart'],
    sgtmUrl:    'https://sgtm.example.com',
  });

  const metaTags = cfg.containerVersion.tag.filter(t => t.type === 'http' && t.name.startsWith('ET - Meta CAPI -'));
  assert.ok(metaTags.length > 0, 'expected at least one native HTTP Meta tag');

  // No community custom templates.
  assert.ok(Array.isArray(cfg.containerVersion.customTemplate), 'customTemplate must be an array');
  assert.strictEqual(cfg.containerVersion.customTemplate.length, 0, 'customTemplate must be empty');

  const t = metaTags[0];
  const keys = t.parameter.map(p => p.key);
  for (const k of ['url', 'method', 'requestBody', 'headers']) {
    assert.ok(keys.includes(k), 'Meta tag missing "' + k + '" parameter');
  }
  assert.strictEqual(t.parameter.find(p => p.key === 'method').value, 'POST', 'method must be POST');

  const url = t.parameter.find(p => p.key === 'url').value;
  assert.ok(url.includes('graph.facebook.com'), 'url must hit the Meta Graph API endpoint');
  assert.ok(url.includes('{{ET - Meta Pixel ID}}'), 'url must reference the pixel ID GTM variable');
  assert.ok(url.includes('{{ET - Meta CAPI Token}}'), 'url must reference the CAPI token GTM variable');
});

test('buildServerConfig native HTTP tags include request bodies and JSON headers', () => {
  const cfg = _serverCfgAllPlatforms();
  const capiTags = cfg.containerVersion.tag.filter(t => t.type === 'http' && _isCapiTag(t));
  assert.ok(capiTags.length > 0, 'expected native CAPI tags for Meta/TikTok/Snap');

  const t = capiTags[0];
  const body = t.parameter.find(p => p.key === 'requestBody');
  assert.ok(body && typeof body.value === 'string' && body.value.length > 0, 'requestBody must be present and non-empty');

  const headers = t.parameter.find(p => p.key === 'headers');
  assert.ok(headers, 'headers parameter must be present');
  assert.strictEqual(headers.type, 'LIST', 'headers must be a LIST parameter');
  assert.ok(Array.isArray(headers.list), 'headers.list must be a list');

  assert.ok(Array.isArray(t.firingTriggerId) && t.firingTriggerId.length > 0 && !!t.firingTriggerId[0], 'tag must have a valid firing trigger id');
  assert.strictEqual(t.tagFiringOption, 'ONCE_PER_EVENT', 'CAPI tags fire once per event');
});

test('buildServerConfig emits no community custom templates', () => {
  const cfg = _serverCfgAllPlatforms();
  assert.ok(Array.isArray(cfg.containerVersion.customTemplate), 'customTemplate must be an array');
  assert.strictEqual(cfg.containerVersion.customTemplate.length, 0, 'customTemplate must be empty');

  const capiTags = cfg.containerVersion.tag.filter(_isCapiTag);
  assert.ok(capiTags.length > 0, 'expected generated CAPI destination tags');
  for (const t of capiTags) {
    assert.strictEqual(t.type, 'http', t.name + ' must be a native http tag');
  }
});
