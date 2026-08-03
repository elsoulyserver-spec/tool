/**
 * DestinationRow — Operational component
 * ---------------------------------------------------------------
 * API: createDestinationRow({name, state, metric, actionLabel, onAction})
 * Variants: default
 * States: all 14 states via StatusChip
 * Accessibility: Action text states the specific action, never "Fix"
 * Keyboard: Tab + Enter/Space on action
 * RTL: Chip/name/action order flips
 * Responsive: Becomes stacked card on mobile (Screen Spec §3)
 * Token dependencies: --surface-1, --status-*
 * Spec reference: Screen Spec §3
 * ---------------------------------------------------------------
 */
import { createStatusChip } from './StatusChip.js';
export function createDestinationRow({ name, state, metric, onAction, actionLabel }) {
  const el = document.createElement('div'); el.style.cssText = 'display:flex;justify-content:space-between;align-items:center;background:var(--surface-1);border:1px solid var(--border-subtle);border-radius:8px;padding:12px 14px;';
  const left = document.createElement('div'); left.style.cssText = 'display:flex;align-items:center;gap:10px;';
  left.append(createStatusChip(state), document.createTextNode(name + (metric ? ' — ' + metric : '')));
  const btn = document.createElement('button'); btn.style.cssText = 'background:none;border:none;color:var(--brand);font-size:12.5px;cursor:pointer;'; btn.textContent = actionLabel;
  btn.addEventListener('click', onAction);
  el.append(left, btn);
  return el;
}
