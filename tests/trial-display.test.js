'use strict';

// Tests for the display-only trial computation (frontend/lib/trial-display.js).
// The SAME module the TrialBanner imports. Run:
//   node --test tests/trial-display.test.js

const test   = require('node:test');
const assert = require('node:assert');

const { computeTrialDisplay } = require('../frontend/lib/trial-display');

const DAY = 24 * 60 * 60 * 1000;
const LAUNCH = '2026-07-14T00:00:00Z';
const LAUNCH_MS = Date.parse(LAUNCH);
const iso = (ms) => new Date(ms).toISOString();

test('paidAt present → Paid, never trial/expired (even past the window)', () => {
  const d = computeTrialDisplay(
    { createdAt: iso(LAUNCH_MS - 30 * DAY), paidAt: iso(LAUNCH_MS) },
    LAUNCH, LAUNCH_MS + 100 * DAY,
  );
  assert.strictEqual(d.state, 'paid');
});

test('FAIL OPEN: missing launch date → unavailable (never expired)', () => {
  const d = computeTrialDisplay({ createdAt: iso(LAUNCH_MS - 30 * DAY), paidAt: null }, null, LAUNCH_MS + 100 * DAY);
  assert.strictEqual(d.state, 'unavailable');
});

test('FAIL OPEN: invalid launch date → unavailable', () => {
  const d = computeTrialDisplay({ createdAt: iso(LAUNCH_MS), paidAt: null }, 'not-a-date', LAUNCH_MS + 100 * DAY);
  assert.strictEqual(d.state, 'unavailable');
});

test('FAIL OPEN: missing createdAt → unavailable', () => {
  const d = computeTrialDisplay({ createdAt: null, paidAt: null }, LAUNCH, LAUNCH_MS);
  assert.strictEqual(d.state, 'unavailable');
});

test('new customer (createdAt ≥ launch) → 7 days from createdAt', () => {
  const created = LAUNCH_MS + 2 * DAY;
  const d = computeTrialDisplay({ createdAt: iso(created), paidAt: null }, LAUNCH, created + 1 * DAY);
  assert.strictEqual(d.state, 'trial');
  assert.strictEqual(d.daysRemaining, 6); // 7 - 1
});

test('existing customer (createdAt < launch) → 7 days from LAUNCH, not signup', () => {
  const created = LAUNCH_MS - 300 * DAY; // old account
  const d = computeTrialDisplay({ createdAt: iso(created), paidAt: null }, LAUNCH, LAUNCH_MS + 1 * DAY);
  assert.strictEqual(d.state, 'trial');       // NOT immediately expired
  assert.strictEqual(d.daysRemaining, 6);
});

test('past trialEnd, unpaid → expired', () => {
  const created = LAUNCH_MS;
  const d = computeTrialDisplay({ createdAt: iso(created), paidAt: null }, LAUNCH, created + 8 * DAY);
  assert.strictEqual(d.state, 'expired');
});

test('exactly at trialEnd → expired (now < end is false)', () => {
  const created = LAUNCH_MS;
  const d = computeTrialDisplay({ createdAt: iso(created), paidAt: null }, LAUNCH, created + 7 * DAY);
  assert.strictEqual(d.state, 'expired');
});

test('one day left → daysRemaining 1', () => {
  const created = LAUNCH_MS;
  const d = computeTrialDisplay({ createdAt: iso(created), paidAt: null }, LAUNCH, created + 6 * DAY);
  assert.strictEqual(d.daysRemaining, 1);
});
