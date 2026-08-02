/**
 * SearchFilterTable — Pattern (composition)
 * ---------------------------------------------------------------
 * API: createSearchFilterTable({columns, rows, filters, onSearch, onRemoveFilter, onSort, sortState})
 * Variants: Destinations, Events Explorer, Alerts, Audit Log (row/column config varies, pattern is shared)
 * States: inherits DataTable + FilterChip states
 * Accessibility: Toolbar and table are two landmarks; filter removal announced via aria-live at integration point
 * Keyboard: Full keyboard path: search → chips → table, in visual tab order
 * RTL: Toolbar children reflow via flex row-reverse under dir=rtl
 * Responsive: Collapses filters into a single "Filters (n)" sheet trigger below 768px (Interaction Spec §16)
 * Token dependencies: inherits Search/FilterChip/DataTable tokens
 * Spec reference: Interaction Spec §3, §4, §6; Screen Spec §3, §4, §18
 * ---------------------------------------------------------------
 */
import { createSearch } from '../components/Search.js';
import { createFilterChip } from '../components/FilterChip.js';
import { createDataTable } from '../components/DataTable.js';
import { createToolbar } from '../layout/Toolbar.js';

/** Composes Search + FilterChips + DataTable into the standard list-screen pattern (Destinations, Events, Alerts, Audit Log). */
export function createSearchFilterTable({ columns, rows, filters, onSearch, onRemoveFilter, onSort, sortState }) {
  const toolbar = createToolbar({ children: [
    createSearch({ onChange: onSearch }),
    ...filters.map(f => createFilterChip(f.label, () => onRemoveFilter(f.id))),
  ]});
  const table = createDataTable(columns, rows, { onSort, sortState });
  const wrap = document.createElement('div');
  wrap.append(toolbar, table);
  return wrap;
}
