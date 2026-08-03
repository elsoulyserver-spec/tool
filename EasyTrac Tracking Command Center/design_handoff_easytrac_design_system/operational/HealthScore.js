/**
 * HealthScore — Operational component
 * ---------------------------------------------------------------
 * API: createHealthScore({value, label, state, lastVerified})
 * Variants: account-scope, store-scope (via container context, not a prop)
 * States: all 5 visual classes via state prop
 * Accessibility: Ring color never the only signal — label text always renders beside it
 * Keyboard: Not interactive (read-only); wrap in a link/button at call site if clickable
 * RTL: Ring + label order flips (flex-direction reverses)
 * Responsive: Ring shrinks to 48px on mobile
 * Token dependencies: --healthscore-*, --status-*
 * Spec reference: Design System §2, §11
 * ---------------------------------------------------------------
 */
import { statusClass, statusColors } from './statusMap.js';
export function createHealthScore({ value, label, state = 'Healthy', lastVerified }) {
  const c = statusColors(statusClass(state));
  const el = document.createElement('div'); el.className = 'et-healthscore';
  el.innerHTML = `
    <div class="et-healthscore__ring" style="border-color:${c.fg}">${value}</div>
    <div>
      <div style="font-weight:600;">${label}</div>
      <div style="font-size:11.5px;color:var(--healthscore-meta-fg);margin-top:2px;">${lastVerified}</div>
    </div>`;
  return el;
}
