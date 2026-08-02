/**
 * Section — Layout primitive
 * ---------------------------------------------------------------
 * API: Titled content block with h2 + border-bottom.
 * Variants: title: string, children: Node
 * States: none
 * Accessibility: static
 * Keyboard: heading level configurable (default h2)
 * RTL: none
 * Responsive: none
 * Token dependencies: none
 * Spec reference: --border-subtle
 * ---------------------------------------------------------------
 */
export function createSection(opts = {}) {
  const el = document.createElement('div');
  el.className = 'et-section';
  if (opts.dir) el.setAttribute('dir', opts.dir);
  if (opts.className) el.classList.add(opts.className);
  if (opts.children) (Array.isArray(opts.children) ? opts.children : [opts.children]).forEach(c => el.appendChild(c));
  return el;
}
