'use strict';

/**
 * gtm-config-builder.dedup.test.js
 *
 * "GTM import compatibility" regression tests for lib/gtm-config-builder.js.
 * These don't call the live GTM API — that requires managed-account
 * credentials this test suite doesn't have — but they exercise the exact
 * structural rule GTM's Import Container validator enforces before it will
 * ever accept a file: every variable, tag, and trigger name must be unique,
 * and every {{Name}}/triggerId reference must resolve. That's what
 * validateContainer() checks, so a container that passes it here is a
 * container GTM will actually import.
 *
 * Run: node --test tests/gtm-config-builder.dedup.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildWebConfig, buildServerConfig } = require('../lib/gtm-config-builder');
const { validateContainer } = require('../lib/gtm-entity-registry');

const ALL_EVENTS = [
  'page_view', 'view_content', 'add_to_cart', 'initiate_checkout',
  'purchase', 'lead', 'sign_up', 'search', 'contact',
];

const ALL_PIXEL_IDS = {
  meta: '111111111111111',
  gads: 'AW-222222222',
  gads_label: 'AbC-DefG1234',
  snap: 'snap-pixel-id',
  tiktok: 'tiktok-pixel-id',
};

const ALL_CAPI_TOKENS = {
  meta: 'META_TOKEN',
  tiktok: 'TIKTOK_TOKEN',
  snap: 'SNAP_TOKEN',
};

function assertNoDuplicateNames(container, label) {
  const result = validateContainer(container);
  const dupErrors = result.errors.filter(e => e.startsWith('duplicate '));
  assert.deepEqual(dupErrors, [], `${label}: expected no duplicate-name errors, got: ${dupErrors.join('; ')}`);
}

function assertNoBrokenReferences(container, label) {
  const result = validateContainer(container);
  const refErrors = result.errors.filter(e => e.includes('unknown firingTriggerId') || e.includes('unknown blockingTriggerId'));
  assert.deepEqual(refErrors, [], `${label}: expected no dangling trigger references, got: ${refErrors.join('; ')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Web container — every platform combination that ships in production
// ─────────────────────────────────────────────────────────────────────────────

describe('buildWebConfig — no duplicate macro names across platform combinations', () => {
  const combos = [
    { label: 'GA4 only', pixelIds: {} },
    { label: 'GA4 + Google Ads', pixelIds: { gads: ALL_PIXEL_IDS.gads, gads_label: ALL_PIXEL_IDS.gads_label } },
    { label: 'GA4 + Meta', pixelIds: { meta: ALL_PIXEL_IDS.meta } },
    { label: 'GA4 + TikTok', pixelIds: { tiktok: ALL_PIXEL_IDS.tiktok } },
    { label: 'GA4 + Snapchat', pixelIds: { snap: ALL_PIXEL_IDS.snap } },
    { label: 'Google Ads + GA4 + Meta + TikTok + Snapchat (all platforms)', pixelIds: ALL_PIXEL_IDS },
  ];

  combos.forEach(({ label, pixelIds }) => {
    test(label, () => {
      const container = buildWebConfig({
        ga4MeasurementId: 'G-TESTID1234',
        sgtmUrl: 'https://sgtm.example.com',
        pixelIds,
        events: ALL_EVENTS,
        customEvents: ['custom_signup_step_2', 'custom_wishlist_add'],
        ecommPlatform: 'salla',
      });

      assert.equal(container._meta.validation.valid, true, JSON.stringify(container._meta.validation.errors));
      assertNoDuplicateNames(container, label);
      assertNoBrokenReferences(container, label);
    });
  });

  test('ecommPlatform variants (salla / zid / none) never collide on DL - * names', () => {
    ['salla', 'zid', ''].forEach(ecommPlatform => {
      const container = buildWebConfig({
        ga4MeasurementId: 'G-TESTID1234',
        pixelIds: ALL_PIXEL_IDS,
        events: ALL_EVENTS,
        ecommPlatform,
      });
      assertNoDuplicateNames(container, `ecommPlatform=${ecommPlatform || 'none'}`);
    });
  });

  test('repeated / overlapping customEvents do not produce duplicate triggers or tags', () => {
    const container = buildWebConfig({
      ga4MeasurementId: 'G-TESTID1234',
      pixelIds: {},
      events: ['purchase'],
      // 'purchase' is already a standard event; also list custom events with
      // accidental repeats — the builder must not emit two triggers/tags
      // with the same name for any of these.
      customEvents: ['newsletter_signup', 'newsletter_signup', 'purchase'],
    });
    assertNoDuplicateNames(container, 'overlapping customEvents');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server (sGTM) container — every platform combination
// ─────────────────────────────────────────────────────────────────────────────

describe('buildServerConfig — no duplicate macro names across platform combinations', () => {
  const combos = [
    { label: 'no platforms (relay only)', platforms: [] },
    { label: 'Meta only', platforms: ['meta'] },
    { label: 'TikTok only', platforms: ['tiktok'] },
    { label: 'Snapchat only', platforms: ['snap'] },
    { label: 'Meta + TikTok + Snapchat (all CAPI platforms)', platforms: ['meta', 'tiktok', 'snap'] },
  ];

  combos.forEach(({ label, platforms }) => {
    test(label, () => {
      const container = buildServerConfig({
        ga4MeasurementId: 'G-TESTID1234',
        sgtmUrl: 'https://sgtm.example.com',
        platforms,
        events: ALL_EVENTS,
        customEvents: ['custom_signup_step_2'],
        pixelIds: ALL_PIXEL_IDS,
        capiTokens: ALL_CAPI_TOKENS,
        beaconUrl: 'https://beacon.example.com',
        beaconApiKey: 'beacon-key',
        etClientId: 'client-123',
      });

      assert.equal(container._meta.validation.valid, true, JSON.stringify(container._meta.validation.errors));
      assertNoDuplicateNames(container, label);
      assertNoBrokenReferences(container, label);
    });
  });

  test('beacon disabled (missing one of url/key/clientId) does not leave dangling refs', () => {
    const container = buildServerConfig({
      ga4MeasurementId: 'G-TESTID1234',
      platforms: ['meta'],
      events: ALL_EVENTS,
      pixelIds: { meta: ALL_PIXEL_IDS.meta },
      capiTokens: { meta: ALL_CAPI_TOKENS.meta },
      beaconUrl: '', beaconApiKey: '', etClientId: '',
    });
    assertNoDuplicateNames(container, 'beacon disabled');
    assertNoBrokenReferences(container, 'beacon disabled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics block shape (verbose export diagnostics)
// ─────────────────────────────────────────────────────────────────────────────

describe('_meta.validation diagnostics block', () => {
  test('buildWebConfig attaches a verbose validation summary', () => {
    const container = buildWebConfig({
      ga4MeasurementId: 'G-TESTID1234',
      pixelIds: ALL_PIXEL_IDS,
      events: ALL_EVENTS,
    });
    const v = container._meta.validation;
    assert.equal(typeof v.duplicatesRemoved, 'number');
    assert.equal(typeof v.variablesCreated, 'number');
    assert.equal(typeof v.tagsCreated, 'number');
    assert.equal(typeof v.triggersCreated, 'number');
    assert.ok(Array.isArray(v.warnings));
    assert.ok(Array.isArray(v.errors));
    assert.equal(v.duplicatesRemoved, 0); // the generator itself is already duplicate-free
  });

  test('buildServerConfig attaches a verbose validation summary', () => {
    const container = buildServerConfig({
      ga4MeasurementId: 'G-TESTID1234',
      platforms: ['meta', 'tiktok', 'snap'],
      events: ALL_EVENTS,
      pixelIds: ALL_PIXEL_IDS,
      capiTokens: ALL_CAPI_TOKENS,
    });
    const v = container._meta.validation;
    assert.equal(v.duplicatesRemoved, 0);
    assert.ok(v.variablesCreated > 0);
    assert.ok(v.tagsCreated > 0);
    assert.ok(v.triggersCreated > 0);
  });
});
