/**
 * Toggle — Base component
 * ---------------------------------------------------------------
 * API: createToggle({on, onChange, ariaLabel})
 * Variants: default
 * States: on, off, disabled
 * Accessibility: role=switch, aria-checked; ariaLabel mandatory
 * Keyboard: Space/Enter toggles when focused
 * RTL: Thumb position flips side under dir=rtl
 * Responsive: 44×24px minimum touch target
 * Token dependencies: --brand, --surface-3
 * Spec reference: Interaction Spec §7
 * ---------------------------------------------------------------
 */
export function createToggle({ on = false, onChange, ariaLabel } = {}) {
  if (!ariaLabel) throw new Error('Toggle requires ariaLabel.');
  const el = document.createElement('button');
  el.className = 'et-toggle'; el.setAttribute('role', 'switch'); el.setAttribute('aria-checked', String(on)); el.setAttribute('aria-label', ariaLabel);
  el.style.background = on ? 'var(--brand)' : 'var(--surface-3)';
  const thumb = document.createElement('span');
  thumb.className = 'et-toggle__thumb';
  const rtl = document.documentElement.dir === 'rtl';
  thumb.style[rtl ? (on ? 'left' : 'right') : (on ? 'right' : 'left')] = '2px';
  el.appendChild(thumb);
  el.addEventListener('click', () => { const next = el.getAttribute('aria-checked') !== 'true'; el.setAttribute('aria-checked', String(next)); el.style.background = next ? 'var(--brand)' : 'var(--surface-3)'; if (onChange) onChange(next); });
  return el;
}
