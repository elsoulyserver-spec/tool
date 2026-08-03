/**
 * Panel — Layout primitive
 * ---------------------------------------------------------------
 * API: Bordered, padded surface — the base "card" primitive.
 * Variants: children: Node, padding?: token
 * States: elevated (shadow-md) via prop
 * Accessibility: static
 * Keyboard: role="group" optional aria-label prop
 * RTL: none
 * Responsive: none (symmetric padding)
 * Token dependencies: padding reduces to --d-pad in dense contexts
 * Spec reference: --card-bg, --card-border, --card-radius, --card-padding, --card-shadow
 * ---------------------------------------------------------------
 */
export function createPanel(opts = {}) {
  const el = document.createElement('div');
  el.className = 'et-panel';
  if (opts.dir) el.setAttribute('dir', opts.dir);
  if (opts.className) el.classList.add(opts.className);
  if (opts.children) (Array.isArray(opts.children) ? opts.children : [opts.children]).forEach(c => el.appendChild(c));
  return el;
}
