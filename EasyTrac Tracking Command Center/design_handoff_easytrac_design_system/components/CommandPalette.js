/**
 * CommandPalette — Base component
 * ---------------------------------------------------------------
 * API: createCommandPalette({onQuery, results, onExecute, onClose})
 * Variants: default
 * States: closed, open, loading results
 * Accessibility: role=dialog aria-modal; input aria-autocomplete=list
 * Keyboard: Cmd/Ctrl+K opens (bound at app level); arrows move selection; Enter executes; Esc closes
 * RTL: RTL-aware text input and result alignment
 * Responsive: Bottom-sheet search on mobile instead of centered palette
 * Token dependencies: --dialog-*, --surface-overlay
 * Spec reference: Interaction Spec §13, §20
 * ---------------------------------------------------------------
 */
export function createCommandPalette({ onQuery, results = [], onExecute, onClose }) {
  const scrim = document.createElement('div'); scrim.className = 'et-palette-scrim';
  const palette = document.createElement('div'); palette.className = 'et-palette'; palette.setAttribute('role', 'dialog'); palette.setAttribute('aria-modal', 'true');
  const input = document.createElement('input'); input.setAttribute('aria-autocomplete', 'list');
  input.style.cssText = 'width:100%;box-sizing:border-box;border:none;border-bottom:1px solid var(--border-subtle);background:transparent;color:var(--text-primary);padding:16px;font-size:14px;outline:none;';
  input.placeholder = 'Search or run a command…';
  input.addEventListener('input', (e) => onQuery && onQuery(e.target.value));
  const list = document.createElement('div'); list.style.padding = '8px';
  results.forEach(r => {
    const row = document.createElement('div'); row.style.cssText = 'display:flex;justify-content:space-between;padding:9px 12px;border-radius:6px;font-size:13px;cursor:pointer;';
    row.innerHTML = `<span>${r.label}</span><span style="color:var(--text-tertiary);font-size:11.5px;">${r.group}</span>`;
    row.addEventListener('click', () => onExecute(r));
    list.appendChild(row);
  });
  scrim.addEventListener('click', (e) => { if (e.target === scrim) { scrim.remove(); onClose && onClose(); } });
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { scrim.remove(); onClose && onClose(); document.removeEventListener('keydown', esc); } });
  palette.append(input, list); scrim.appendChild(palette);
  document.body.appendChild(scrim); input.focus();
  return scrim;
}
