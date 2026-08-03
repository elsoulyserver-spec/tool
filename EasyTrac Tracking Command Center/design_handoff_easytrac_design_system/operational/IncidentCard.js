/**
 * IncidentCard — Operational component
 * ---------------------------------------------------------------
 * API: createIncidentCard({title, meta, rootCause, state, fixLabel, onFix, onViewTrace})
 * Variants: default
 * States: Warning/Degraded/Error/Offline
 * Accessibility: Root cause always plain text, never icon-only
 * Keyboard: Both actions Tab-reachable
 * RTL: Chip and actions reflow to trailing edge
 * Responsive: Actions stack full-width on mobile
 * Token dependencies: --incidentcard-*, --status-*
 * Spec reference: Design System §11, §14, §27
 * ---------------------------------------------------------------
 */
import { createStatusChip } from './StatusChip.js';
export function createIncidentCard({ title, meta, rootCause, state, fixLabel, onFix, onViewTrace }) {
  const el = document.createElement('div'); el.className = 'et-incidentcard';
  const top = document.createElement('div'); top.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;';
  const left = document.createElement('div');
  left.innerHTML = `<div style="font-size:13.5px;font-weight:600;">${title}</div><div style="font-size:11.5px;color:var(--incidentcard-meta-fg);margin-top:3px;">${meta}</div>`;
  top.append(left, createStatusChip(state));
  const cause = document.createElement('div'); cause.style.cssText = 'font-size:12.5px;color:var(--text-secondary);margin-top:10px;'; cause.textContent = rootCause;
  const actions = document.createElement('div'); actions.style.cssText = 'margin-top:12px;display:flex;gap:8px;';
  const fixBtn = document.createElement('button'); fixBtn.className = 'et-btn et-btn--primary'; fixBtn.textContent = fixLabel; fixBtn.addEventListener('click', onFix);
  const traceBtn = document.createElement('button'); traceBtn.className = 'et-btn et-btn--secondary'; traceBtn.textContent = 'View trace'; traceBtn.addEventListener('click', onViewTrace);
  actions.append(fixBtn, traceBtn);
  el.append(top, cause, actions);
  return el;
}
