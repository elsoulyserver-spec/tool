/**
 * Toolbar — Layout primitive
 * ---------------------------------------------------------------
 * API: Horizontal action row above content (search, filters, primary action).
 * Variants: children: Node[]
 * States: none
 * Accessibility: static
 * Keyboard: none beyond children (buttons carry their own labels)
 * RTL: tab order follows visual left-to-right (or right-to-left in RTL)
 * Responsive: gap direction-agnostic (flex row reverses automatically under dir=rtl)
 * Token dependencies: wraps to two rows on narrow viewports
 * Spec reference: --p-space-4, --border-subtle
 * ---------------------------------------------------------------
 */
export function createToolbar(opts = {}) {
  const el = document.createElement('div');
  el.className = 'et-toolbar';
  if (opts.dir) el.setAttribute('dir', opts.dir);
  if (opts.className) el.classList.add(opts.className);
  if (opts.children) (Array.isArray(opts.children) ? opts.children : [opts.children]).forEach(c => el.appendChild(c));
  return el;
}
