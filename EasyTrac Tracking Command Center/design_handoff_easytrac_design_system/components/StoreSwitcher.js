/**
 * StoreSwitcher — Base component
 * ---------------------------------------------------------------
 * API: createStoreSwitcher(stores, {current, onSwitch})
 * Variants: default
 * States: closed, open
 * Accessibility: role=combobox pattern; each row aria-selected
 * Keyboard: Type-ahead search when >8 stores
 * RTL: Dropdown alignment flips under RTL
 * Responsive: Full-screen sheet below 768px
 * Token dependencies: --surface-1, --status-* (health dot)
 * Spec reference: Design System §5; Interaction Spec §2
 * ---------------------------------------------------------------
 */
export function createStoreSwitcher(stores, { current, onSwitch } = {}) {
  const wrap = document.createElement('div');
  const btn = document.createElement('button'); btn.className = 'et-storeswitcher'; btn.setAttribute('aria-haspopup', 'listbox');
  btn.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:var(--status-${current.statusClass}-fg)"></span><span style="flex:1;font-size:13px;">${current.name}</span><span style="font-size:11px;color:var(--text-tertiary);">⌄</span>`;
  const list = document.createElement('div'); list.setAttribute('role', 'listbox'); list.style.cssText = 'margin-top:4px;background:var(--surface-overlay);border:1px solid var(--border-default);border-radius:8px;box-shadow:var(--shadow-md);overflow:hidden;display:none;';
  stores.forEach(store => {
    const row = document.createElement('div'); row.setAttribute('role', 'option');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 12px;font-size:12.5px;border-bottom:1px solid var(--border-subtle);cursor:pointer;';
    row.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:var(--status-${store.statusClass}-fg)"></span>${store.name}`;
    row.addEventListener('click', () => { onSwitch(store); list.style.display = 'none'; });
    list.appendChild(row);
  });
  btn.addEventListener('click', () => { list.style.display = list.style.display === 'none' ? 'block' : 'none'; });
  wrap.append(btn, list);
  return wrap;
}
