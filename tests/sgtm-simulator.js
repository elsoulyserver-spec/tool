'use strict';

/**
 * sgtm-simulator.js
 *
 * Node.js faithful port of the universal-http.tpl v4 template logic.
 * Replaces sGTM sandbox APIs with Node.js equivalents so the full
 * canonical-event pipeline can be exercised outside of Google Tag Manager.
 *
 * sGTM sandbox API → Node.js equivalent
 *   getEventData(k)          → eventModel[k]  (injected map)
 *   sha256Sync(s, opts)      → crypto SHA-256
 *   makeString(v)            → String(v) with null guard
 *   getTimestampMillis()     → Date.now()
 *   Math                     → global Math
 *   JSON                     → global JSON
 *
 * Exports
 *   createEventModel(pushes, userProps, overrides)
 *   buildCanonicalEvent(eventModel, templateData)
 *   validateCanonicalEvent(ev)
 *   buildMetaPayload(ev, templateData)
 *   buildTikTokPayload(ev, templateData)
 *   buildSnapPayload(ev, templateData)
 *   dispatch(eventModel, templateData)
 *   _hash, _hashPhone, _normItemForPlatform, _buildContentIds, isHex64
 */

const crypto = require('crypto');
const vm     = require('node:vm');
const { _dlScanBlock } = require('../lib/gtm-config-builder');

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Sandbox utility ports
// ═════════════════════════════════════════════════════════════════════════════

