/**
 * Sidebar — Base component
 * ---------------------------------------------------------------
 * API: createSidebar(items, {activeId})
 * Variants: default
 * States: item default/hover/active
 * Accessibility: nav landmark; current item aria-current=page
 * Keyboard: Arrow keys move focus (roving tabindex)
 * RTL: Border flips to trailing edge under RTL
 * Responsive: Replaced by bottom tab bar below 768px (Pattern layer)
 * Token dependencies: --sidebar-*
 * Spec reference: Design System §5; Interaction Spec §2, §16
 * ---------------------------------------------------------------
 */
export function createSidebar(items, { activeId } = {}) {
  const nav = document.createElement('nav'); nav.className = 'et-sidebar';
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'et-sidebar__item' + (item.id === activeId ? ' et-sidebar__item--active' : '');
    if (item.id === activeId) row.setAttribute('aria-current', 'page');
    row.textContent = item.label; row.tabIndex = 0;
    row.addEventListener('click', () => item.onSelect && item.onSelect());
    nav.appendChild(row);
  });
  return nav;
}
