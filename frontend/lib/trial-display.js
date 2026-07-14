'use strict';

// Pure, DISPLAY-ONLY trial computation. No enforcement, no side effects, no I/O.
// Written as a plain CommonJS module so the exact same logic is both imported by
// the TrialBanner component and unit-tested by the repo's Node test runner.
//
// Rules (approved):
//   paidAt present            -> 'paid'   (never show trial/expired)
//   missing/invalid launch    -> 'unavailable' (FAIL OPEN — never 'expired')
//   or missing/invalid created
//   now < trialEnd            -> 'trial'  (daysRemaining)
//   else                      -> 'expired'
// where effectiveTrialStart = max(createdAt, TRIAL_LAUNCH_AT), trialEnd = +7d.

var TRIAL_DAYS = 7;
var DAY_MS = 24 * 60 * 60 * 1000;

function _ms(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string') { var t = Date.parse(v); return isNaN(t) ? null : t; }
  if (typeof v === 'object') {
    if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (e) { return null; } }
    if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (e) { return null; } }
    if (v instanceof Date) return isFinite(v.getTime()) ? v.getTime() : null;
    if (v._seconds !== undefined) return v._seconds * 1000;
    if (v.seconds !== undefined) return v.seconds * 1000;
  }
  return null;
}

function computeTrialDisplay(client, trialLaunchAt, now) {
  now = typeof now === 'number' ? now : Date.now();
  var c = client || {};

  // Paid is the source of truth — paid customers never see trial/expired.
  if (_ms(c.paidAt) != null) {
    return { state: 'paid', daysRemaining: null, label: 'Paid' };
  }

  var createdMs = _ms(c.createdAt);
  var launchMs = _ms(trialLaunchAt);

  // FAIL OPEN: without a valid launch date or created date we never claim the
  // trial is expired — show a neutral state instead of applying a wrong date.
  if (launchMs == null || createdMs == null) {
    return { state: 'unavailable', daysRemaining: null, label: 'Trial status unavailable' };
  }

  var effectiveStart = Math.max(createdMs, launchMs);
  var trialEnd = effectiveStart + TRIAL_DAYS * DAY_MS;

  if (now < trialEnd) {
    var daysRemaining = Math.ceil((trialEnd - now) / DAY_MS);
    return {
      state: 'trial',
      daysRemaining: daysRemaining,
      label: daysRemaining + ' day' + (daysRemaining === 1 ? '' : 's') + ' left in your free trial',
    };
  }

  return { state: 'expired', daysRemaining: 0, label: 'Trial expired · Not paid' };
}

module.exports = { computeTrialDisplay: computeTrialDisplay, TRIAL_DAYS: TRIAL_DAYS };
