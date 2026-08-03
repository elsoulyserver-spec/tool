/**
 * EventTrace — Operational component
 * ---------------------------------------------------------------
 * API: createEventTrace(steps: {title, detail, state, timestamp?, responseCode?}[])
 * Variants: default
 * States: each step carries its own status color
 * Accessibility: Each step is a list item (ol) in production; ordered semantically
 * Keyboard: Expand/collapse handled at Pattern layer
 * RTL: Connecting line and markers flip side
 * Responsive: Full width stacked list at all breakpoints
 * Token dependencies: --timeline-*, --status-*
 * Spec reference: Design System §11, §27; Interaction Spec §18; Screen Spec — Event Details
 * ---------------------------------------------------------------
 */
import { statusClass, statusColors } from './statusMap.js';
export function createEventTrace(steps) {
  // steps: [{ title, detail, state, timestamp?, responseCode? }]
  const el = document.createElement('div'); el.className = 'et-eventtrace';
  steps.forEach(step => {
    const li = document.createElement('div'); li.className = 'et-eventtrace__step';
    const c = statusColors(statusClass(step.state));
    const marker = document.createElement('div'); marker.className = 'et-eventtrace__marker'; marker.style.background = c.fg;
    li.appendChild(marker);

    const header = document.createElement('div'); header.className = 'et-eventtrace__header';
    const title = document.createElement('div'); title.style.cssText = 'font-size:13px;font-weight:600;'; title.textContent = step.title;
    header.appendChild(title);
    if (step.timestamp) {
      const ts = document.createElement('div'); ts.className = 'et-eventtrace__timestamp'; ts.textContent = step.timestamp;
      header.appendChild(ts);
    }
    li.appendChild(header);

    const detail = document.createElement('div'); detail.style.cssText = 'font-size:11.5px;color:var(--timeline-detail-fg);'; detail.textContent = step.detail;
    li.appendChild(detail);

    if (step.responseCode) {
      const code = document.createElement('div'); code.className = 'et-eventtrace__code'; code.style.color = c.fg; code.textContent = step.responseCode;
      li.appendChild(code);
    }

    el.appendChild(li);
  });
  return el;
}
