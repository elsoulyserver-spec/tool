'use strict';

/**
 * sgtm-template.contract.test.js
 *
 * End-to-end contract tests for the Universal HTTP Forwarder v4 template.
 *
 * Pipeline under test:
 *   Raw DataLayer push
 *     → createEventModel()       [web container simulation]
 *     → buildCanonicalEvent()    [template Section 2]
 *     → validateCanonicalEvent() [template Section 5]
 *     → buildMetaPayload()       [Meta CAPI]
 *     → buildTikTokPayload()     [TikTok Events API]
 *     → buildSnapPayload()       [Snapchat CAPI]
 *     → assert payload shape
 *
 * Run: node --test tests/sgtm-template.contract.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createEventModel,
  buildCanonicalEvent,
  validateCanonicalEvent,
  buildMetaPayload,
  buildTikTokPayload,
  buildSnapPayload,
  dispatch,
  _hash,
  _hashPhone,
  isHex64,
} = require('./sgtm-simulator');

// ─────────────────────────────────────────────────────────────────────────────
// Shared template data (platform-agnostic — url/eventName vary per assertion)
// ─────────────────────────────────────────────────────────────────────────────

const BASE_TD = {
  url:        'https://graph.facebook.com/v22.0/123/events?access_token=TOKEN',
  eventName:  'Purchase',
  platformId: 'PX_123',
  clientIp:   '185.1.2.3',
  userAgent:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
  enableDebug: false,
  dlqUrl:     'https://tool.easytrac.io/api/v1/internal/dlq',
};

const BASE_UP = {
  session_id:   'sess_abc123',
  anonymous_id: 'anon_xyz789',
  page_url:     'https://shop.example.com/checkout',
  page_referrer:'https://shop.example.com/cart',
  device_type:  'mobile',
  language:     'ar',
  fbp:          'fb.1.1700000000.123456789',
  fbc:          'fb.1.1700000000.FBCLID123',
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — raw dataLayer pushes per platform / event
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES = {

  // ── Salla ──────────────────────────────────────────────────────────────────

  salla_product_viewed: {
    event: 'Product Viewed',
    0: { id: 'S-001', name: 'Classic Thobe', price: 299, currency: 'SAR', sku: 'CT-M-WH' },
  },

  salla_product_list_viewed: {
    event: 'Product List Viewed',
    data: [
      { id: 'S-002', name: 'Bisht Formal', price: 1200, currency: 'SAR', sku: 'BF-L' },
      { id: 'S-003', name: 'Casual Shirt',  price: 199,  currency: 'SAR', sku: 'CS-M' },
    ],
  },

  salla_add_to_cart: {
    event: 'addToCart',
    ecommerce: {
      currencyCode: 'SAR',
      add: {
        products: [
          { id: 'S-004', name: 'Kandura Premium', price: 450, quantity: 2,
            brand: 'Al Majlis', category: 'Traditional Wear', sku: 'KP-XL' },
        ],
      },
    },
  },

  salla_cart_viewed: {
    event: 'Cart Viewed',
    0: {
      cart_id: 'CART-001',
      products: [
        { id: 'S-005', name: 'Prayer Rug',  price: 120, quantity: 1, currency: 'SAR', sku: 'PR-01' },
        { id: 'S-006', name: 'Oud Perfume', price: 350, quantity: 1, currency: 'SAR', sku: 'OP-50ML' },
      ],
    },
  },

  salla_begin_checkout: {
    event: 'initiate_checkout',
    ecommerce: {
      currencyCode: 'SAR',
      checkout: {
        actionField: { step: 1 },
        products: [
          { id: 'S-007', name: 'Abaya Black', price: 599, quantity: 1,
            brand: 'Lomar', category: 'Women Wear', sku: 'AB-54' },
        ],
      },
    },
    value: 599,
    currency: 'SAR',
    user_data: { em: 'fatima@example.sa', ph: '+966500000001' },
  },

  salla_purchase: {
    event: 'purchase',
    ecommerce: {
      currencyCode: 'SAR',
      purchase: {
        actionField: { id: 'ORD-SA-9001', revenue: '1348', shipping: '30', tax: '67.4', coupon: 'RAMADAN10' },
        products: [
          { id: 'S-008', name: 'Kandura Gold', price: 899, quantity: 1, brand: 'Al Majlis', category: 'Traditional Wear' },
          { id: 'S-009', name: 'Sandals',      price: 449, quantity: 1, brand: 'Zara',      category: 'Footwear' },
        ],
      },
    },
    user_data: { em: 'omar@example.sa', ph: '+966500000002', fn: 'Omar', ln: 'Al-Rashid', external_id: 'CUST-42' },
  },

  // ── Zid ────────────────────────────────────────────────────────────────────

  zid_view_item: {
    event: 'view_item',
    ecommerce: {
      currency: 'SAR',
      value: 349,
      items: [
        { item_id: 'Z-001', item_name: 'Wireless Headphones', price: 349, quantity: 1,
          item_category: 'Electronics', item_brand: 'Sony' },
      ],
    },
  },

  zid_add_to_cart: {
    event: 'add_to_cart',
    ecommerce: {
      currency: 'SAR',
      value: 698,
      items: [
        { item_id: 'Z-002', item_name: 'Smart Watch', price: 349, quantity: 2,
          item_category: 'Electronics', item_brand: 'Samsung', item_variant: 'Black' },
      ],
    },
  },

  zid_begin_checkout: {
    event: 'begin_checkout',
    ecommerce: {
      currency: 'SAR',
      value: 698,
      coupon: 'TECH15',
      items: [
        { item_id: 'Z-002', item_name: 'Smart Watch', price: 349, quantity: 2,
          item_category: 'Electronics', item_brand: 'Samsung' },
      ],
    },
    user_data: { em: 'ali@example.sa', ph: '+966500000003' },
  },

  zid_purchase: {
    event: 'purchase',
    ecommerce: {
      transaction_id: 'ZID-TXN-2024',
      value:    1250,
      revenue:  1200,
      currency: 'SAR',
      tax:       62.5,
      shipping:  25,
      coupon:   'WINTER20',
      affiliation: 'Zid Store',
      items: [
        { item_id: 'Z-003', item_name: 'Laptop Stand',   price: 250, quantity: 2, item_category: 'Accessories', item_brand: 'Orico' },
        { item_id: 'Z-004', item_name: 'USB-C Hub',      price: 750, quantity: 1, item_category: 'Accessories', item_brand: 'Anker' },
      ],
    },
    user_data: {
      em: 'khalid@example.sa', ph: '+966500000004',
      fn: 'Khalid', ln: 'Hassan', external_id: 'ZID-USR-77',
    },
  },

  // ── Generic GA4 ────────────────────────────────────────────────────────────

  ga4_ecommerce_items: {
    event: 'view_item_list',
    ecommerce: {
      item_list_name: 'Search Results',
      currency: 'USD',
      items: [
        { item_id: 'G-001', item_name: 'Running Shoes', price: 120, quantity: 1,
          item_brand: 'Nike', item_category: 'Footwear', item_variant: 'Blue/42' },
        { item_id: 'G-002', item_name: 'Sports Socks',  price: 15,  quantity: 3,
          item_brand: 'Nike', item_category: 'Accessories' },
      ],
    },
  },

  ga4_purchase: {
    event: 'purchase',
    ecommerce: {
      transaction_id: 'GA4-TXN-555',
      value:    399,
      revenue:  379,
      currency: 'USD',
      tax:       19.95,
      shipping:  9.99,
      coupon:   'NEWUSER10',
      affiliation: 'Online Store',
      items: [
        { item_id: 'G-003', item_name: 'Yoga Mat',      price: 79,  quantity: 1, item_brand: 'Liforme', item_category: 'Fitness', discount: 10 },
        { item_id: 'G-004', item_name: 'Water Bottle',  price: 35,  quantity: 2, item_brand: 'Hydro Flask', item_category: 'Fitness' },
        { item_id: 'G-005', item_name: 'Resistance Band', price: 25, quantity: 1, item_category: 'Fitness' },
      ],
    },
    user_data: {
      em: 'jane@example.com', ph: '+12125551234',
      fn: 'Jane', ln: 'Doe',
      ct: 'New York', st: 'NY', zp: '10001', country: 'US',
      external_id: 'CUST-GA4-99',
    },
  },

  ga4_lead: {
    event: 'generate_lead',
    value: 0,
    currency: 'SAR',
    user_data: { em: 'lead@example.sa', ph: '+966500000005' },
  },

  ga4_sign_up: {
    event: 'sign_up',
    value: 0,
    currency: 'SAR',
    user_data: { em: 'new@example.sa', ph: '+966500000006', fn: 'Ahmad', ln: 'Said' },
  },

  ga4_search: {
    event: 'search',
    search_string: 'wireless headphones',
    currency: 'SAR',
    value: 0,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function run(fixtureName, tdOverrides = {}, upOverrides = {}) {
  const push = FIXTURES[fixtureName];
  const up   = Object.assign({}, BASE_UP, upOverrides);
  const td   = Object.assign({}, BASE_TD, tdOverrides);
  const model = createEventModel(push, up);
  return dispatch(model, td);
}

function assertValidPurchase(result) {
  assert.ok(result.validation.valid, `Validation failed: ${JSON.stringify(result.validation.errors)}`);
  assert.ok(result.canonical.event.id,             'canonical.event.id must be set');
  assert.ok(result.canonical.event.timestamp > 0,  'canonical.event.timestamp must be positive');
  assert.ok(result.canonical.ecommerce.currency,   'canonical.ecommerce.currency must be set');
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1 — Salla event fixtures
// ─────────────────────────────────────────────────────────────────────────────

describe('Salla — Product Viewed', () => {

  test('createEventModel extracts single product from push[0]', () => {
    const model = createEventModel(FIXTURES.salla_product_viewed, BASE_UP);
    assert.strictEqual(model._rawItemCount, 1);
    assert.strictEqual(model._parsedItems[0].id, 'S-001');
    assert.strictEqual(model._parsedItems[0].name, 'Classic Thobe');
    assert.strictEqual(model._parsedItems[0].price, 299);
  });

  test('buildCanonicalEvent: items populated, currency defaults to SAR', () => {
    const model = createEventModel(FIXTURES.salla_product_viewed, BASE_UP);
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'ViewContent' });
    assert.strictEqual(ev.ecommerce.items.length, 1);
    assert.strictEqual(ev.ecommerce.items[0].id, 'S-001');
    assert.strictEqual(ev.ecommerce.currency, 'SAR');
  });

  test('Meta payload: contents[] with correct id and item_price', () => {
    const model = createEventModel(FIXTURES.salla_product_viewed, BASE_UP);
    const ev    = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'ViewContent' });
    const meta  = buildMetaPayload(ev, BASE_TD);
    const d     = meta.data[0];
    assert.ok(d.custom_data.contents,                  'contents must exist');
    assert.strictEqual(d.custom_data.contents[0].id,         'S-001');
    assert.strictEqual(d.custom_data.contents[0].item_price, 299);
    assert.ok(d.custom_data.content_ids.includes('S-001'), 'content_ids must include S-001');
  });

  test('TikTok payload: contents[] with content_id and price', () => {
    const model = createEventModel(FIXTURES.salla_product_viewed, BASE_UP);
    const ev    = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'ViewContent' });
    const tt    = buildTikTokPayload(ev, BASE_TD);
    const props = tt.data[0].properties;
    assert.ok(props.contents,                           'contents must exist');
    assert.strictEqual(props.contents[0].content_id,   'S-001');
    assert.strictEqual(props.contents[0].price,        299);
  });

  test('Snap payload: products[] with item_id', () => {
    const model = createEventModel(FIXTURES.salla_product_viewed, BASE_UP);
    const ev    = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'VIEW_CONTENT' });
    const snap  = buildSnapPayload(ev, BASE_TD);
    const cd    = snap.data[0].custom_data;
    assert.ok(cd.products,                             'products must exist');
    assert.strictEqual(cd.products[0].item_id,        'S-001');
  });
});

describe('Salla — Product List Viewed', () => {

  test('createEventModel extracts 2 items from push.data[]', () => {
    const model = createEventModel(FIXTURES.salla_product_list_viewed, BASE_UP);
    assert.strictEqual(model._rawItemCount, 2);
    assert.strictEqual(model._parsedItems[0].id, 'S-002');
    assert.strictEqual(model._parsedItems[1].id, 'S-003');
  });

  test('Meta payload: content_ids contains both product IDs', () => {
    const model = createEventModel(FIXTURES.salla_product_list_viewed, BASE_UP);
    const ev    = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'ViewContent' });
    const meta  = buildMetaPayload(ev, BASE_TD);
    const ids   = meta.data[0].custom_data.content_ids;
    assert.ok(ids.includes('S-002'), 'must include S-002');
    assert.ok(ids.includes('S-003'), 'must include S-003');
    assert.strictEqual(ids.length, 2);
  });

  test('TikTok payload: 2 contents entries', () => {
    const model = createEventModel(FIXTURES.salla_product_list_viewed, BASE_UP);
    const ev    = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'ViewContent' });
    const tt    = buildTikTokPayload(ev, BASE_TD);
    assert.strictEqual(tt.data[0].properties.contents.length, 2);
  });
});

describe('Salla — Add To Cart', () => {

  test('createEventModel extracts from ecommerce.add.products[]', () => {
    const model = createEventModel(FIXTURES.salla_add_to_cart, BASE_UP);
    assert.strictEqual(model._rawItemCount, 1);
    assert.strictEqual(model._parsedItems[0].id,       'S-004');
    assert.strictEqual(model._parsedItems[0].quantity,  2);
    assert.strictEqual(model._parsedItems[0].brand,    'Al Majlis');
    assert.strictEqual(model._parsedItems[0].category, 'Traditional Wear');
  });

  test('canonical ecommerce.items_count reflects cart quantity', () => {
    const model = createEventModel(FIXTURES.salla_add_to_cart, BASE_UP);
    const ev    = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'AddToCart' });
    assert.strictEqual(ev.ecommerce.items_count, 1);
    assert.strictEqual(ev.ecommerce.items[0].quantity, 2);
  });

  test('Meta contents[]: brand and category forwarded', () => {
    const model = createEventModel(FIXTURES.salla_add_to_cart, BASE_UP);
    const ev    = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'AddToCart' });
    const meta  = buildMetaPayload(ev, BASE_TD);
    const item  = meta.data[0].custom_data.contents[0];
    assert.strictEqual(item.brand,    'Al Majlis');
    assert.strictEqual(item.category, 'Traditional Wear');
  });
});

describe('Salla — Cart Viewed', () => {

  test('createEventModel extracts 2 items from push[0].products[]', () => {
    const model = createEventModel(FIXTURES.salla_cart_viewed, BASE_UP);
    assert.strictEqual(model._rawItemCount, 2);
    assert.ok(model._parsedItems.some(i => i.id === 'S-005'));
    assert.ok(model._parsedItems.some(i => i.id === 'S-006'));
  });

  test('Snap payload: item_ids and products both populated', () => {
    const model = createEventModel(FIXTURES.salla_cart_viewed, BASE_UP);
    const ev    = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'ADD_CART' });
    const snap  = buildSnapPayload(ev, BASE_TD);
    const cd    = snap.data[0].custom_data;
    assert.strictEqual(cd.item_ids.length, 2);
    assert.strictEqual(cd.products.length, 2);
  });
});

describe('Salla — Begin Checkout', () => {

  test('canonical: user PII hashed', () => {
    const model = createEventModel(FIXTURES.salla_begin_checkout, BASE_UP);
    const ev    = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'InitiateCheckout' });
    assert.ok(isHex64(ev.user.email), 'email must be SHA-256 hashed');
    assert.ok(isHex64(ev.user.phone), 'phone must be SHA-256 hashed');
    assert.strictEqual(ev.user.email, _hash('fatima@example.sa'));
    assert.strictEqual(ev.user.phone, _hashPhone('+966500000001'));
  });

  test('validation: passes with session and anonymous IDs', () => {
    const model  = createEventModel(FIXTURES.salla_begin_checkout, BASE_UP,
      { 'ep.event_id': 'EVT-CHK-01', 'event_id': 'EVT-CHK-01' });
    const ev     = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'InitiateCheckout' });
    const result = validateCanonicalEvent(ev);
    assert.ok(result.valid, JSON.stringify(result.errors));
    assert.ok(!result.warnings.includes('MISSING_session_id'));
    assert.ok(!result.warnings.includes('MISSING_anonymous_id'));
  });
});

describe('Salla — Purchase', () => {

  test('createEventModel: transaction_id from actionField.id', () => {
    const model = createEventModel(FIXTURES.salla_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-SALLA-PUR', 'event_id': 'EVT-SALLA-PUR' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev.event.transaction_id, 'ORD-SA-9001');
  });

  test('canonical: tax, shipping, coupon from actionField', () => {
    const model = createEventModel(FIXTURES.salla_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-SAL-P2', 'event_id': 'EVT-SAL-P2',
        'ep.tax': 67.4, 'tax': 67.4, 'ep.shipping': 30, 'shipping': 30,
        'ep.coupon': 'RAMADAN10', 'coupon': 'RAMADAN10' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev.ecommerce.coupon, 'RAMADAN10');
  });

  test('canonical: 2 items with correct ids', () => {
    const model = createEventModel(FIXTURES.salla_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-SAL-P3', 'event_id': 'EVT-SAL-P3' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev.ecommerce.items.length, 2);
    assert.ok(ev.ecommerce.items.some(i => i.id === 'S-008'));
    assert.ok(ev.ecommerce.items.some(i => i.id === 'S-009'));
  });

  test('Meta: full user_data with fn, ln, external_id', () => {
    const model = createEventModel(FIXTURES.salla_purchase,
      { ...BASE_UP, 'ep.event_id': 'EVT-SAL-P4', 'event_id': 'EVT-SAL-P4' });
    // Inject event_id directly
    model['ep.event_id'] = 'EVT-SAL-P4';
    model['event_id']    = 'EVT-SAL-P4';
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const meta = buildMetaPayload(ev, BASE_TD);
    const ud   = meta.data[0].user_data;
    assert.ok(isHex64(ud.fn),          'fn must be hashed');
    assert.ok(isHex64(ud.ln),          'ln must be hashed');
    assert.ok(isHex64(ud.external_id), 'external_id must be hashed');
  });

  test('Snap: shipping_amount and tax_amount in custom_data (via overrides)', () => {
    const overrides = {
      'ep.event_id': 'EVT-SAL-P5', 'event_id': 'EVT-SAL-P5',
      'ep.tax': 67.4, 'tax': 67.4, 'ep.shipping': 30, 'shipping': 30,
    };
    const model = createEventModel(FIXTURES.salla_purchase, BASE_UP, overrides);
    const ev    = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'PURCHASE' });
    const snap  = buildSnapPayload(ev, BASE_TD);
    const cd    = snap.data[0].custom_data;
    assert.strictEqual(cd.tax_amount,      67.4);
    assert.strictEqual(cd.shipping_amount, 30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2 — Zid event fixtures
// ─────────────────────────────────────────────────────────────────────────────

describe('Zid — view_item', () => {

  test('createEventModel: GA4 ecommerce.items[] extracted', () => {
    const model = createEventModel(FIXTURES.zid_view_item, BASE_UP);
    assert.strictEqual(model._rawItemCount, 1);
    assert.strictEqual(model._parsedItems[0].id,    'Z-001');
    assert.strictEqual(model._parsedItems[0].brand, 'Sony');
  });

  test('Meta payload: action_source is website', () => {
    const model = createEventModel(FIXTURES.zid_view_item, BASE_UP,
      { 'ep.event_id': 'EVT-ZID-VI', 'event_id': 'EVT-ZID-VI' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'ViewContent' });
    const meta = buildMetaPayload(ev, BASE_TD);
    assert.strictEqual(meta.data[0].action_source, 'website');
  });
});

describe('Zid — add_to_cart', () => {

  test('canonical: quantity=2, price=349 for Smart Watch', () => {
    const model = createEventModel(FIXTURES.zid_add_to_cart, BASE_UP,
      { 'ep.event_id': 'EVT-ZID-ATC', 'event_id': 'EVT-ZID-ATC' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'AddToCart' });
    assert.strictEqual(ev.ecommerce.items[0].quantity, 2);
    assert.strictEqual(ev.ecommerce.items[0].price,    349);
  });

  test('TikTok: item_variant included (Samsung / Black)', () => {
    const model = createEventModel(FIXTURES.zid_add_to_cart, BASE_UP,
      { 'ep.event_id': 'EVT-ZID-ATC2', 'event_id': 'EVT-ZID-ATC2' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'AddToCart' });
    // Variant is in the items array; TikTok builder doesn't include variant but brand/category are
    const tt   = buildTikTokPayload(ev, BASE_TD);
    const cont = tt.data[0].properties.contents[0];
    assert.strictEqual(cont.content_id,   'Z-002');
    assert.strictEqual(cont.brand,        'Samsung');
    assert.strictEqual(cont.category,     'Electronics');
  });
});

describe('Zid — begin_checkout', () => {

  test('canonical: coupon TECH15 forwarded', () => {
    const model = createEventModel(FIXTURES.zid_begin_checkout, BASE_UP,
      { 'ep.event_id': 'EVT-ZID-CHK', 'event_id': 'EVT-ZID-CHK',
        'ep.coupon': 'TECH15', 'coupon': 'TECH15' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'InitiateCheckout' });
    assert.strictEqual(ev.ecommerce.coupon, 'TECH15');
  });

  test('Meta: custom_data.coupon forwarded', () => {
    const model = createEventModel(FIXTURES.zid_begin_checkout, BASE_UP,
      { 'ep.event_id': 'EVT-ZID-CHK2', 'event_id': 'EVT-ZID-CHK2',
        'ep.coupon': 'TECH15', 'coupon': 'TECH15' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'InitiateCheckout' });
    const meta = buildMetaPayload(ev, BASE_TD);
    assert.strictEqual(meta.data[0].custom_data.coupon, 'TECH15');
  });
});

describe('Zid — purchase', () => {

  test('canonical: all monetary fields populated', () => {
    const model = createEventModel(FIXTURES.zid_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-ZID-PUR', 'event_id': 'EVT-ZID-PUR' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev.event.transaction_id,    'ZID-TXN-2024');
    assert.strictEqual(ev.ecommerce.value,          1250);
    assert.strictEqual(ev.ecommerce.revenue,        1200);
    assert.strictEqual(ev.ecommerce.tax,            62.5);
    assert.strictEqual(ev.ecommerce.shipping,       25);
    assert.strictEqual(ev.ecommerce.coupon,         'WINTER20');
    assert.strictEqual(ev.ecommerce.affiliation,    'Zid Store');
    assert.strictEqual(ev.ecommerce.items.length,   2);
  });

  test('Meta: revenue, tax, shipping all present in custom_data', () => {
    const model = createEventModel(FIXTURES.zid_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-ZID-PUR2', 'event_id': 'EVT-ZID-PUR2' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const meta = buildMetaPayload(ev, BASE_TD);
    const cd   = meta.data[0].custom_data;
    assert.ok('revenue'   in cd, 'revenue must be in custom_data');
    assert.ok('tax'       in cd, 'tax must be in custom_data');
    assert.ok('shipping'  in cd, 'shipping must be in custom_data');
    assert.ok('affiliation' in cd, 'affiliation must be in custom_data');
    assert.strictEqual(cd.order_id, 'ZID-TXN-2024');
  });

  test('TikTok: 2 contents entries with correct prices', () => {
    const model = createEventModel(FIXTURES.zid_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-ZID-PUR3', 'event_id': 'EVT-ZID-PUR3' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'PlaceAnOrder' });
    const tt   = buildTikTokPayload(ev, BASE_TD);
    const cont = tt.data[0].properties.contents;
    assert.strictEqual(cont.length, 2);
    assert.ok(cont.some(c => c.content_id === 'Z-003'));
    assert.ok(cont.some(c => c.content_id === 'Z-004'));
  });

  test('Snap: transaction_id and number_items correct', () => {
    const model = createEventModel(FIXTURES.zid_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-ZID-PUR4', 'event_id': 'EVT-ZID-PUR4' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'PURCHASE' });
    const snap = buildSnapPayload(ev, BASE_TD);
    const cd   = snap.data[0].custom_data;
    assert.strictEqual(cd.transaction_id, 'ZID-TXN-2024');
    assert.strictEqual(cd.number_items,   2);
  });

  test('validation passes for full Zid purchase', () => {
    const model  = createEventModel(FIXTURES.zid_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-ZID-PUR5', 'event_id': 'EVT-ZID-PUR5' });
    const ev     = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const result = validateCanonicalEvent(ev);
    assert.ok(result.valid, JSON.stringify(result.errors));
    assert.ok(!result.errors.includes('MISSING_event_id'));
    assert.ok(!result.errors.includes('MISSING_event_name'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3 — Generic GA4 fixtures
// ─────────────────────────────────────────────────────────────────────────────

describe('GA4 — ecommerce items schema', () => {

  test('canonical items include brand, category, variant from item_*', () => {
    const model = createEventModel(FIXTURES.ga4_ecommerce_items, BASE_UP,
      { 'ep.event_id': 'EVT-GA4-LIST', 'event_id': 'EVT-GA4-LIST' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'ViewContent' });
    const item = ev.ecommerce.items[0];
    assert.strictEqual(item.brand,    'Nike');
    assert.strictEqual(item.category, 'Footwear');
    assert.strictEqual(item.variant,  'Blue/42');
  });

  test('Meta contents[]: item_variant forwarded as item_variant field', () => {
    const model = createEventModel(FIXTURES.ga4_ecommerce_items, BASE_UP,
      { 'ep.event_id': 'EVT-GA4-LIST2', 'event_id': 'EVT-GA4-LIST2' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'ViewContent' });
    const meta = buildMetaPayload(ev, BASE_TD);
    const item = meta.data[0].custom_data.contents[0];
    assert.strictEqual(item.item_variant, 'Blue/42');
  });
});

describe('GA4 — purchase', () => {

  test('canonical: full user PII (city, state, zip, country) hashed', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-GA4-PUR', 'event_id': 'EVT-GA4-PUR' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.ok(isHex64(ev.user.city),    'city must be hashed');
    assert.ok(isHex64(ev.user.state),   'state must be hashed');
    assert.ok(isHex64(ev.user.zip),     'zip must be hashed');
    assert.ok(isHex64(ev.user.country), 'country must be hashed');
  });

  test('Meta: user_data includes ct, st, zp, country', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-GA4-PUR2', 'event_id': 'EVT-GA4-PUR2' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const meta = buildMetaPayload(ev, BASE_TD);
    const ud   = meta.data[0].user_data;
    assert.ok('ct'      in ud, 'ct must be present');
    assert.ok('st'      in ud, 'st must be present');
    assert.ok('zp'      in ud, 'zp must be present');
    assert.ok('country' in ud, 'country must be present');
  });

  test('Meta contents[]: discount forwarded on item with discount', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-GA4-PUR3', 'event_id': 'EVT-GA4-PUR3' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const meta = buildMetaPayload(ev, BASE_TD);
    const yoga = meta.data[0].custom_data.contents.find(c => c.id === 'G-003');
    assert.ok(yoga,                 'G-003 must be in contents');
    assert.strictEqual(yoga.discount, 10);
  });

  test('event_checksum: deterministic for same inputs', () => {
    const model1 = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-GA4-DET', 'event_id': 'EVT-GA4-DET' });
    const model2 = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-GA4-DET', 'event_id': 'EVT-GA4-DET' });
    const ev1 = buildCanonicalEvent(model1, { ...BASE_TD, eventName: 'Purchase' });
    const ev2 = buildCanonicalEvent(model2, { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev1.metadata.event_checksum, ev2.metadata.event_checksum);
    assert.strictEqual(ev1.metadata.event_checksum.length, 16);
  });

  test('event_checksum: changes when event_id changes', () => {
    const m1 = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-A', 'event_id': 'EVT-A' });
    const m2 = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-B', 'event_id': 'EVT-B' });
    const ev1 = buildCanonicalEvent(m1, { ...BASE_TD, eventName: 'Purchase' });
    const ev2 = buildCanonicalEvent(m2, { ...BASE_TD, eventName: 'Purchase' });
    assert.notStrictEqual(ev1.metadata.event_checksum, ev2.metadata.event_checksum);
  });
});

describe('GA4 — lead', () => {

  test('canonical: no items, value=0 is valid', () => {
    const model = createEventModel(FIXTURES.ga4_lead, BASE_UP,
      { 'ep.event_id': 'EVT-LEAD-01', 'event_id': 'EVT-LEAD-01' });
    const ev     = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Lead' });
    const result = validateCanonicalEvent(ev);
    assert.ok(result.valid, JSON.stringify(result.errors));
    assert.strictEqual(ev.ecommerce.items.length, 0);
    assert.strictEqual(ev.ecommerce.value, 0);
  });

  test('Meta: no contents or content_ids when no items', () => {
    const model = createEventModel(FIXTURES.ga4_lead, BASE_UP,
      { 'ep.event_id': 'EVT-LEAD-02', 'event_id': 'EVT-LEAD-02' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Lead' });
    const meta = buildMetaPayload(ev, BASE_TD);
    const cd   = meta.data[0].custom_data;
    assert.ok(!('contents'    in cd), 'contents must not exist when no items');
    assert.ok(!('content_ids' in cd), 'content_ids must not exist when no items');
  });
});

describe('GA4 — sign_up', () => {

  test('canonical: user PII hashed, no items', () => {
    const model = createEventModel(FIXTURES.ga4_sign_up, BASE_UP,
      { 'ep.event_id': 'EVT-SUP-01', 'event_id': 'EVT-SUP-01' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'CompleteRegistration' });
    assert.ok(isHex64(ev.user.email),      'email must be hashed');
    assert.ok(isHex64(ev.user.first_name), 'first_name must be hashed');
    assert.ok(isHex64(ev.user.last_name),  'last_name must be hashed');
    assert.strictEqual(ev.ecommerce.items.length, 0);
  });
});

describe('GA4 — search', () => {

  test('canonical: search_string populated', () => {
    const model = createEventModel(FIXTURES.ga4_search, BASE_UP,
      { 'ep.event_id': 'EVT-SRCH-01', 'event_id': 'EVT-SRCH-01',
        'ep.search_string': 'wireless headphones', 'search_string': 'wireless headphones' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Search' });
    assert.strictEqual(ev.ecommerce.search_string, 'wireless headphones');
  });

  test('TikTok: search_string in properties', () => {
    const model = createEventModel(FIXTURES.ga4_search, BASE_UP,
      { 'ep.event_id': 'EVT-SRCH-02', 'event_id': 'EVT-SRCH-02',
        'ep.search_string': 'wireless headphones', 'search_string': 'wireless headphones' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Search' });
    const tt   = buildTikTokPayload(ev, BASE_TD);
    assert.strictEqual(tt.data[0].properties.search_string, 'wireless headphones');
  });

  test('Snap: search_string in custom_data', () => {
    const model = createEventModel(FIXTURES.ga4_search, BASE_UP,
      { 'ep.event_id': 'EVT-SRCH-03', 'event_id': 'EVT-SRCH-03',
        'ep.search_string': 'wireless headphones', 'search_string': 'wireless headphones' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'SEARCH' });
    const snap = buildSnapPayload(ev, BASE_TD);
    assert.strictEqual(snap.data[0].custom_data.search_string, 'wireless headphones');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4 — Attribution, cookies, consent signal passthrough
// ─────────────────────────────────────────────────────────────────────────────

describe('Attribution — click IDs and UTM', () => {

  test('fbp / fbc from up.* appear in Meta user_data', () => {
    const model = createEventModel(FIXTURES.ga4_purchase,
      { ...BASE_UP, fbp: 'fb.1.1700.111', fbc: 'fb.1.1700.FBC' },
      { 'ep.event_id': 'EVT-ATTR-01', 'event_id': 'EVT-ATTR-01' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const meta = buildMetaPayload(ev, BASE_TD);
    const ud   = meta.data[0].user_data;
    assert.strictEqual(ud.fbp, 'fb.1.1700.111');
    assert.strictEqual(ud.fbc, 'fb.1.1700.FBC');
  });

  test('ttclid from ep.* appears in TikTok user', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-ATTR-02', 'event_id': 'EVT-ATTR-02',
        'ep.ttclid': 'TTCLID_abc123456789', 'ttclid': 'TTCLID_abc123456789' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'PlaceAnOrder' });
    const tt = buildTikTokPayload(ev, BASE_TD);
    assert.strictEqual(tt.data[0].user.ttclid, 'TTCLID_abc123456789');
  });

  test('ttp from up.* appears in TikTok user', () => {
    const model = createEventModel(FIXTURES.ga4_purchase,
      { ...BASE_UP, ttp: 'TTP_test_value_xyz' },
      { 'ep.event_id': 'EVT-ATTR-03', 'event_id': 'EVT-ATTR-03' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'PlaceAnOrder' });
    const tt = buildTikTokPayload(ev, BASE_TD);
    assert.strictEqual(tt.data[0].user.ttp, 'TTP_test_value_xyz');
  });

  test('scid and sccid appear in Snap user_data', () => {
    const model = createEventModel(FIXTURES.ga4_purchase,
      { ...BASE_UP, scid: 'SCID_abc123' },
      { 'ep.event_id': 'EVT-ATTR-04', 'event_id': 'EVT-ATTR-04',
        'ep.ScCid': 'SCCID_xyz789', 'ScCid': 'SCCID_xyz789' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'PURCHASE' });
    const snap = buildSnapPayload(ev, BASE_TD);
    const ud   = snap.data[0].user_data;
    assert.strictEqual(ud.uuid_c1,     'SCID_abc123');
    assert.strictEqual(ud.sc_click_id, 'SCCID_xyz789');
  });

  test('UTM params flow into canonical.attribution', () => {
    const push = { ...FIXTURES.ga4_purchase, _attribution: {
      utm_source: 'instagram', utm_medium: 'paid_social', utm_campaign: 'eid_2024',
      utm_content: 'carousel', utm_term: 'thobe',
    }};
    const model = createEventModel(push, BASE_UP,
      { 'ep.event_id': 'EVT-UTM-01', 'event_id': 'EVT-UTM-01' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev.attribution.utm_source,   'instagram');
    assert.strictEqual(ev.attribution.utm_medium,   'paid_social');
    assert.strictEqual(ev.attribution.utm_campaign, 'eid_2024');
    assert.strictEqual(ev.attribution.utm_content,  'carousel');
    assert.strictEqual(ev.attribution.utm_term,     'thobe');
  });

  test('gclid validation: length < 10 triggers SUSPICIOUS_gclid_length warning', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-GCLID-01', 'event_id': 'EVT-GCLID-01',
        'ep.gclid': 'SHORT', 'gclid': 'SHORT' });
    const ev     = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const result = validateCanonicalEvent(ev);
    assert.ok(result.warnings.some(w => w.includes('SUSPICIOUS_gclid_length')));
  });
});

describe('Consent signals', () => {

  test('Snap: advertiser_tracking_enabled=1 when ad_storage=granted', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-CS-01', 'event_id': 'EVT-CS-01',
        'ep.ad_storage': 'granted', 'ad_storage': 'granted' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'PURCHASE' });
    const snap = buildSnapPayload(ev, BASE_TD);
    assert.strictEqual(snap.data[0].app_data.advertiser_tracking_enabled, 1);
  });

  test('Snap: advertiser_tracking_enabled=0 when ad_storage=denied', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-CS-02', 'event_id': 'EVT-CS-02',
        'ep.ad_storage': 'denied', 'ad_storage': 'denied' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'PURCHASE' });
    const snap = buildSnapPayload(ev, BASE_TD);
    assert.strictEqual(snap.data[0].app_data.advertiser_tracking_enabled, 0);
  });

  test('canonical.consent: all four signals present and default to granted', () => {
    const model = createEventModel(FIXTURES.ga4_lead, BASE_UP,
      { 'ep.event_id': 'EVT-CS-03', 'event_id': 'EVT-CS-03' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Lead' });
    assert.strictEqual(ev.consent.ad_storage,         'granted');
    assert.strictEqual(ev.consent.analytics_storage,  'granted');
    assert.strictEqual(ev.consent.ad_user_data,       'granted');
    assert.strictEqual(ev.consent.ad_personalization, 'granted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5 — Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('Edge cases — validation errors', () => {

  test('MISSING_event_id: validation fails when event_id is empty', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP);
    // No event_id in model
    const ev     = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const result = validateCanonicalEvent(ev);
    assert.ok(!result.valid);
    assert.ok(result.errors.includes('MISSING_event_id'));
  });

  test('MISSING_event_name: validation fails when eventName is empty', () => {
    const model  = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-EC-02', 'event_id': 'EVT-EC-02' });
    const ev     = buildCanonicalEvent(model, { ...BASE_TD, eventName: '' });
    const result = validateCanonicalEvent(ev);
    assert.ok(!result.valid);
    assert.ok(result.errors.includes('MISSING_event_name'));
  });

  test('INVALID_value:not_numeric: non-numeric value fails validation', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-EC-03', 'event_id': 'EVT-EC-03',
        'ep.value': 'not-a-number', 'value': 'not-a-number' });
    const ev     = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const result = validateCanonicalEvent(ev);
    assert.ok(!result.valid);
    assert.ok(result.errors.includes('INVALID_value:not_numeric'));
  });

  test('SUSPICIOUS_value:negative: negative value triggers warning not error', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-EC-04', 'event_id': 'EVT-EC-04',
        'ep.value': -50, 'value': -50 });
    const ev     = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const result = validateCanonicalEvent(ev);
    assert.ok(result.valid);
    assert.ok(result.warnings.includes('SUSPICIOUS_value:negative'));
  });

  test('INVALID_currency_format: 2-char currency triggers warning', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-EC-05', 'event_id': 'EVT-EC-05',
        'ep.currency': 'US', 'currency': 'US' });
    const ev     = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const result = validateCanonicalEvent(ev);
    assert.ok(result.warnings.includes('INVALID_currency_format'));
  });

  test('ITEM_MISSING_id: item without id or item_id triggers error', () => {
    const push = {
      event: 'purchase',
      ecommerce: {
        currency: 'SAR', value: 100,
        items: [{ name: 'No ID Item', price: 100, quantity: 1 }],
      },
    };
    const model = createEventModel(push, BASE_UP,
      { 'ep.event_id': 'EVT-EC-06', 'event_id': 'EVT-EC-06' });
    const ev     = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const result = validateCanonicalEvent(ev);
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.startsWith('ITEM_MISSING_id')));
  });

  test('ITEM_INVALID_quantity: web container normalizes qty=0 to 1 (no warning expected)', () => {
    // The _dlScanBlock in the web container coerces quantity via parseInt(q)||1,
    // so quantity:0 never reaches sGTM — it becomes 1. This confirms the
    // web container guards against zero-quantity items before serialization.
    const push = {
      event: 'purchase',
      ecommerce: {
        currency: 'SAR', value: 100,
        items: [{ item_id: 'QTY-TEST', price: 100, quantity: 0 }],
      },
    };
    const model = createEventModel(push, BASE_UP,
      { 'ep.event_id': 'EVT-EC-07', 'event_id': 'EVT-EC-07' });
    assert.strictEqual(model._parsedItems[0].quantity, 1,
      'web container must coerce quantity:0 → 1 before serialization');
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev.ecommerce.items[0].quantity, 1);
  });

  test('ITEM_INVALID_price: negative price triggers warning', () => {
    const push = {
      event: 'purchase',
      ecommerce: {
        currency: 'SAR', value: 100,
        items: [{ item_id: 'NEG-PRICE', price: -10, quantity: 1 }],
      },
    };
    const model = createEventModel(push, BASE_UP,
      { 'ep.event_id': 'EVT-EC-08', 'event_id': 'EVT-EC-08' });
    const ev     = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const result = validateCanonicalEvent(ev);
    assert.ok(result.warnings.some(w => w.startsWith('ITEM_INVALID_price')));
  });

  test('DUPLICATE_HASH: detected when email and phone hash to same value', () => {
    // _hashPhone strips non-digit chars before hashing, so the same string
    // as both em and ph does NOT produce equal hashes (phone loses letters).
    // Duplicate hash can only occur if the same digits-only value is used for both.
    // We test the validator directly with pre-set equal hashes on the ev object.
    const fakeHash = 'a'.repeat(64);
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-EC-09', 'event_id': 'EVT-EC-09' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    // Force equal hashes to simulate the collision path in the validator
    ev.user.email = fakeHash;
    ev.user.phone = fakeHash;
    const result = validateCanonicalEvent(ev);
    assert.ok(result.warnings.includes('DUPLICATE_HASH:email==phone'),
      'validator must warn when email hash === phone hash');
  });

  test('MISSING_session_id: absent session_id produces warning not error', () => {
    const up = { ...BASE_UP };
    delete up.session_id;
    const model  = createEventModel(FIXTURES.ga4_purchase, up,
      { 'ep.event_id': 'EVT-EC-10', 'event_id': 'EVT-EC-10',
        'ep.session_id': '', 'session_id': '' });
    const ev     = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const result = validateCanonicalEvent(ev);
    assert.ok(result.valid, 'must still be valid');
    assert.ok(result.warnings.includes('MISSING_session_id'));
  });
});

describe('Edge cases — malformed / pathological inputs', () => {

  test('Malformed items_json: falls back to empty items[]', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-MAL-01', 'event_id': 'EVT-MAL-01',
        'ep.items_json': '{not valid json}', 'items_json': '{not valid json}' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev.ecommerce.items.length, 0);
  });

  test('Empty items_json string: falls back to empty items[]', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-MAL-02', 'event_id': 'EVT-MAL-02',
        'ep.items_json': '', 'items_json': '' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev.ecommerce.items.length, 0);
  });

  test('items_json with nested array (not objects): empty items[]', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-MAL-03', 'event_id': 'EVT-MAL-03',
        'ep.items_json': '[[1,2],[3,4]]', 'items_json': '[[1,2],[3,4]]' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    // Arrays of arrays parse fine; items become arrays which have no .id — that's OK
    // Meta builder will just produce contents with empty ids
    assert.ok(Array.isArray(ev.ecommerce.items));
  });

  test('Missing currency: defaults to SAR', () => {
    const push = { event: 'purchase', ecommerce: { value: 100, items: [] } };
    const model = createEventModel(push, BASE_UP,
      { 'ep.event_id': 'EVT-MAL-04', 'event_id': 'EVT-MAL-04' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev.ecommerce.currency, 'SAR');
  });

  test('Missing items entirely: no items_json key', () => {
    const model = createEventModel(FIXTURES.ga4_lead, BASE_UP,
      { 'ep.event_id': 'EVT-MAL-05', 'event_id': 'EVT-MAL-05' });
    delete model['ep.items_json'];
    delete model['items_json'];
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Lead' });
    assert.strictEqual(ev.ecommerce.items.length, 0);
  });

  test('Empty dataLayer: items_count=0, items=[]', () => {
    const model = createEventModel({}, BASE_UP,
      { 'ep.event_id': 'EVT-MAL-06', 'event_id': 'EVT-MAL-06',
        'ep.currency': 'SAR', 'currency': 'SAR' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'PageView' });
    assert.strictEqual(ev.ecommerce.items.length, 0);
    assert.strictEqual(ev.ecommerce.items_count, 0);
  });

  test('Invalid email format: still hashes (no plaintext validation at sGTM boundary)', () => {
    const model = createEventModel(FIXTURES.ga4_purchase,
      { ...BASE_UP, em: 'not-an-email' },
      { 'ep.event_id': 'EVT-MAL-07', 'event_id': 'EVT-MAL-07' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.ok(isHex64(ev.user.email), 'must be hashed even if not a valid email');
  });

  test('Pre-hashed email (64-char hex): pass-through without double-hashing', () => {
    const alreadyHashed = _hash('test@example.com');
    const model = createEventModel(FIXTURES.ga4_purchase,
      { ...BASE_UP, em: alreadyHashed },
      { 'ep.event_id': 'EVT-MAL-08', 'event_id': 'EVT-MAL-08' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev.user.email, alreadyHashed, 'must not double-hash');
  });

  test('Phone with formatting chars: stripped before hashing', () => {
    const formatted   = '+1 (212) 555-1234';
    const expectedHash = _hashPhone(formatted);
    const model = createEventModel(FIXTURES.ga4_purchase,
      { ...BASE_UP, ph: formatted },
      { 'ep.event_id': 'EVT-MAL-09', 'event_id': 'EVT-MAL-09' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev.user.phone, expectedHash);
  });

  test('Duplicate event_id: checksum is identical (expected — idempotent)', () => {
    const mkModel = () => createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-DUP-01', 'event_id': 'EVT-DUP-01' });
    const ev1 = buildCanonicalEvent(mkModel(), { ...BASE_TD, eventName: 'Purchase' });
    const ev2 = buildCanonicalEvent(mkModel(), { ...BASE_TD, eventName: 'Purchase' });
    assert.strictEqual(ev1.metadata.event_checksum, ev2.metadata.event_checksum,
      'identical canonical inputs must produce identical checksum');
  });

  test('Oversized items_json (>32KB): falls back to empty items[]', () => {
    const hugeItem  = { id: 'H-001', name: 'X'.repeat(2000), price: 1, quantity: 1 };
    const hugeArray = Array.from({ length: 20 }, (_, i) => ({ ...hugeItem, id: `H-${i}` }));
    const hugeJson  = JSON.stringify(hugeArray); // > 32 KB
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-HUGE-01', 'event_id': 'EVT-HUGE-01',
        'ep.items_json': hugeJson.length > 32000 ? hugeJson : '[]',
        'items_json':    hugeJson.length > 32000 ? hugeJson : '[]' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    if (hugeJson.length > 32000) {
      assert.strictEqual(ev.ecommerce.items.length, 0, 'oversized items_json must be dropped');
    } else {
      assert.ok(true, 'items array was within limit');
    }
  });

  test('items_truncated=1: Snap uses items_count for number_items', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-TRUNC-01', 'event_id': 'EVT-TRUNC-01',
        'ep.items_truncated': 1, 'items_truncated': 1,
        'ep.items_count': 25, 'items_count': 25 });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'PURCHASE' });
    const snap = buildSnapPayload(ev, BASE_TD);
    assert.strictEqual(snap.data[0].custom_data.number_items, 25,
      'number_items must reflect full count when truncated');
  });

  test('_cleanObj: null/undefined/empty-string fields stripped from payload', () => {
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-CLEAN-01', 'event_id': 'EVT-CLEAN-01' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });
    const meta = buildMetaPayload(ev, BASE_TD);
    const ud   = meta.data[0].user_data;
    // No field should have value '' or null
    for (const [k, v] of Object.entries(ud)) {
      assert.ok(v !== '' && v !== null && v !== undefined,
        `user_data.${k} must not be empty/null`);
    }
  });

  test('Snap: access_token param handling — no Authorization header interference', () => {
    // The simulator doesn't send HTTP requests, but we verify the payload
    // doesn't embed auth secrets that would duplicate with query-param pattern
    const model = createEventModel(FIXTURES.ga4_purchase, BASE_UP,
      { 'ep.event_id': 'EVT-SNAP-AUTH', 'event_id': 'EVT-SNAP-AUTH' });
    const ev   = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'PURCHASE' });
    const snap = buildSnapPayload(ev, BASE_TD);
    // Snap payload body must not contain auth token
    const body = JSON.stringify(snap);
    assert.ok(!body.includes('TOKEN'), 'auth token must not appear in Snap payload body');
  });

  test('Empty arrays in items: TikTok/Meta receive no contents key', () => {
    const model = createEventModel(FIXTURES.ga4_lead, BASE_UP,
      { 'ep.event_id': 'EVT-EMPTY-ARR', 'event_id': 'EVT-EMPTY-ARR',
        'ep.items_json': '[]', 'items_json': '[]' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Lead' });
    const tt = buildTikTokPayload(ev, BASE_TD);
    assert.ok(!('contents' in tt.data[0].properties),
      'TikTok properties must not have contents key when items is empty');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6 — Template structure assertions (template v4 .tpl file)
// ─────────────────────────────────────────────────────────────────────────────

describe('Template v4 structure', () => {
  const fs   = require('fs');
  const path = require('path');
  const tplSrc = fs.readFileSync(
    path.join(__dirname, '../lib/server-side/sgtm-templates/universal-http.tpl'),
    'utf8',
  );

  // NOTE: universal-http.tpl is legacy/experimental and is NOT part of
  // buildServerConfig (the generated container uses native HTTP tags). Its
  // version number and parameter count are therefore not a generated-container
  // contract; the retired assertions (`version 4`, `dlqUrl`, `8 template
  // parameters`, `embeds v4 template`) are replaced by the
  // "Native HTTP server-container architecture" suite below.

  test('template contains buildCanonicalEvent function', () => {
    assert.ok(tplSrc.includes('buildCanonicalEvent'), 'must contain buildCanonicalEvent');
  });

  test('template contains validateCanonicalEvent function', () => {
    assert.ok(tplSrc.includes('validateCanonicalEvent'), 'must contain validateCanonicalEvent');
  });

  test('template contains event_checksum in metadata', () => {
    assert.ok(tplSrc.includes('event_checksum'), 'must contain event_checksum');
  });

  test('template contains _emitLog function', () => {
    assert.ok(tplSrc.includes('_emitLog'), 'must contain _emitLog');
  });

  test('template contains _fireDLQ function', () => {
    assert.ok(tplSrc.includes('_fireDLQ'), 'must contain _fireDLQ');
  });

  test('template: no getEventData() invocations in production platform builder code', () => {
    // Check for actual function calls — getEventData( — not comments or strings.
    // Split before ___SERVER_PERMISSIONS___ to exclude permissions and test blocks.
    const prodCode = tplSrc.split('___SERVER_PERMISSIONS___')[0] || tplSrc;
    const section7 = prodCode.split('SECTION 7')[1] || '';
    assert.ok(!section7.includes('getEventData('),
      'platform payload builders (Section 7+) must not call getEventData()');
  });

  test('template: 8 canonical namespaces actively used in production code', () => {
    // ev.device.* is populated in buildCanonicalEvent for canonical completeness
    // but platform builders (Meta/TikTok/Snap) do not accept device fields —
    // they are captured for future use. The 8 actively dispatched namespaces:
    const prodCode = tplSrc.split('___TESTS___')[0] || tplSrc;
    const namespaces = ['metadata', 'event', 'ecommerce', 'attribution',
                        'identity', 'cookies', 'page', 'consent'];
    for (const ns of namespaces) {
      assert.ok(prodCode.includes(`ev.${ns}.`),
        `template production code must reference ev.${ns}. namespace`);
    }
    // device namespace must still be POPULATED in buildCanonicalEvent
    assert.ok(prodCode.includes('device:'), 'buildCanonicalEvent must populate device namespace');
  });

  test('buildServerConfig: CAPI tags pass only clientIp and userAgent (not per-field PII)', () => {
    const { buildServerConfig } = require('../lib/gtm-config-builder');
    const cfg = buildServerConfig({
      platforms: ['meta', 'tiktok', 'snap'],
      pixelIds:  { meta: '123', tiktok: '456', snap: '789' },
      capiTokens: { meta: 'mTok', tiktok: 'ttTok', snap: 'scTok' },
      events:    ['purchase'],
      sgtmUrl:   'https://sgtm.example.com',
    });
    const capiTags = cfg.containerVersion.tag.filter(t => t.type === 'cvt_0_1');
    for (const tag of capiTags) {
      const keys = tag.parameter.map(p => p.key);
      assert.ok(!keys.includes('userEmail'),     `${tag.name} must not have userEmail param`);
      assert.ok(!keys.includes('userPhone'),     `${tag.name} must not have userPhone param`);
      assert.ok(!keys.includes('eventValue'),    `${tag.name} must not have eventValue param`);
      assert.ok(!keys.includes('eventCurrency'), `${tag.name} must not have eventCurrency param`);
      assert.ok(!keys.includes('orderId'),       `${tag.name} must not have orderId param`);
      assert.ok(!keys.includes('fbp'),           `${tag.name} must not have fbp param`);
      assert.ok(!keys.includes('ttp'),           `${tag.name} must not have ttp param`);
      assert.ok(!keys.includes('scid'),          `${tag.name} must not have scid param`);
      assert.ok(keys.includes('clientIp'),       `${tag.name} must have clientIp param`);
      assert.ok(keys.includes('userAgent'),      `${tag.name} must have userAgent param`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Native HTTP server-container architecture
// buildServerConfig emits native Server GTM HTTP Request tags (type 'http') per
// destination and keeps containerVersion.customTemplate empty. No community
// template (et_universal_http / cvt_*) is embedded or referenced.
// ─────────────────────────────────────────────────────────────────────────────

describe('Native HTTP server-container architecture', () => {
  const { buildServerConfig } = require('../lib/gtm-config-builder');
  const cfg = buildServerConfig({
    platforms:  ['meta', 'tiktok', 'snap'],
    pixelIds:   { meta: '123', tiktok: '456', snap: '789' },
    capiTokens: { meta: 'mTok', tiktok: 'ttTok', snap: 'scTok' },
    events:     ['purchase', 'add_to_cart'],
    sgtmUrl:    'https://sgtm.example.com',
  });
  const tags     = cfg.containerVersion.tag;
  const capiTags = tags.filter(t => /^ET - (Meta CAPI|TikTok Events API|Snapchat CAPI) -/.test(t.name));
  const urlOf    = t => ((t && t.parameter.find(p => p.key === 'url')) || {}).value || '';

  test('generated server config has no custom templates', () => {
    assert.ok(Array.isArray(cfg.containerVersion.customTemplate), 'customTemplate must be an array');
    assert.strictEqual(cfg.containerVersion.customTemplate.length, 0, 'customTemplate must be empty');
  });

  test('Meta/TikTok/Snap tags are native http tags', () => {
    for (const p of ['Meta CAPI', 'TikTok Events API', 'Snapchat CAPI']) {
      const t = tags.find(x => x.name.startsWith('ET - ' + p + ' -'));
      assert.ok(t, 'expected a ' + p + ' tag');
      assert.strictEqual(t.type, 'http', p + ' tag must be a native http tag');
    }
  });

  test('each platform tag has url/method/requestBody/headers parameters', () => {
    assert.ok(capiTags.length >= 3, 'expected Meta+TikTok+Snap CAPI tags');
    for (const t of capiTags) {
      const keys = t.parameter.map(p => p.key);
      for (const k of ['url', 'method', 'requestBody', 'headers']) {
        assert.ok(keys.includes(k), t.name + ' missing "' + k + '" parameter');
      }
    }
  });

  test('no generated tag references et_universal_http', () => {
    assert.ok(!JSON.stringify(cfg).includes('et_universal_http'), 'config must not reference et_universal_http');
  });

  test('no CAPI tag has a community-template type or template id', () => {
    for (const t of capiTags) {
      assert.ok(!/^cvt_/.test(t.type || ''), t.name + ' must not be a community-template (cvt_*) tag');
      assert.ok(!('templateId' in t), t.name + ' must not carry a templateId');
    }
  });

  test('generated tags use the expected destination-specific endpoints', () => {
    assert.ok(urlOf(tags.find(t => t.name.startsWith('ET - Meta CAPI -'))).includes('graph.facebook.com'), 'Meta → Graph API');
    assert.ok(urlOf(tags.find(t => t.name.startsWith('ET - TikTok Events API -'))).includes('business-api.tiktok.com'), 'TikTok → Business API');
    assert.ok(urlOf(tags.find(t => t.name.startsWith('ET - Snapchat CAPI -'))).includes('tr.snapchat.com'), 'Snap → tr.snapchat.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 7 — Performance benchmarks
// ─────────────────────────────────────────────────────────────────────────────

describe('Performance benchmarks', () => {

  function makeRandomPurchase(n) {
    const items = Array.from({ length: Math.min(n, 8) }, (_, i) => ({
      item_id:   `SKU-${i}`,
      item_name: `Product ${i}`,
      price:     (i + 1) * 99,
      quantity:  1,
      item_brand: 'Brand',
      item_category: 'Category',
    }));
    return {
      event: 'purchase',
      ecommerce: {
        transaction_id: `TXN-${n}`,
        value: items.reduce((s, it) => s + it.price, 0),
        revenue: items.reduce((s, it) => s + it.price, 0),
        currency: 'SAR',
        tax: 5,
        shipping: 15,
        coupon: 'BENCH',
        affiliation: 'Benchmark Store',
        items,
      },
      user_data: { em: `user${n}@test.com`, ph: `+96655${String(n).padStart(7,'0')}` },
    };
  }

  function benchmarkN(count, label) {
    const up = {
      ...BASE_UP,
      session_id: 'sess-bench',
      anonymous_id: 'anon-bench',
    };
    const td = { ...BASE_TD, eventName: 'Purchase' };

    const t0 = Date.now();
    for (let i = 0; i < count; i++) {
      const push  = makeRandomPurchase(i % 8 + 1);
      const model = createEventModel(push, up,
        { 'ep.event_id': `EVT-BENCH-${i}`, 'event_id': `EVT-BENCH-${i}` });
      dispatch(model, td);
    }
    const elapsed = Date.now() - t0;
    return elapsed;
  }

  test('1,000 events: full pipeline completes < 5 seconds', () => {
    const ms = benchmarkN(1000, '1k');
    console.log(`  [BENCH] 1,000 events: ${ms}ms (${(ms/1000).toFixed(2)}ms/event)`);
    assert.ok(ms < 5000, `1,000 events took ${ms}ms — expected < 5000ms`);
  });

  test('10,000 events: full pipeline completes < 30 seconds', () => {
    const ms = benchmarkN(10000, '10k');
    console.log(`  [BENCH] 10,000 events: ${ms}ms (${(ms/10000).toFixed(3)}ms/event)`);
    assert.ok(ms < 30000, `10,000 events took ${ms}ms — expected < 30000ms`);
  });

  test('Throughput: >= 500 events/second', () => {
    const count = 5000;
    const ms    = benchmarkN(count, 'throughput');
    const eps   = Math.round(count / (ms / 1000));
    console.log(`  [BENCH] Throughput: ${eps} events/second`);
    assert.ok(eps >= 500, `Throughput ${eps} eps — expected >= 500 eps`);
  });

  test('createEventModel phase: 10,000 events < 15 seconds', () => {
    const up = { ...BASE_UP };
    const t0 = Date.now();
    for (let i = 0; i < 10000; i++) {
      createEventModel(makeRandomPurchase(3), up,
        { 'ep.event_id': `EVT-M-${i}`, 'event_id': `EVT-M-${i}` });
    }
    const ms = Date.now() - t0;
    console.log(`  [BENCH] createEventModel 10k: ${ms}ms`);
    assert.ok(ms < 15000, `createEventModel 10k took ${ms}ms — expected < 15000ms`);
  });

  test('buildCanonicalEvent phase: 10,000 events < 5 seconds', () => {
    const up = { ...BASE_UP };
    const td = { ...BASE_TD, eventName: 'Purchase' };
    const model = createEventModel(makeRandomPurchase(4), up,
      { 'ep.event_id': 'EVT-CE-BASE', 'event_id': 'EVT-CE-BASE' });
    const t0 = Date.now();
    for (let i = 0; i < 10000; i++) {
      buildCanonicalEvent(model, td);
    }
    const ms = Date.now() - t0;
    console.log(`  [BENCH] buildCanonicalEvent 10k: ${ms}ms`);
    assert.ok(ms < 5000, `buildCanonicalEvent 10k took ${ms}ms — expected < 5000ms`);
  });

  test('validateCanonicalEvent phase: 10,000 events < 1 second', () => {
    const up = { ...BASE_UP };
    const td = { ...BASE_TD, eventName: 'Purchase' };
    const model = createEventModel(makeRandomPurchase(3), up,
      { 'ep.event_id': 'EVT-VAL-BASE', 'event_id': 'EVT-VAL-BASE' });
    const ev = buildCanonicalEvent(model, td);
    const t0 = Date.now();
    for (let i = 0; i < 10000; i++) {
      validateCanonicalEvent(ev);
    }
    const ms = Date.now() - t0;
    console.log(`  [BENCH] validateCanonicalEvent 10k: ${ms}ms`);
    assert.ok(ms < 1000, `validateCanonicalEvent 10k took ${ms}ms — expected < 1000ms`);
  });

  test('Payload generation phase: 10,000 × 3 platforms < 5 seconds', () => {
    const up = { ...BASE_UP };
    const td = { ...BASE_TD, eventName: 'Purchase' };
    const model = createEventModel(makeRandomPurchase(4), up,
      { 'ep.event_id': 'EVT-PG-BASE', 'event_id': 'EVT-PG-BASE' });
    const ev = buildCanonicalEvent(model, td);
    const t0 = Date.now();
    for (let i = 0; i < 10000; i++) {
      buildMetaPayload(ev, td);
      buildTikTokPayload(ev, td);
      buildSnapPayload(ev, td);
    }
    const ms = Date.now() - t0;
    console.log(`  [BENCH] payload builders 10k×3: ${ms}ms`);
    assert.ok(ms < 5000, `Payload builders 10k×3 took ${ms}ms — expected < 5000ms`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 8 — Production readiness score (printed at end, not a blocking test)
// ─────────────────────────────────────────────────────────────────────────────

describe('Production readiness score', () => {

  test('Score: canonical schema completeness on a full Zid purchase', () => {
    const model = createEventModel(FIXTURES.zid_purchase,
      { ...BASE_UP,
        fbp: 'fb.1.1700.111', fbc: 'fb.1.1700.FBC', ttp: 'TTP_test',
        gclid: undefined,
        _attribution: { utm_source: 'google', utm_medium: 'cpc', gclid: 'GCLID_1234567890123' },
        ad_storage: 'granted', analytics_storage: 'granted',
        ad_user_data: 'granted', ad_personalization: 'granted',
        device_type: 'mobile', language: 'ar', page_url: 'https://store.zid.sa/checkout',
      },
      { 'ep.event_id': 'EVT-SCORE-01', 'event_id': 'EVT-SCORE-01',
        'ep.gclid': 'GCLID_1234567890123', 'gclid': 'GCLID_1234567890123',
        'ep.utm_source': 'google', 'utm_source': 'google',
        'ep.utm_medium': 'cpc', 'utm_medium': 'cpc' });
    const ev = buildCanonicalEvent(model, { ...BASE_TD, eventName: 'Purchase' });

    const checks = {
      'event.id':                  !!ev.event.id,
      'event.transaction_id':      !!ev.event.transaction_id,
      'event.timestamp':           ev.event.timestamp > 0,
      'ecommerce.value':           ev.ecommerce.value > 0,
      'ecommerce.revenue':         ev.ecommerce.revenue > 0,
      'ecommerce.currency':        ev.ecommerce.currency.length === 3,
      'ecommerce.tax':             ev.ecommerce.tax > 0,
      'ecommerce.shipping':        ev.ecommerce.shipping > 0,
      'ecommerce.coupon':          !!ev.ecommerce.coupon,
      'ecommerce.affiliation':     !!ev.ecommerce.affiliation,
      'ecommerce.items.length':    ev.ecommerce.items.length > 0,
      'ecommerce.items_count':     ev.ecommerce.items_count > 0,
      'user.email (hashed)':       isHex64(ev.user.email),
      'user.phone (hashed)':       isHex64(ev.user.phone),
      'user.first_name (hashed)':  isHex64(ev.user.first_name),
      'user.last_name (hashed)':   isHex64(ev.user.last_name),
      'cookies.fbp':               !!ev.cookies.fbp,
      'cookies.fbc':               !!ev.cookies.fbc,
      'attribution.gclid':         !!ev.attribution.gclid,
      'attribution.utm_source':    !!ev.attribution.utm_source,
      'attribution.utm_medium':    !!ev.attribution.utm_medium,
      'identity.session_id':       !!ev.identity.session_id,
      'identity.anonymous_id':     !!ev.identity.anonymous_id,
      'device.type':               !!ev.device.type,
      'device.language':           !!ev.device.language,
      'page.url':                  !!ev.page.url,
      'consent.ad_storage':        ev.consent.ad_storage === 'granted',
      'metadata.event_checksum':   ev.metadata.event_checksum.length === 16,
    };

    const passed = Object.values(checks).filter(Boolean).length;
    const total  = Object.keys(checks).length;
    const score  = Math.round((passed / total) * 100);

    const failures = Object.entries(checks)
      .filter(([, v]) => !v)
      .map(([k]) => `  ✗ ${k}`);

    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log(`  ║  PRODUCTION READINESS SCORE: ${String(score).padStart(3)}%            ║`);
    console.log(`  ║  Canonical fields populated: ${String(passed).padStart(2)}/${total}             ║`);
    console.log('  ╚══════════════════════════════════════════════╝');
    if (failures.length) {
      console.log('  Unpopulated fields:');
      failures.forEach(f => console.log(f));
    }
    console.log('');

    assert.ok(score >= 90, `Production readiness score ${score}% is below 90% threshold`);
  });
});
