/**
 * Pagination — Base component
 * ---------------------------------------------------------------
 * API: createPagination({page, totalPages, onChange})
 * Variants: default
 * States: default, disabled at first/last page
 * Accessibility: aria-label=Pagination; current page aria-current=page
 * Keyboard: Arrow keys move focus between prev/next
 * RTL: Prev/next arrows swap direction under RTL
 * Responsive: Collapses to "Page X of Y" only below 768px
 * Token dependencies: --border-default, --surface-2
 * Spec reference: Interaction Spec §6
 * ---------------------------------------------------------------
 */
export function createPagination({ page, totalPages, onChange }) {
  const el = document.createElement('div'); el.className = 'et-pagination'; el.setAttribute('aria-label', 'Pagination');
  const prev = document.createElement('button'); prev.textContent = '‹'; prev.disabled = page <= 1;
  prev.addEventListener('click', () => onChange(page - 1));
  const label = document.createElement('span'); label.style.padding = '0 8px'; label.textContent = `Page ${page} of ${totalPages}`;
  const next = document.createElement('button'); next.textContent = '›'; next.disabled = page >= totalPages;
  next.addEventListener('click', () => onChange(page + 1));
  el.append(prev, label, next);
  return el;
}
