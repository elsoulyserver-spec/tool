/**
 * SplitView — Layout primitive
 * ---------------------------------------------------------------
 * API: Two-pane layout: primary + secondary (e.g. table + detail).
 * Variants: primary: Node, secondary: Node, ratio?: number
 * States: none
 * Accessibility: static
 * Keyboard: none beyond children
 * RTL: none
 * Responsive: pane order and border side flip
 * Token dependencies: stacks vertically below 768px
 * Spec reference: --border-subtle
 * ---------------------------------------------------------------
 */
export function createSplitView(opts = {}) {
  const el = document.createElement('div');
  el.className = 'et-splitview';
  if (opts.dir) el.setAttribute('dir', opts.dir);
  if (opts.className) el.classList.add(opts.className);
  if (opts.children) (Array.isArray(opts.children) ? opts.children : [opts.children]).forEach(c => el.appendChild(c));
  return el;
}
