/**
 * Breadcrumbs — Base component
 * ---------------------------------------------------------------
 * API: createBreadcrumbs(path)
 * Variants: default
 * States: default (all non-final levels clickable)
 * Accessibility: nav aria-label=Breadcrumb; ol/li structure recommended
 * Keyboard: Tab through each crumb link
 * RTL: Separator glyph mirrors under RTL
 * Responsive: Truncates middle segments on narrow viewports
 * Token dependencies: --text-secondary, --text-primary
 * Spec reference: Interaction Spec §2
 * ---------------------------------------------------------------
 */
export function createBreadcrumbs(path) {
  const nav = document.createElement('nav'); nav.className = 'et-breadcrumbs'; nav.setAttribute('aria-label', 'Breadcrumb');
  path.forEach((crumb, i) => {
    if (i > 0) { const sep = document.createElement('span'); sep.style.color = 'var(--text-tertiary)'; sep.textContent = '›'; nav.appendChild(sep); }
    const span = document.createElement(i === path.length - 1 ? 'span' : 'a');
    span.textContent = crumb.label; if (crumb.href && i !== path.length - 1) span.href = crumb.href;
    if (i === path.length - 1) span.style.color = 'var(--text-primary)';
    nav.appendChild(span);
  });
  return nav;
}
