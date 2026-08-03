/**
 * StatusBanner — Operational component
 * ---------------------------------------------------------------
 * API: createStatusBanner({title, detail, state, actionLabel, onAction})
 * Variants: with/without action
 * States: renders for Caution/Critical/Blocked states; never for Healthy per Screen Spec §6
 * Accessibility: aria-live=polite region at mount site for dynamic banners
 * Keyboard: Action button Tab-reachable
 * RTL: Text and button order flips
 * Responsive: Stacks title/action vertically on mobile
 * Token dependencies: --status-banner-*, --status-*
 * Spec reference: Design System §11, §14
 * ---------------------------------------------------------------
 */
import { statusClass, statusColors } from './statusMap.js';
export function createStatusBanner({ title, detail, state, actionLabel, onAction }) {
  const c = statusColors(statusClass(state));
  const el = document.createElement('div'); el.className = 'et-statusbanner';
  el.style.cssText = `background:${c.bg};border-color:${c.border}`;
  const text = document.createElement('div');
  text.innerHTML = `<div style="font-weight:600;font-size:13.5px;color:${c.fg}">${title}</div><div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${detail}</div>`;
  el.appendChild(text);
  if (actionLabel) {
    const btn = document.createElement('button'); btn.className = 'et-btn et-btn--primary'; btn.textContent = actionLabel;
    btn.addEventListener('click', onAction); el.appendChild(btn);
  }
  return el;
}
