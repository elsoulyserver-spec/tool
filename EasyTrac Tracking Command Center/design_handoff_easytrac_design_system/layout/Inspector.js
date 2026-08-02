/**
 * Inspector — Layout primitive
 * ---------------------------------------------------------------
 * API: Right-docked detail rail, hidden on mobile.
 * Variants: children: Node, open?: boolean
 * States: none
 * Accessibility: open/closed
 * Keyboard: role="complementary"
 * RTL: Esc closes if opened as an overlay on tablet
 * Responsive: flips to right-docked border in RTL
 * Token dependencies: hidden below 768px per Interaction Spec §16
 * Spec reference: --border-subtle
 * ---------------------------------------------------------------
 */
export function createInspector(opts = {}) {
  const el = document.createElement('div');
  el.className = 'et-inspector';
  if (opts.dir) el.setAttribute('dir', opts.dir);
  if (opts.className) el.classList.add(opts.className);
  if (opts.children) (Array.isArray(opts.children) ? opts.children : [opts.children]).forEach(c => el.appendChild(c));
  return el;
}
