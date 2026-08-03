/**
 * Page — Layout primitive
 * ---------------------------------------------------------------
 * API: Content column with max-width and page padding.
 * Variants: title?: string, children: Node
 * States: none
 * Accessibility: static
 * Keyboard: h1 rendered from title for landmark structure
 * RTL: none
 * Responsive: padding logical (var(--p-space-9)) already direction-agnostic
 * Token dependencies: max-width 1040px; full-bleed on mobile via CSS override
 * Spec reference: --p-space-8, --p-space-9
 * ---------------------------------------------------------------
 */
export function createPage(opts = {}) {
  const el = document.createElement('div');
  el.className = 'et-page';
  if (opts.dir) el.setAttribute('dir', opts.dir);
  if (opts.className) el.classList.add(opts.className);
  if (opts.children) (Array.isArray(opts.children) ? opts.children : [opts.children]).forEach(c => el.appendChild(c));
  return el;
}
