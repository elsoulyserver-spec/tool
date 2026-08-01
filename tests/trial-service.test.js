// tests/trial-service.test.js
// Verifies the server-owned 7-day trial derivation (lib/trial-service.js).
//
// Run: node --test tests/trial-service.test.js

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { computeTrial, TRIAL_DAYS, DAY_MS } = require('../lib/trial-service');

// Keep env-driven launch clamp out of the default cases; launch behavior is
// exercised explicitly via the opts argument below.
delete process.env.TRIAL_LAUNCH_AT;

test('new client gets exactly a 7-day trial, active and unpaid', () => {
  const now     = new Date('2026-03-10T00:00:00Z');
  const created = new Date('2026-03-10T00:00:00Z');
  const t = computeTrial({ created_at: created }, now);

  assert.equal(t.paymentStatus, 'unpaid');
  assert.equal(t.trialStatus, 'active');
  assert.equal(t.containerStatus, 'active');
  // Exactly 7 days between start and end.
  assert.equal(t.trialEndsAt.getTime() - t.trialStartedAt.getTime(), TRIAL_DAYS * DAY_MS);
  assert.equal(t.trialDaysRemaining, 7);
});

test('trial start is anchored to created_at (createdAt camelCase also works)', () => {
  const now     = new Date('2026-03-12T00:00:00Z');
  const created = new Date('2026-03-10T00:00:00Z');
  const t = computeTrial({ createdAt: created }, now);
  assert.equal(t.trialStartedAt.getTime(), created.getTime());
  assert.equal(t.trialDaysRemaining, 5);
});

test('client CANNOT overwrite trial dates via doc fields', () => {
  const now     = new Date('2026-03-11T00:00:00Z');
  const created = new Date('2026-03-10T00:00:00Z');
  // Attacker-supplied trialStartedAt / trialEndsAt far in the future are ignored.
  const t = computeTrial({
    created_at: created,
    trialStartedAt: new Date('2030-01-01T00:00:00Z'),
    trialEndsAt: new Date('2030-01-08T00:00:00Z'),
  }, now);
  assert.equal(t.trialStartedAt.getTime(), created.getTime());
  assert.equal(t.trialEndsAt.getTime(), created.getTime() + TRIAL_DAYS * DAY_MS);
  assert.equal(t.trialStatus, 'active'); // still within the real 7-day window
});

test('expired unpaid trial is reported as expired with 0 days remaining', () => {
  const now     = new Date('2026-03-20T00:00:00Z');
  const created = new Date('2026-03-10T00:00:00Z'); // 10 days ago → past the 7-day window
  const t = computeTrial({ created_at: created }, now);
  assert.equal(t.paymentStatus, 'unpaid');
  assert.equal(t.trialStatus, 'expired');
  assert.equal(t.trialDaysRemaining, 0);
});

test('paid client is reported as converted regardless of dates (paidAt)', () => {
  const now     = new Date('2026-03-20T00:00:00Z');
  const created = new Date('2026-03-10T00:00:00Z'); // would be expired if unpaid
  const t = computeTrial({ created_at: created, paidAt: new Date('2026-03-15T00:00:00Z') }, now);
  assert.equal(t.paymentStatus, 'paid');
  assert.equal(t.trialStatus, 'converted');
  assert.equal(t.trialDaysRemaining, 0);
});

test('paymentStatus="paid" alone also converts (even before expiry)', () => {
  const now     = new Date('2026-03-11T00:00:00Z');
  const created = new Date('2026-03-10T00:00:00Z');
  const t = computeTrial({ created_at: created, paymentStatus: 'paid' }, now);
  assert.equal(t.paymentStatus, 'paid');
  assert.equal(t.trialStatus, 'converted');
});

test('containerStatus passes through and defaults to active', () => {
  const created = new Date('2026-03-10T00:00:00Z');
  assert.equal(computeTrial({ created_at: created }).containerStatus, 'active');
  assert.equal(computeTrial({ created_at: created, containerStatus: 'deleted' }).containerStatus, 'deleted');
});

test('missing created_at → explicit unknown (never an unbounded active trial)', () => {
  const t = computeTrial({}, new Date('2026-03-20T00:00:00Z'));
  assert.equal(t.trialStatus, 'unknown');
  assert.equal(t.trialStartedAt, null);
  assert.equal(t.trialEndsAt, null);
  assert.equal(t.trialDaysRemaining, 0);
});

test('legacy doc with a trusted (past) server trialAnchoredAt is bounded, not unknown', () => {
  const now = new Date('2026-03-20T00:00:00Z');
  const t = computeTrial({ trialAnchoredAt: new Date('2026-03-18T00:00:00Z') }, now);
  assert.equal(t.trialStatus, 'active');
  assert.equal(t.trialDaysRemaining, 5);
});

test('client-written trialStartedAt/trialEndsAt are NEVER trusted as anchors', () => {
  const now = new Date('2026-03-20T00:00:00Z');
  // Only a client-writable trialStartedAt present (no created_at, no anchor) →
  // it is ignored entirely → unknown (cannot be used to fabricate a trial).
  const t = computeTrial({
    trialStartedAt: new Date('2026-03-19T00:00:00Z'),
    trialEndsAt: new Date('2030-01-01T00:00:00Z'),
  }, now);
  assert.equal(t.trialStatus, 'unknown');
});

test('a FUTURE trialAnchoredAt (only possible via tampering) is rejected → unknown', () => {
  const now = new Date('2026-03-20T00:00:00Z');
  const t = computeTrial({ trialAnchoredAt: new Date('2027-01-01T00:00:00Z') }, now);
  assert.equal(t.trialStatus, 'unknown');
});

test('TRIAL_LAUNCH_AT clamps existing clients forward (not retroactively expired)', () => {
  const now     = new Date('2026-07-31T00:00:00Z');
  const created = new Date('2026-01-01T00:00:00Z'); // pre-launch, long ago
  const launch  = '2026-07-29T00:00:00Z';
  const t = computeTrial({ created_at: created }, now, { trialLaunchAt: launch });
  // Trial starts at launch, not created_at → still active on day 2, not expired.
  assert.equal(t.trialStartedAt.toISOString(), new Date(launch).toISOString());
  assert.equal(t.trialStatus, 'active');
  assert.equal(t.trialDaysRemaining, 5);
});

test('TRIAL_LAUNCH_AT does NOT shorten new clients created after launch', () => {
  const now     = new Date('2026-07-31T00:00:00Z');
  const created = new Date('2026-07-30T00:00:00Z'); // after launch
  const launch  = '2026-07-29T00:00:00Z';
  const t = computeTrial({ created_at: created }, now, { trialLaunchAt: launch });
  assert.equal(t.trialStartedAt.toISOString(), created.toISOString());
});

test('Firestore Timestamp-like objects (toDate) are supported', () => {
  const created = new Date('2026-03-10T00:00:00Z');
  const tsLike  = { toDate: () => created };
  const t = computeTrial({ created_at: tsLike }, new Date('2026-03-12T00:00:00Z'));
  assert.equal(t.trialStartedAt.getTime(), created.getTime());
  assert.equal(t.trialDaysRemaining, 5);
});
