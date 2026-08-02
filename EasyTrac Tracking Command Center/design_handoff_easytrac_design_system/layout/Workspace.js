/**
 * Workspace — Layout primitive
 * ---------------------------------------------------------------
 * API: Vertical stack of Panels/Sections with consistent gap.
 * Variants: children: Node[], gap?: token
 * States: none
 * Accessibility: static
 * Keyboard: none beyond children
 * RTL: none
 * Responsive: flex-direction unaffected by dir (column)
 * Token dependencies: gap token same at all breakpoints
 * Spec reference: --p-space-7
 * ---------------------------------------------------------------
 */
export function createWorkspace(opts = {}) {
  const el = document.createElement('div');
  el.className = 'et-workspace';
  if (opts.dir) el.setAttribute('dir', opts.dir);
  if (opts.className) el.classList.add(opts.className);
  if (opts.children) (Array.isArray(opts.children) ? opts.children : [opts.children]).forEach(c => el.appendChild(c));
  return el;
}
