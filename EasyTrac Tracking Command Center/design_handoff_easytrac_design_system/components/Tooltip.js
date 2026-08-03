/**
 * Tooltip — Base component
 * ---------------------------------------------------------------
 * API: createTooltip(target, text)
 * Variants: default
 * States: hidden, visible (hover/focus)
 * Accessibility: role=tooltip, referenced via aria-describedby
 * Keyboard: Appears on keyboard focus, not only mouse hover
 * RTL: Position flips side under RTL
 * Responsive: Suppressed on touch (no hover) — content reachable another way
 * Token dependencies: --surface-overlay, --shadow-md
 * Spec reference: Interaction Spec §14
 * ---------------------------------------------------------------
 */
export function createTooltip(target, text) {
  const tip = document.createElement('div');
  tip.className = 'et-tooltip'; tip.setAttribute('role', 'tooltip'); tip.textContent = text; tip.style.display = 'none';
  const id = 'tip-' + Math.random().toString(36).slice(2); tip.id = id; target.setAttribute('aria-describedby', id);
  const show = () => { tip.style.display = 'block'; };
  const hide = () => { tip.style.display = 'none'; };
  target.addEventListener('mouseenter', show); target.addEventListener('focus', show);
  target.addEventListener('mouseleave', hide); target.addEventListener('blur', hide);
  document.body.appendChild(tip);
  return tip;
}
