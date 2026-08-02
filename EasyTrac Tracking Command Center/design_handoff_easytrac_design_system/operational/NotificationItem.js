/**
 * NotificationItem — Operational component
 * ---------------------------------------------------------------
 * API: createNotificationItem({title, meta, state})
 * Variants: default
 * States: mirrors triggering state
 * Accessibility: aria-live region wraps the notification list at Pattern layer
 * Keyboard: Not interactive itself; wrap in link at call site
 * RTL: Dot/text order flips
 * Responsive: Full parity on mobile (core mobile use case)
 * Token dependencies: --status-*
 * Spec reference: Screen Spec §16; Interaction Spec §10
 * ---------------------------------------------------------------
 */
import { statusClass, statusColors } from './statusMap.js';
export function createNotificationItem({ title, meta, state }) {
  const c = statusColors(statusClass(state));
  const el = document.createElement('div'); el.style.cssText = 'display:flex;gap:10px;background:var(--surface-1);border:1px solid var(--border-subtle);border-radius:8px;padding:12px 14px;align-items:flex-start;';
  el.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${c.fg};margin-top:5px;"></span><div><div style="font-size:12.5px;font-weight:600;">${title}</div><div style="font-size:11.5px;color:var(--text-tertiary);">${meta}</div></div>`;
  return el;
}
