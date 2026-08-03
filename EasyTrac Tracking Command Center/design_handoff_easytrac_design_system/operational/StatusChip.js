/**
 * StatusChip — Operational component
 * ---------------------------------------------------------------
 * API: createStatusChip(state)
 * Variants: one per of the 14 approved states, mapped to 5 classes
 * States: n/a (chip IS the state)
 * Accessibility: Always renders icon dot + text label, never color alone
 * Keyboard: Not interactive by default
 * RTL: Dot sits after label in RTL (flex reverses)
 * Responsive: Font-size follows density mode
 * Token dependencies: --status-chip-*, --status-*
 * Spec reference: Design System §2, §7, §22
 * ---------------------------------------------------------------
 */
import { statusClass, statusColors } from './statusMap.js';
export function createStatusChip(state) {
  const c = statusColors(statusClass(state));
  const el = document.createElement('span');
  el.className = 'et-statuschip';
  el.style.cssText = `background:${c.bg};color:${c.fg};border-color:${c.border}`;
  el.innerHTML = `<span class="et-statuschip__dot" style="background:${c.fg}"></span>${state}`;
  return el;
}
