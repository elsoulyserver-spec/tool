'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// TRIAL SERVICE — server-owned 7-day free-trial derivation.
//
// The client `clients/{uid}` document is created client-side at signup (a direct
// Firestore write in tool.html) with a server-stamped `created_at`. There is no
// backend creation hook, so the trial is DERIVED from that server timestamp and
// never trusted from any frontend-supplied date. Trial fields are lazily
// persisted once (see firestore-service.ensureTrialFields) purely as a backfill;
// the source of truth is always this pure computation.
//
// This module is intentionally dependency-free and pure so it can be unit-tested
// without Firebase.
// ══════════════════════════════════════════════════════════════════════════════

const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// Normalize the many timestamp shapes we may receive (Firestore Timestamp with
// toDate(), Date, ISO string, epoch ms) into a Date, or null if unparseable.
function _toDate(ts) {
  if (ts == null) return null;
  if (typeof ts.toDate === 'function') {
    try { return ts.toDate(); } catch (_) { return null; }
  }
  if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
  if (typeof ts === 'number') {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof ts === 'string') {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Derive the effective trial state for a client record.
//
// Returns Date objects for the two timestamps (callers convert to ISO / Firestore
// values as needed). Never mutates its input and never reads a frontend-supplied
// date: the start is always the server-set creation time (or a previously
// persisted, server-owned trialStartedAt).
function computeTrial(client, now = new Date(), opts = {}) {
  client = client || {};

  // Anchor the trial to a TRUSTED, server-owned timestamp only:
  //   • created_at  — stamped server-side at signup (the normal case), or
  //   • trialAnchoredAt — a server timestamp we backfill when created_at is
  //     absent (see firestore-service.ensureTrialFields).
  // A client-writable trialStartedAt / trialEndsAt is NEVER used as an anchor,
  // so tampering with those doc fields cannot extend a trial. trialEndsAt is
  // always derived; trialStartedAt in the doc is a display cache only.
  const created = _toDate(client.createdAt) || _toDate(client.created_at);

  // Existing-client safety: TRIAL_LAUNCH_AT clamps the trial START so accounts
  // that predate the trial launch are NOT retroactively expired. New accounts
  // (created on/after launch) simply anchor to created_at. created_at is
  // preserved either way — only the trial *window* start is clamped forward.
  const launchRaw = opts.trialLaunchAt !== undefined ? opts.trialLaunchAt : process.env.TRIAL_LAUNCH_AT;
  const launch = _toDate(launchRaw);

  // Server-stamped fallback anchor (only trusted when not in the future).
  const anchored = _toDate(client.trialAnchoredAt);
  const anchoredTrusted = anchored && anchored.getTime() <= now.getTime() ? anchored : null;

  const clamp = (d) => (launch && launch.getTime() > d.getTime()) ? launch : d;

  let start = null;
  if (created) {
    start = clamp(created);
  } else if (anchoredTrusted) {
    start = clamp(anchoredTrusted);
  }

  const paid = client.paymentStatus === 'paid' || client.paidAt != null;
  const paymentStatus = paid ? 'paid' : 'unpaid';

  let trialStatus;
  let end = null;
  if (paid) {
    trialStatus = 'converted';
    if (start) end = new Date(start.getTime() + TRIAL_DAYS * DAY_MS);
  } else if (!start) {
    // No trusted anchor at all → explicit UNKNOWN. We never grant an unbounded
    // "active" trial; callers backfill a trusted server timestamp (see
    // firestore-service.ensureTrialFields) so the next read is bounded.
    trialStatus = 'unknown';
  } else {
    end = new Date(start.getTime() + TRIAL_DAYS * DAY_MS);
    trialStatus = now.getTime() < end.getTime() ? 'active' : 'expired';
  }

  let trialDaysRemaining = 0;
  if (trialStatus === 'active' && end) {
    trialDaysRemaining = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));
  }

  const containerStatus = client.containerStatus || 'active';

  return {
    trialStartedAt: start,
    trialEndsAt: end,
    paymentStatus,
    trialStatus,
    trialDaysRemaining,
    containerStatus,
  };
}

module.exports = { computeTrial, TRIAL_DAYS, DAY_MS, _toDate };
