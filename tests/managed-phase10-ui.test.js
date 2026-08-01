// tests/managed-phase10-ui.test.js
// Focused structural tests for Phase 10 dashboard/tool.html integration.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'tool.html'), 'utf8');

function sectionBetween(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = html.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return html.slice(start, end);
}

test('Phase 10 adds Managed sGTM sidebar navigation and app view', () => {
  assert.match(html, /id="sbManagedServer"/);
  assert.match(html, /switchAppView\('managedserver',this\)/);
  assert.match(html, /id="view-managedserver"/);
  assert.match(html, /Managed sGTM/);
  assert.match(html, /managedserver: 'view-managedserver'/);
});

test('Phase 10 UI is driven by backend managed APIs', () => {
  assert.match(html, /fetch\('\/api\/managed\/server'/);
  assert.match(html, /fetch\('\/api\/managed\/create-server'/);
  assert.match(html, /fetch\('\/api\/managed\/job\/' \+ encodeURIComponent\(jobId\)/);
  assert.match(html, /Authorization': 'Bearer ' \+ tok/);
});

test('Phase 10 Managed sGTM view exposes only public customer fields', () => {
  const view = sectionBetween('id="view-managedserver"', '<!-- END MANAGED SGTM VIEW -->');
  assert.match(view, /msPublicUrl/);
  assert.match(view, /msPreviewUrl/);
  assert.match(view, /msGtmPublicId/);
  assert.doesNotMatch(view, /containerConfig/);
  assert.doesNotMatch(view, /CONTAINER_CONFIG/);
  assert.doesNotMatch(view, /taggingRunUrl/);
  assert.doesNotMatch(view, /previewRunUrl/);
  assert.doesNotMatch(view, /run\.app/);
});

test('Phase 10 code does not modify provisioning, Cloud Run, or GTM logic', () => {
  assert.doesNotMatch(html, /deployPreview\(/);
  assert.doesNotMatch(html, /deployTagging\(/);
  assert.doesNotMatch(html, /provisionServerOnly/);
  assert.doesNotMatch(html, /createManagedServerJobTx/);
});
