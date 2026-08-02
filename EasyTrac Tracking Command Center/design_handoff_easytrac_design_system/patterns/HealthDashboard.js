/**
 * HealthDashboard — Pattern (composition)
 * ---------------------------------------------------------------
 * API: createHealthDashboard({score, topIssue, destinations, trendPoints})
 * Variants: Dashboard (account scope), Store Overview (store scope) — same pattern, different data scope
 * States: topIssue omitted entirely when Healthy (Design System §11 — StatusBanner never renders for Healthy)
 * Accessibility: Score-first DOM order matches visual and reading order
 * Keyboard: Top-issue action and destination chips Tab-reachable in visual order
 * RTL: inherits HealthScore/StatusBanner/StatusChip
 * Responsive: Trend sparkline hidden below 768px per Screen Spec §1
 * Token dependencies: inherits HealthScore + StatusBanner + StatusChip + Sparkline tokens
 * Spec reference: Screen Spec §1, §11; Design System §6
 * ---------------------------------------------------------------
 */
import { createHealthScore } from '../operational/HealthScore.js';
import { createStatusBanner } from '../operational/StatusBanner.js';
import { createStatusChip } from '../operational/StatusChip.js';
import { createSparkline } from '../charts/Sparkline.js';

/** The Dashboard/Store-Overview composition: score → top issue → destination chips → trend (Screen Spec §1, §11). */
export function createHealthDashboard({ score, topIssue, destinations, trendPoints }) {
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:16px;';
  wrap.appendChild(createHealthScore(score));
  if (topIssue) wrap.appendChild(createStatusBanner(topIssue));
  const chips = document.createElement('div'); chips.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  destinations.forEach(d => chips.appendChild(createStatusChip(d.state)));
  wrap.appendChild(chips);
  wrap.appendChild(createSparkline(trendPoints));
  return wrap;
}
