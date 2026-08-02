/**
 * IconButton — Base component
 * ---------------------------------------------------------------
 * API: createIconButton(iconSvg, ariaLabel, {onClick, disabled})
 * Variants: default only (icon swaps)
 * States: default, hover, focus, disabled
 * Accessibility: ariaLabel is mandatory — throws without it
 * Keyboard: Tab + Enter/Space
 * RTL: Icon mirrors only if directional
 * Responsive: 44×44px minimum touch target on mobile
 * Token dependencies: --button-secondary-*
 * Spec reference: Interaction Spec §14
 * ---------------------------------------------------------------
 */
export function createIconButton(iconSvg, ariaLabel, { onClick, disabled = false } = {}) {
  if (!ariaLabel) throw new Error('IconButton requires ariaLabel for accessibility.');
  const el = document.createElement('button');
  el.className = 'et-icon-btn';
  el.setAttribute('aria-label', ariaLabel);
  el.disabled = disabled;
  el.innerHTML = iconSvg;
  if (onClick) el.addEventListener('click', onClick);
  return el;
}
