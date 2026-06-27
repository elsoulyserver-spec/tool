'use strict';

const SEVEN_DAYS_MS  = 7  * 24 * 60 * 60 * 1000;
const FOURTEEN_D_MS  = 14 * 24 * 60 * 60 * 1000;
const TWENTY_FOUR_MS = 24 * 60 * 60 * 1000;

function _ms(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  return null;
}

function _ruleContainerActive({ containers }) {
  const hasActive = (containers || []).some(c => c.status === 'active');
  return hasActive
    ? { status: 'ok',       message: 'At least one active container found' }
    : { status: 'critical', message: 'No active tracking container' };
}

function _ruleServerUrl({ ssConfig }) {
  return (ssConfig && String(ssConfig.serverUrl || '').trim())
    ? { status: 'ok',       message: 'Server URL is configured' }
    : { status: 'critical', message: 'Server URL not configured' };
}

function _ruleBeacon7d({ client, eventsSeen }) {
  const now     = Date.now();
  const seenMs  = (eventsSeen || []).map(e => _ms(e.lastSeenAt)).filter(Boolean);
  const recent  = seenMs.length ? Math.max(...seenMs) : null;

  if (recent && (now - recent) < SEVEN_DAYS_MS) {
    return { status: 'ok', message: 'Beacon received within the last 7 days' };
  }

  const createdMs  = _ms(client.createdAt);
  const accountAge = createdMs ? now - createdMs : 0;
  return accountAge < FOURTEEN_D_MS
    ? { status: 'warning',  message: 'No beacon received yet — account is within onboarding window' }
    : { status: 'critical', message: 'No beacon received in the last 7 days' };
}

function _rulePurchase24h({ ssConfig, eventsSeen }) {
  if (!ssConfig) return { status: 'skip', message: 'No server-side config' };
  const platforms = ssConfig.platforms || [];
  if (!platforms.some(p => p === 'meta' || p === 'tiktok')) {
    return { status: 'skip', message: 'No Meta/TikTok CAPI configured' };
  }
  if (!(ssConfig.ga4Events || []).includes('purchase')) {
    return { status: 'skip', message: 'Purchase event not enabled in config' };
  }
  const seen  = (eventsSeen || []).find(e => e.eventName === 'purchase');
  const seenMs = seen ? _ms(seen.lastSeenAt) : null;
  return (seenMs && Date.now() - seenMs < TWENTY_FOUR_MS)
    ? { status: 'ok',      message: 'Purchase event seen in the last 24 hours' }
    : { status: 'warning', message: 'Purchase event not seen in the last 24 hours' };
}

function _rulePlatformDegraded({ ssConfig, platformHealth }) {
  if (!ssConfig) return { status: 'skip', message: 'No server-side config' };
  const platforms = ssConfig.platforms || [];
  if (!platforms.length) return { status: 'skip', message: 'No platforms configured' };
  const ph       = platformHealth || {};
  const degraded = platforms.filter(p => ph[p] && ph[p].status && ph[p].status !== 'operational');
  return degraded.length
    ? { status: 'warning', message: degraded.map(p => p + ' is currently degraded').join('; ') }
    : { status: 'ok',      message: 'All configured platforms are operational' };
}

function _ruleContainerPublished({ containers }) {
  const active = (containers || []).filter(c => c.status === 'active');
  if (!active.length) return { status: 'skip', message: 'No active containers to check' };
  const unpublished = active.filter(c => !c.publishedVersion || c.publishedVersion === 0);
  return unpublished.length
    ? { status: 'warning', message: 'Active container not yet published to live' }
    : { status: 'ok',      message: 'Container is published' };
}

function _deriveOverall(rules, client) {
  if ((client.status || '') === 'paused') return 'paused';
  if (rules.container_active.status === 'critical' &&
      rules.server_url_configured.status === 'critical') return 'onboarding';
  if (rules.beacon_received_7d.status === 'critical') return 'data_stale';
  const nonSkip = Object.values(rules).filter(r => r.status !== 'skip');
  if (nonSkip.some(r => r.status === 'critical')) return 'critical';
  if (nonSkip.some(r => r.status === 'warning'))  return 'warning';
  return 'healthy';
}

function evaluate(input) {
  const rules = {
    container_active:      _ruleContainerActive(input),
    server_url_configured: _ruleServerUrl(input),
    beacon_received_7d:    _ruleBeacon7d(input),
    purchase_24h:          _rulePurchase24h(input),
    platform_degraded:     _rulePlatformDegraded(input),
    container_published:   _ruleContainerPublished(input),
  };
  return { rules, overallStatus: _deriveOverall(rules, input.client) };
}

module.exports = { evaluate };
