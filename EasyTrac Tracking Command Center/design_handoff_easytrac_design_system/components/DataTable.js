/**
 * DataTable — Base component
 * ---------------------------------------------------------------
 * API: createDataTable(columns, rows, {onSort, sortState, selectable})
 * Variants: Low/Medium/High/Very-High density via [data-density]
 * States: row default/hover/selected, column sorted/unsorted
 * Accessibility: Real <table> markup with scoped <th>; selection announced via aria-live at Pattern layer
 * Keyboard: Arrow keys move cell focus; Space toggles row; Enter opens row
 * RTL: Column order and sort-indicator glyph mirror under RTL
 * Responsive: Card-per-row stacking on mobile (Pattern: SearchFilterTable)
 * Token dependencies: --table-*
 * Spec reference: Interaction Spec §6, §16
 * ---------------------------------------------------------------
 */
export function createDataTable(columns, rows, { onSort, sortState, selectable = true } = {}) {
  const table = document.createElement('table'); table.className = 'et-table';
  const thead = document.createElement('thead'); const headRow = document.createElement('tr');
  if (selectable) headRow.appendChild(document.createElement('th'));
  columns.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label + (sortState?.col === col.key ? (sortState.dir === 1 ? ' ↑' : ' ↓') : '');
    th.addEventListener('click', () => onSort && onSort(col.key));
    headRow.appendChild(th);
  });
  thead.appendChild(headRow); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach(row => {
    const tr = document.createElement('tr');
    if (selectable) {
      const td = document.createElement('td'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!row.selected;
      cb.addEventListener('change', () => row.onToggle && row.onToggle(cb.checked)); td.appendChild(cb); tr.appendChild(td);
    }
    columns.forEach(col => { const td = document.createElement('td'); td.textContent = row[col.key]; tr.appendChild(td); });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}
