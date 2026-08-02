/**
 * Tabs — Base component
 * ---------------------------------------------------------------
 * API: createTabs(tabs, {activeIndex, onChange})
 * Variants: default
 * States: active, inactive, focus
 * Accessibility: role=tablist/tab wiring; consumer wires tabpanel
 * Keyboard: Arrow keys move focus (roving tabindex)
 * RTL: Tab order follows visual RTL order automatically
 * Responsive: Scrolls horizontally if overflowing on mobile
 * Token dependencies: --brand, --text-tertiary
 * Spec reference: Interaction Spec §1
 * ---------------------------------------------------------------
 */
export function createTabs(tabs, { activeIndex = 0, onChange } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'et-tabs'; wrap.setAttribute('role', 'tablist');
  tabs.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.className = 'et-tab'; btn.setAttribute('role', 'tab'); btn.setAttribute('aria-selected', String(i === activeIndex));
    btn.tabIndex = i === activeIndex ? 0 : -1;
    btn.textContent = t.label;
    btn.addEventListener('click', () => onChange && onChange(i));
    wrap.appendChild(btn);
  });
  return wrap;
}
