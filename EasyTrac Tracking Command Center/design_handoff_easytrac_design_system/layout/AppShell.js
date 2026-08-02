/**
 * AppShell — Layout primitive
 * ---------------------------------------------------------------
 * API: Root flex shell: sidebar + main content. One per app.
 * Variants: sidebar: Node, children: Node, dir?: "ltr"|"rtl"
 * States: none (structural)
 * Accessibility: static
 * Keyboard: landmark role="application" avoided; uses <div> + native <nav>/<main> children
 * RTL: none (delegates to children)
 * Responsive: dir attribute flips sidebar side and all logical borders
 * Token dependencies: Sidebar collapses to bottom tab bar below 768px (handled by Sidebar.js, not AppShell)
 * Spec reference: --surface-canvas, --text-primary
 * ---------------------------------------------------------------
 */
export function createAppShell(opts = {}) {
  const el = document.createElement('div');
  el.className = 'et-appshell';
  if (opts.dir) el.setAttribute('dir', opts.dir);
  if (opts.className) el.classList.add(opts.className);
  if (opts.children) (Array.isArray(opts.children) ? opts.children : [opts.children]).forEach(c => el.appendChild(c));
  return el;
}