function _makeString(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function _sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function isHex64(s) {
  if (!s || s.length !== 64) return false;
  // Use indexOf loop — mirrors the sGTM sandbox version (no regex).
  const HEX = '0123456789abcdef';
  for (let i = 0; i < 64; i++) {
    if (HEX.indexOf(s.charAt(i)) === -1) return false;
  }
  return true;
}

function _hash(raw) {
  if (!raw) return '';
  const s = _makeString(raw).toLowerCase().trim();
  if (!s) return '';
  if (isHex64(s)) return s;
  return _sha256hex(s);
}

function _hashPhone(raw) {
  if (!raw) return '';
  const s = _makeString(raw).trim()
    .replace(/ /g, '').replace(/-/g, '').replace(/\(/g, '')
    .replace(/\)/g, '').replace(/\./g, '');
  if (!s) return '';
  if (isHex64(s)) return s;
  return _sha256hex(s);
}

function _cleanObj(o) {
  const r = {};
  for (const k in o) {
    if (o[k] !== '' && o[k] !== null && o[k] !== undefined) r[k] = o[k];
  }
  return r;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Web container simulation
// Converts raw browser dataLayer pushes into the ep.*/up.* event model that
// the GA4 client sends to sGTM via the Measurement Protocol.
// ═════════════════════════════════════════════════════════════════════════════

const ITEMS_LIMIT = 16000;

function _normItemWeb(it, full) {
  const o = {
    id:       String(it.item_id || it.id || ''),
    name:     String(it.item_name || it.name || ''),
    price:    parseFloat(it.price) || 0,
    quantity: parseInt(it.quantity, 10) || 1,
  };
  if (full) {
    if (it.item_brand || it.brand) {
      o.brand = String(it.item_brand || it.brand);
    }
    const cat = it.item_category || it.category;
    if (cat) {
      o.category = typeof cat === 'object'
        ? String(cat.name || cat.title || '')
        : String(cat);
    }
    if (it.item_variant || it.variant) {
      o.variant = String(it.item_variant || it.variant);
    }
    if (it.coupon)      o.coupon      = String(it.coupon);
    if (it.affiliation) o.affiliation = String(it.affiliation);
    if (it.discount)    o.discount    = parseFloat(it.discount) || 0;
    if (it.item_sku || it.sku) o.sku = String(it.item_sku || it.sku);
  }
  return o;
}

function _runDlScan(dataLayerPushes) {
  const code = `var raw = null; var window = { dataLayer: PUSHES }; ${_dlScanBlock('raw')}`;
  const ctx  = vm.createContext({ PUSHES: dataLayerPushes });
  vm.runInContext(code, ctx);
  return ctx.raw || [];
}

function _serializeItems(rawItems) {
  if (!rawItems || !rawItems.length) return '[]';

  // Pass 1: full fields
  const full = rawItems.map(it => _normItemWeb(it, true));
  let s = JSON.stringify(full);
  if (s.length <= ITEMS_LIMIT) return s;

  // Pass 2: lean (no optional fields)
  const lean = rawItems.map(it => _normItemWeb(it, false));
  s = JSON.stringify(lean);
  if (s.length <= ITEMS_LIMIT) return s;

  // Pass 3: truncate by revenue desc
  lean.sort((a, b) => (b.price * b.quantity) - (a.price * a.quantity));
  const trimmed = [];
  for (const item of lean) {
    trimmed.push(item);
    if (JSON.stringify(trimmed).length > ITEMS_LIMIT) { trimmed.pop(); break; }
  }
  return JSON.stringify(trimmed);
}

/**
 * createEventModel
 *
 * Simulates the web-container GA4 tag. Takes raw dataLayer pushes (what the
 * browser sees) and produces the ep.X/up.X key-value map that the sGTM template
 * receives via getEventData().
 *
 * @param {object|object[]} pushes    - Raw dataLayer push(es)
 * @param {object}          [up]      - User properties override (em, ph, fn, ln, fbp, …)
 * @param {object}          [overrides] - Direct ep.* key overrides applied last
 */
function createEventModel(pushes, up = {}, overrides = {}) {
  const all    = Array.isArray(pushes) ? pushes : [pushes];
  const latest = all[all.length - 1] || {};
  const ec     = latest.ecommerce || {};

  // Ecommerce scalars from the push
  const value    = parseFloat(ec.value    || latest.value    || 0) || 0;
  const revenue  = parseFloat(ec.revenue  || latest.revenue  || value) || value;
  const currency = ec.currency || ec.currencyCode || latest.currency || 'SAR';

  // transaction_id: Salla stores it in actionField, GA4 stores it at ec level
  const txnId = (ec.purchase && ec.purchase.actionField)
    ? (_makeString(ec.purchase.actionField.id || ec.purchase.actionField.revenue || ''))
    : (_makeString(ec.transaction_id || latest.transaction_id || ''));

  const tax         = parseFloat(ec.tax         || latest.tax         || 0) || 0;
  const shipping    = parseFloat(ec.shipping    || latest.shipping    || 0) || 0;
  const coupon      = _makeString(ec.coupon     || latest.coupon      || '');
  const affiliation = _makeString(ec.affiliation || latest.affiliation || '');
  const eventId     = _makeString(latest.event_id || '');

  // Items
  const rawItems     = _runDlScan(all);
  const itemsJson    = _serializeItems(rawItems);
  const itemsCount   = rawItems.length;
  const leanSize     = JSON.stringify(rawItems.map(it => _normItemWeb(it, false))).length;
  const itemsTrunc   = leanSize > ITEMS_LIMIT ? 1 : 0;

  // User data (from push or up overrides)
  const ud = latest.user_data || {};
  const attr = latest._attribution || {};

  const model = {
    // Event identity
    'ep.event_id':   eventId, 'event_id':   eventId,

    // Ecommerce
    'ep.value':           value,       'value':           value,
    'ep.revenue':         revenue,     'revenue':         revenue,
    'ep.currency':        currency,    'currency':        currency,
    'ep.transaction_id':  txnId,       'transaction_id':  txnId,
    'ep.tax':             tax,         'tax':             tax,
    'ep.shipping':        shipping,    'shipping':        shipping,
    'ep.coupon':          coupon,      'coupon':          coupon,
    'ep.affiliation':     affiliation, 'affiliation':     affiliation,
    'ep.content_name':    _makeString(latest.content_name || ''),
    'content_name':       _makeString(latest.content_name || ''),
    'ep.content_type':    _makeString(latest.content_type || 'product'),
    'content_type':       _makeString(latest.content_type || 'product'),
    'ep.search_string':   _makeString(latest.search_string || latest.search_term || ''),
    'search_string':      _makeString(latest.search_string || latest.search_term || ''),

    // Items
    'ep.items_json':      itemsJson,   'items_json':      itemsJson,
    'ep.items_count':     itemsCount,  'items_count':     itemsCount,
    'ep.items_truncated': itemsTrunc,  'items_truncated': itemsTrunc,

    // User properties (up.*)
    'up.em':          up.em  || ud.em  || '',
    'up.ph':          up.ph  || ud.ph  || '',
    'up.fn':          up.fn  || ud.fn  || '',
    'up.ln':          up.ln  || ud.ln  || '',
    'up.external_id': up.external_id || ud.external_id || '',
    'up.ct':          up.ct  || ud.ct  || '',
    'up.st':          up.st  || ud.st  || '',
    'up.zp':          up.zp  || ud.zp  || '',
    'up.country':     up.country || ud.country || '',
    'up.fbp':         up.fbp  || '',
    'up.fbc':         up.fbc  || '',
    'up.ttp':         up.ttp  || '',
    'up.scid':        up.scid || '',
    'ep._fbp': up.fbp || '', 'ep._fbc': up.fbc || '',
    'ep._ttp': up.ttp || '', 'ep._scid':up.scid || '',
    'ep._gid': up.gid || '',

    // Attribution
    'ep.fbclid':    attr.fbclid    || '', 'fbclid':   attr.fbclid    || '',
    'ep.gclid':     attr.gclid     || '', 'gclid':    attr.gclid     || '',
    'ep.gbraid':    attr.gbraid    || '',
    'ep.wbraid':    attr.wbraid    || '',
    'ep.ttclid':    attr.ttclid    || '', 'ttclid':   attr.ttclid    || '',
    'ep.ScCid':     attr.ScCid     || '', 'ScCid':    attr.ScCid     || '',
    'ep.msclkid':   attr.msclkid   || '',
    'ep.li_fat_id': attr.li_fat_id || '',

    // UTM
    'ep.utm_source':   attr.utm_source   || '', 'utm_source':   attr.utm_source   || '',
    'ep.utm_medium':   attr.utm_medium   || '', 'utm_medium':   attr.utm_medium   || '',
    'ep.utm_campaign': attr.utm_campaign || '',
    'ep.utm_content':  attr.utm_content  || '',
    'ep.utm_term':     attr.utm_term     || '',

    // Session / identity
    'ep.session_id':   up.session_id   || '', 'session_id':   up.session_id   || '',
    'ep.anonymous_id': up.anonymous_id || '', 'anonymous_id': up.anonymous_id || '',
    'ep.ga_client_id': up.ga_client_id || '',

    // Device
    'ep.device_type':       up.device_type       || '',
    'ep.language':          up.language          || '',
    'ep.timezone':          up.timezone          || '',
    'ep.viewport':          up.viewport          || '',
    'ep.screen_resolution': up.screen_resolution || '',

    // Page
    'ep.page_url':      up.page_url      || '', 'page_location': up.page_url      || '',
    'ep.page_referrer': up.page_referrer || '', 'page_referrer': up.page_referrer || '',
    'ep.page_title':    up.page_title    || '',

    // Consent
    'ep.ad_storage':         up.ad_storage         || 'granted',
    'ad_storage':            up.ad_storage         || 'granted',
    'ep.analytics_storage':  up.analytics_storage  || 'granted',
    'analytics_storage':     up.analytics_storage  || 'granted',
    'ep.ad_user_data':       up.ad_user_data       || 'granted',
    'ad_user_data':          up.ad_user_data       || 'granted',
    'ep.ad_personalization': up.ad_personalization || 'granted',
    'ad_personalization':    up.ad_personalization || 'granted',

    ...overrides,
  };

  // Attach parsed items for test assertions (not part of the real event model)
  model._parsedItems   = rawItems.map(it => _normItemWeb(it, true));
  model._rawItemCount  = rawItems.length;

  return model;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — buildCanonicalEvent
// Exact port of template Section 2. Reads only from eventModel (no side effects).
// ═════════════════════════════════════════════════════════════════════════════

function buildCanonicalEvent(eventModel, templateData) {
  const td  = templateData || {};
  const now = Date.now();
  const ts  = Math.floor(now / 1000);

  function ed(epKey, bareKey) {
    let v = eventModel[epKey];
    if (v !== null && v !== undefined && v !== '') return v;
    if (bareKey) {
      v = eventModel[bareKey];
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return '';
  }

  // Items
  const itemsRaw = ed('ep.items_json', 'items_json') || '[]';
  let items = [];
  if (itemsRaw.length <= 32000) {
    try {
      const p = JSON.parse(itemsRaw);
      if (Array.isArray(p) && p.length) items = p;
    } catch (_) { /* malformed — stays [] */ }
  }
  const itemsTruncated = ed('ep.items_truncated', 'items_truncated') === 1 ||
                         ed('ep.items_truncated', 'items_truncated') === '1';
  const itemsCount = parseInt(ed('ep.items_count', 'items_count'), 10) || items.length;

  // PII (hash after resolution)
  const rawEm  = eventModel['up.em']         || eventModel['user_data.em']          || '';
  const rawPh  = eventModel['up.ph']         || eventModel['user_data.ph']          || '';
  const rawFn  = eventModel['up.fn']         || eventModel['user_data.fn']          || '';
  const rawLn  = eventModel['up.ln']         || eventModel['user_data.ln']          || '';
  const rawExt = eventModel['up.external_id']|| eventModel['user_data.external_id'] ||
                 eventModel['user_id']        || '';
  const rawCt  = eventModel['up.ct']         || eventModel['user_data.ct']          || '';
  const rawSt  = eventModel['up.st']         || eventModel['user_data.st']          || '';
  const rawZp  = eventModel['up.zp']         || eventModel['user_data.zp']          || '';
  const rawCo  = eventModel['up.country']    || eventModel['user_data.country']     || '';

  const value    = ed('ep.value',    'value')    || 0;
  const revenue  = ed('ep.revenue',  'revenue')  || value;
  const _eventId  = ed('ep.event_id', 'event_id') || '';
  const _orderId  = ed('ep.transaction_id', 'transaction_id') || '';
  const _currency = ed('ep.currency', 'currency') || 'SAR';

  const checksumInput = _makeString(td.eventName) + '|' +
                        _makeString(_eventId)      + '|' +
                        _makeString(_orderId)      + '|' +
                        _makeString(value)         + '|' +
                        _makeString(_currency)     + '|' +
                        _makeString(items.length);
  const checksum = _sha256hex(checksumInput).slice(0, 16);

  return {
    metadata: {
      schema_version:     1,
      template_version:   '4.0',
      event_checksum:     checksum,
      processing_time_ms: now,
    },
    event: {
      id:             _eventId,
      name:           td.eventName || '',
      timestamp:      ts,
      transaction_id: _orderId,
    },
    ecommerce: {
      value,
      revenue,
      currency:       _currency,
      tax:            ed('ep.tax',          'tax')          || 0,
      shipping:       ed('ep.shipping',     'shipping')     || 0,
      coupon:         ed('ep.coupon',       'coupon')       || '',
      affiliation:    ed('ep.affiliation',  'affiliation')  || '',
      discount:       ed('ep.discount',     'discount')     || 0,
      content_name:   ed('ep.content_name', 'content_name') || '',
      content_type:   ed('ep.content_type', 'content_type') || 'product',
      num_items:      parseInt(ed('ep.num_items', 'num_items'), 10) || itemsCount || 0,
      search_string:  ed('ep.search_string','search_string') || '',
      items,
      items_count:    itemsCount,
      items_truncated: itemsTruncated,
    },
    attribution: {
      fbclid:       ed('ep.fbclid',    'fbclid')    || '',
      gclid:        ed('ep.gclid',     'gclid')     || '',
      gbraid:       ed('ep.gbraid',    'gbraid')    || '',
      wbraid:       ed('ep.wbraid',    'wbraid')    || '',
      ttclid:       ed('ep.ttclid',    'ttclid')    || '',
      sccid:        ed('ep.ScCid',     'ScCid')     || '',
      msclkid:      ed('ep.msclkid',   'msclkid')   || '',
      li_fat_id:    ed('ep.li_fat_id', 'li_fat_id') || '',
      utm_source:   ed('ep.utm_source',   'utm_source')   || '',
      utm_medium:   ed('ep.utm_medium',   'utm_medium')   || '',
      utm_campaign: ed('ep.utm_campaign', 'utm_campaign') || '',
      utm_content:  ed('ep.utm_content',  'utm_content')  || '',
      utm_term:     ed('ep.utm_term',     'utm_term')     || '',
    },
    identity: {
      anonymous_id: ed('ep.anonymous_id', 'anonymous_id') || '',
      session_id:   ed('ep.session_id',   'session_id')   || '',
      ga_client_id: ed('ep.ga_client_id', 'ga_client_id') || '',
    },
    cookies: {
      fbp:  eventModel['up.fbp']  || ed('ep._fbp',  '_fbp')  || '',
      fbc:  eventModel['up.fbc']  || ed('ep._fbc',  '_fbc')  || '',
      ttp:  eventModel['up.ttp']  || ed('ep._ttp',  '_ttp')  || '',
      scid: eventModel['up.scid'] || ed('ep._scid', '_scid') || '',
      gid:  ed('ep._gid', '_gid') || '',
    },
    device: {
      type:              ed('ep.device_type',       'device_type')       || '',
      language:          ed('ep.language',           'language')          || '',
      timezone:          ed('ep.timezone',           'timezone')          || '',
      viewport:          ed('ep.viewport',           'viewport')          || '',
      screen_resolution: ed('ep.screen_resolution',  'screen_resolution') || '',
    },
    page: {
      url:      ed('ep.page_url',      'page_location') || '',
      referrer: ed('ep.page_referrer', 'page_referrer') || '',
      title:    ed('ep.page_title',    'page_title')    || '',
    },
    consent: {
      ad_storage:         ed('ep.ad_storage',         'ad_storage')         || 'granted',
      analytics_storage:  ed('ep.analytics_storage',  'analytics_storage')  || 'granted',
      ad_user_data:       ed('ep.ad_user_data',       'ad_user_data')       || 'granted',
      ad_personalization: ed('ep.ad_personalization', 'ad_personalization') || 'granted',
    },
    user: {
      email:       _hash(rawEm),
      phone:       _hashPhone(rawPh),
      first_name:  _hash(rawFn),
      last_name:   _hash(rawLn),
      external_id: _hash(rawExt),
      city:        _hash(rawCt),
      state:       _hash(rawSt),
      zip:         _hash(rawZp),
      country:     _hash(rawCo),
    },
    network: {
      client_ip:  td.clientIp  || '',
      user_agent: td.userAgent || '',
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — validateCanonicalEvent
// Exact port of template Section 5.
// ═════════════════════════════════════════════════════════════════════════════

function validateCanonicalEvent(ev) {
  const errors   = [];
  const warnings = [];

  if (!ev.event.name)                              errors.push('MISSING_event_name');
  if (!ev.event.id)                                errors.push('MISSING_event_id');
  if (!ev.event.timestamp || ev.event.timestamp <= 0) errors.push('INVALID_timestamp');

  if (!ev.identity.session_id)   warnings.push('MISSING_session_id');
  if (!ev.identity.anonymous_id) warnings.push('MISSING_anonymous_id');

  if (ev.ecommerce.value !== 0 && ev.ecommerce.value !== '') {
    const numVal = parseFloat(ev.ecommerce.value);
    if (isNaN(numVal)) {
      errors.push('INVALID_value:not_numeric');
    } else if (numVal < 0) {
      warnings.push('SUSPICIOUS_value:negative');
    }
  }

  if (ev.ecommerce.currency &&
      _makeString(ev.ecommerce.currency).trim().length !== 3) {
    warnings.push('INVALID_currency_format');
  }

  for (let i = 0; i < ev.ecommerce.items.length; i++) {
    const it  = ev.ecommerce.items[i];
    if (!it.id && !it.item_id)   errors.push(`ITEM_MISSING_id:i=${i}`);
    const qty = parseInt(it.quantity, 10);
    if (isNaN(qty) || qty < 1)  warnings.push(`ITEM_INVALID_quantity:i=${i}`);
    const prc = parseFloat(it.price);
    if (isNaN(prc) || prc < 0) warnings.push(`ITEM_INVALID_price:i=${i}`);
  }

  if (ev.user.email      && !isHex64(ev.user.email))       warnings.push('PII_NOT_HASHED:email');
  if (ev.user.phone      && !isHex64(ev.user.phone))       warnings.push('PII_NOT_HASHED:phone');
  if (ev.user.first_name && !isHex64(ev.user.first_name))  warnings.push('PII_NOT_HASHED:first_name');
  if (ev.user.last_name  && !isHex64(ev.user.last_name))   warnings.push('PII_NOT_HASHED:last_name');

  if (ev.user.email && ev.user.phone      && ev.user.email === ev.user.phone)      warnings.push('DUPLICATE_HASH:email==phone');
  if (ev.user.email && ev.user.first_name && ev.user.email === ev.user.first_name) warnings.push('DUPLICATE_HASH:email==first_name');
  if (ev.user.email && ev.user.last_name  && ev.user.email === ev.user.last_name)  warnings.push('DUPLICATE_HASH:email==last_name');

  const ckids = [
    { key: 'gclid',   val: ev.attribution.gclid },
    { key: 'fbclid',  val: ev.attribution.fbclid },
    { key: 'ttclid',  val: ev.attribution.ttclid },
    { key: 'msclkid', val: ev.attribution.msclkid },
  ];
  for (const ck of ckids) {
    const len = _makeString(ck.val || '').length;
    if (len > 0 && (len < 10 || len > 500)) {
      warnings.push(`SUSPICIOUS_${ck.key}_length:${len}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Item normalizers (template Section 6 port)
// ═════════════════════════════════════════════════════════════════════════════

function _normItemForPlatform(it) {
  return {
    id:       _makeString(it.id || it.item_id || ''),
    name:     _makeString(it.name || it.item_name || ''),
    price:    parseFloat(it.price) || 0,
    quantity: parseInt(_makeString(it.quantity || '1'), 10) || 1,
    brand:    _makeString(it.brand || it.item_brand || ''),
    category: _makeString(it.category || it.item_category || ''),
    variant:  _makeString(it.variant || it.item_variant || ''),
    coupon:   _makeString(it.coupon || ''),
    discount: parseFloat(it.discount) || 0,
  };
}

function _buildMetaContents(items) {
  return items.map(it => {
    const n = _normItemForPlatform(it);
    const c = { id: n.id, quantity: n.quantity, item_price: n.price };
    if (n.discount) c.discount     = n.discount;
    if (n.brand)    c.brand        = n.brand;
    if (n.category) c.category     = n.category;
    if (n.variant)  c.item_variant = n.variant;
    return c;
  });
}

function _buildTikTokContents(items) {
  return items.map(it => {
    const n = _normItemForPlatform(it);
    const c = { content_id: n.id, content_name: n.name, quantity: n.quantity, price: n.price };
    if (n.brand)    c.brand    = n.brand;
    if (n.category) c.category = n.category;
    return c;
  });
}

function _buildSnapContents(items) {
  return items.map(it => {
    const n = _normItemForPlatform(it);
    const c = { item_id: n.id, item_name: n.name, quantity: n.quantity, price: n.price };
    if (n.brand)    c.brand    = n.brand;
    if (n.category) c.category = n.category;
    return c;
  });
}

function _buildContentIds(items) {
  return items
    .map(it => _makeString(it.id || it.item_id || ''))
    .filter(id => id !== '');
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Platform payload builders (template Section 7 port)
// ═════════════════════════════════════════════════════════════════════════════

function buildMetaPayload(ev, templateData) {
  const td          = templateData || {};
  const hasItems    = ev.ecommerce.items.length > 0;
  const metaItems   = hasItems ? _buildMetaContents(ev.ecommerce.items)  : undefined;
  const metaIds     = hasItems ? _buildContentIds(ev.ecommerce.items)    : undefined;
  const metaNum     = ev.ecommerce.items_count > 0
    ? ev.ecommerce.items_count
    : (ev.ecommerce.items.length || ev.ecommerce.num_items || undefined);

  const customData = _cleanObj({
    currency:      ev.ecommerce.currency,
    value:         ev.ecommerce.value,
    revenue:       ev.ecommerce.revenue      || undefined,
    order_id:      ev.event.transaction_id   || undefined,
    content_type:  ev.ecommerce.content_type,
    content_name:  ev.ecommerce.content_name || undefined,
    num_items:     metaNum,
    tax:           ev.ecommerce.tax          || undefined,
    shipping:      ev.ecommerce.shipping     || undefined,
    coupon:        ev.ecommerce.coupon       || undefined,
    affiliation:   ev.ecommerce.affiliation  || undefined,
    search_string: ev.ecommerce.search_string || undefined,
  });
  if (metaItems) customData.contents    = metaItems;
  if (metaIds)   customData.content_ids = metaIds;

  const userData = _cleanObj({
    em:                ev.user.email        || undefined,
    ph:                ev.user.phone        || undefined,
    fn:                ev.user.first_name   || undefined,
    ln:                ev.user.last_name    || undefined,
    ct:                ev.user.city         || undefined,
    st:                ev.user.state        || undefined,
    zp:                ev.user.zip          || undefined,
    country:           ev.user.country      || undefined,
    external_id:       ev.user.external_id  || undefined,
    fbp:               ev.cookies.fbp       || undefined,
    fbc:               ev.cookies.fbc       || undefined,
    client_ip_address: ev.network.client_ip  || undefined,
    client_user_agent: ev.network.user_agent || undefined,
  });

  return {
    data: [{
      event_name:       ev.event.name,
      event_time:       ev.event.timestamp,
      event_id:         ev.event.id,
      action_source:    'website',
      event_source_url: ev.page.url      || undefined,
      referrer_url:     ev.page.referrer || undefined,
      user_data:        userData,
      custom_data:      customData,
      data_processing_options: [],
    }],
  };
}

function buildTikTokPayload(ev, templateData) {
  const td       = templateData || {};
  const hasItems = ev.ecommerce.items.length > 0;
  const ttItems  = hasItems ? _buildTikTokContents(ev.ecommerce.items) : undefined;

  const props = _cleanObj({
    currency:      ev.ecommerce.currency,
    value:         ev.ecommerce.value,
    content_type:  ev.ecommerce.content_type,
    order_id:      ev.event.transaction_id    || undefined,
    coupon:        ev.ecommerce.coupon        || undefined,
    search_string: ev.ecommerce.search_string || undefined,
    affiliation:   ev.ecommerce.affiliation   || undefined,
    content_name:  (!ttItems && ev.ecommerce.content_name) ? ev.ecommerce.content_name : undefined,
  });
  if (ttItems) props.contents = ttItems;

  const user = _cleanObj({
    email:        ev.user.email        || undefined,
    phone_number: ev.user.phone        || undefined,
    external_id:  ev.user.external_id  || undefined,
    ttclid:       ev.attribution.ttclid || undefined,
    ttp:          ev.cookies.ttp        || undefined,
    ip:           ev.network.client_ip  || undefined,
    user_agent:   ev.network.user_agent || undefined,
  });

  return {
    event_source:    'web',
    event_source_id: td.platformId || '',
    data: [{
      event:      ev.event.name,
      event_time: ev.event.timestamp,
      event_id:   ev.event.id,
      user,
      properties: props,
      page: _cleanObj({
        url:      ev.page.url      || undefined,
        referrer: ev.page.referrer || undefined,
      }),
    }],
  };
}

function buildSnapPayload(ev, templateData) {
  const hasItems  = ev.ecommerce.items.length > 0;
  const snapItems = hasItems ? _buildSnapContents(ev.ecommerce.items)  : undefined;
  const snapIds   = hasItems ? _buildContentIds(ev.ecommerce.items)    : undefined;
  const snapNum   = ev.ecommerce.items_truncated
    ? ev.ecommerce.items_count
    : (ev.ecommerce.items.length || ev.ecommerce.num_items || undefined);

  const customData = _cleanObj({
    currency:        ev.ecommerce.currency,
    price:           ev.ecommerce.value,
    transaction_id:  ev.event.transaction_id   || undefined,
    number_items:    snapNum,
    coupon:          ev.ecommerce.coupon        || undefined,
    affiliation:     ev.ecommerce.affiliation   || undefined,
    shipping_amount: ev.ecommerce.shipping      || undefined,
    tax_amount:      ev.ecommerce.tax           || undefined,
    search_string:   ev.ecommerce.search_string || undefined,
  });
  if (snapIds)   customData.item_ids  = snapIds;
  if (snapItems) customData.products  = snapItems;

  return {
    data: [{
      event_conversion_type: 'WEB',
      event_type:  ev.event.name,
      event_tag:   ev.event.id,
      timestamp:   ev.event.timestamp,
      hashed_data_fields: _cleanObj({
        email:        ev.user.email       || undefined,
        phone_number: ev.user.phone       || undefined,
        external_id:  ev.user.external_id || undefined,
      }),
      user_data: _cleanObj({
        sc_click_id: ev.attribution.sccid  || undefined,
        uuid_c1:     ev.cookies.scid       || undefined,
        ip_address:  ev.network.client_ip  || undefined,
        user_agent:  ev.network.user_agent || undefined,
      }),
      custom_data: customData,
      app_data: {
        advertiser_tracking_enabled: ev.consent.ad_storage === 'granted' ? 1 : 0,
      },
    }],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — dispatch (full pipeline)
// ═════════════════════════════════════════════════════════════════════════════

function dispatch(eventModel, templateData) {
  const canonical  = buildCanonicalEvent(eventModel, templateData);
  const validation = validateCanonicalEvent(canonical);
  return {
    canonical,
    validation,
    payloads: {
      meta:   buildMetaPayload(canonical,   templateData),
      tiktok: buildTikTokPayload(canonical, templateData),
      snap:   buildSnapPayload(canonical,   templateData),
    },
  };
}

module.exports = {
  createEventModel,
  buildCanonicalEvent,
  validateCanonicalEvent,
  buildMetaPayload,
  buildTikTokPayload,
  buildSnapPayload,
  dispatch,
  _hash,
  _hashPhone,
  _normItemForPlatform,
  _buildContentIds,
  isHex64,
};
