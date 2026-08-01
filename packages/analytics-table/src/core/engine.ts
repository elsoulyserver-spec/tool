/**
 * Easy Track Analytics Table — Core Engine
 *
 * Wraps TanStack Table v8 with:
 *  - Mode-aware feature gating (client / server / hybrid)
 *  - RTL column ordering enforcement
 *  - Typed state management
 *  - Performance budget enforcement
 *
 * This file contains zero JSX — pure logic, fully testable.
 */

import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getExpandedRowModel,
  getPaginationRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFacetedMinMaxValues,
  useReactTable,
  type TableOptions,
  type RowData,
} from '@tanstack/react-table'

import type {
  AnalyticsRow,
  AnalyticsTableState,
  TableMode,
  Direction,
  ServerCallbacks,
  PERF_THRESHOLDS,
} from './types'

import { DENSITY_CONFIG, type TableDensity } from './types'

// ── Column helper factory ─────────────────────────────────────────────────────

export function createAnalyticsColumnHelper<TRow extends AnalyticsRow>() {
  return createColumnHelper<TRow>()
}

// ── Mode-aware row model selection ───────────────────────────────────────────

function getRowModels(mode: TableMode) {
  // Client: full local processing — all row models active
  if (mode === 'client') {
    return {
      getCoreRowModel:          getCoreRowModel(),
      getSortedRowModel:        getSortedRowModel(),
      getFilteredRowModel:      getFilteredRowModel(),
      getGroupedRowModel:       getGroupedRowModel(),
      getExpandedRowModel:      getExpandedRowModel(),
      getPaginationRowModel:    getPaginationRowModel(),
      getFacetedRowModel:       getFacetedRowModel(),
      getFacetedUniqueValues:   getFacetedUniqueValues(),
      getFacetedMinMaxValues:   getFacetedMinMaxValues(),
    }
  }

  // Server: TanStack Table is a view layer only — sorting/filtering/pagination
  // happen server-side. Only core model + pagination model are enabled locally.
  // Faceting is disabled (counts come from server aggregation).
  if (mode === 'server') {
    return {
      getCoreRowModel:       getCoreRowModel(),
      getPaginationRowModel: getPaginationRowModel(),
      getExpandedRowModel:   getExpandedRowModel(),
    }
  }

  // Hybrid: local filtering on fetched page, server handles pagination + sorting
  return {
    getCoreRowModel:       getCoreRowModel(),
    getFilteredRowModel:   getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getExpandedRowModel:   getExpandedRowModel(),
  }
}

// ── RTL column order enforcement ──────────────────────────────────────────────
// TanStack Table always renders columns LTR. In RTL layouts we reverse the
// visual order at the CSS level (flex-direction: row-reverse), NOT in the data.
// Sticky columns must be re-assigned: what was 'left' becomes 'right'.
//
// This function transforms column pinning state for RTL pages.

export function adaptPinningForDirection(
  pinning: { left?: string[]; right?: string[] },
  direction: Direction,
): { left?: string[]; right?: string[] } {
  if (direction === 'ltr') return pinning
  // In RTL: swap left ↔ right so visually sticky columns stay at the correct edge
  return { left: pinning.right ?? [], right: pinning.left ?? [] }
}

// ── Performance guard ─────────────────────────────────────────────────────────

export function assertModeForRowCount(rowCount: number, mode: TableMode): void {
  // 500K+ rows in client mode is a guaranteed OOM — hard error
  if (rowCount > 500_000 && mode === 'client') {
    throw new Error(
      `[AnalyticsTable] ${rowCount.toLocaleString()} rows in client mode exceeds the 500K limit. ` +
      `Switch to server or hybrid mode. See PERF_THRESHOLDS.SERVER_REQUIRED.`
    )
  }
  // Warn at 100K in client mode
  if (rowCount > 100_000 && mode === 'client' && process.env.NODE_ENV !== 'production') {
    console.warn(
      `[AnalyticsTable] ${rowCount.toLocaleString()} rows in client mode. ` +
      `Performance may degrade. Consider server mode above 100K rows.`
    )
  }
}

// ── Core table options builder ────────────────────────────────────────────────

export interface BuildTableOptionsParams<TRow extends AnalyticsRow> {
  data:         TRow[]
  columns:      ReturnType<typeof createAnalyticsColumnHelper<TRow>>['accessor'][]
  mode:         TableMode
  state:        Partial<AnalyticsTableState>
  onStateChange:(updater: (prev: AnalyticsTableState) => AnalyticsTableState) => void
  rowCount?:    number   // required in server mode for pagination UI
  server?:      ServerCallbacks<TRow>
  direction:    Direction
  getRowId?:    (row: TRow) => string
  getSubRows?:  (row: TRow) => TRow[] | undefined
  enableMultiSort?: boolean
}

export function buildTableOptions<TRow extends AnalyticsRow>(
  params: BuildTableOptionsParams<TRow>,
): TableOptions<TRow> {
  const {
    data, columns, mode, state, onStateChange,
    rowCount, server, direction, getRowId, getSubRows,
    enableMultiSort = true,
  } = params

  const isServer = mode === 'server'

  return {
    data,
    columns: columns as any,

    // ── Row identity ──────────────────────────────────────────────
    getRowId:  getRowId  ?? ((row) => row.id),
    getSubRows:getSubRows ?? undefined,

    // ── Server-side flags ─────────────────────────────────────────
    manualSorting:    isServer,
    manualFiltering:  isServer,
    manualPagination: isServer,
    manualGrouping:   isServer,
    manualExpanding:  false,    // always local — row expansion is a UI concern

    // ── Total row count for server mode pagination ─────────────────
    rowCount: isServer ? (rowCount ?? -1) : undefined,

    // ── Row models ────────────────────────────────────────────────
    ...getRowModels(mode),

    // ── State ─────────────────────────────────────────────────────
    state: {
      sorting:          state.sorting          ?? [],
      columnFilters:    state.columnFilters    ?? [],
      columnVisibility: state.columnVisibility ?? {},
      columnOrder:      state.columnOrder      ?? [],
      columnPinning:    adaptPinningForDirection(
                          state.columnPinning ?? {},
                          direction,
                        ),
      columnSizing:     state.columnSizing     ?? {},
      expanded:         state.expanded         ?? {},
      grouping:         state.grouping         ?? [],
      pagination:       state.pagination       ?? { pageIndex: 0, pageSize: 50 },
      rowSelection:     state.rowSelection     ?? {},
      globalFilter:     state.globalFilter     ?? '',
    },

    // ── State change handlers ─────────────────────────────────────
    onSortingChange: (updater) => {
      onStateChange(prev => ({
        ...prev,
        sorting: typeof updater === 'function' ? updater(prev.sorting ?? []) : updater,
      }))
      if (isServer && server?.onSortingChange) {
        const next = typeof updater === 'function' ? updater(state.sorting ?? []) : updater
        void server.onSortingChange(next)
      }
    },

    onColumnFiltersChange: (updater) => {
      onStateChange(prev => ({
        ...prev,
        columnFilters: typeof updater === 'function' ? updater(prev.columnFilters ?? []) : updater,
      }))
      if (isServer && server?.onFilterChange) {
        const next = typeof updater === 'function' ? updater(state.columnFilters ?? []) : updater
        void server.onFilterChange(next)
      }
    },

    onGlobalFilterChange: (updater) => {
      onStateChange(prev => ({
        ...prev,
        globalFilter: typeof updater === 'function' ? updater(prev.globalFilter ?? '') : updater,
      }))
    },

    onColumnVisibilityChange: (updater) =>
      onStateChange(prev => ({
        ...prev,
        columnVisibility: typeof updater === 'function'
          ? updater(prev.columnVisibility ?? {})
          : updater,
      })),

    onColumnOrderChange: (updater) =>
      onStateChange(prev => ({
        ...prev,
        columnOrder: typeof updater === 'function'
          ? updater(prev.columnOrder ?? [])
          : updater,
      })),

    onColumnPinningChange: (updater) => {
      const next = typeof updater === 'function'
        ? updater(adaptPinningForDirection(state.columnPinning ?? {}, direction))
        : updater
      onStateChange(prev => ({ ...prev, columnPinning: next }))
    },

    onColumnSizingChange: (updater) =>
      onStateChange(prev => ({
        ...prev,
        columnSizing: typeof updater === 'function'
          ? updater(prev.columnSizing ?? {})
          : updater,
      })),

    onExpandedChange: (updater) =>
      onStateChange(prev => ({
        ...prev,
        expanded: typeof updater === 'function'
          ? updater(prev.expanded ?? {})
          : updater,
      })),

    onGroupingChange: (updater) =>
      onStateChange(prev => ({
        ...prev,
        grouping: typeof updater === 'function'
          ? updater(prev.grouping ?? [])
          : updater,
      })),

    onPaginationChange: (updater) => {
      onStateChange(prev => ({
        ...prev,
        pagination: typeof updater === 'function'
          ? updater(prev.pagination ?? { pageIndex: 0, pageSize: 50 })
          : updater,
      }))
      if (isServer && server?.onPageChange) {
        const next = typeof updater === 'function'
          ? updater(state.pagination ?? { pageIndex: 0, pageSize: 50 })
          : updater
        void server.onPageChange(next)
      }
    },

    onRowSelectionChange: (updater) =>
      onStateChange(prev => ({
        ...prev,
        rowSelection: typeof updater === 'function'
          ? updater(prev.rowSelection ?? {})
          : updater,
      })),

    // ── Feature config ────────────────────────────────────────────
    enableSorting:           true,
    enableMultiSort,
    enableSortingRemoval:    true,
    enableColumnFilters:     true,
    enableGlobalFilter:      mode !== 'server',
    enableGrouping:          mode === 'client',
    enableExpanding:         true,
    enableRowSelection:      true,
    enableColumnResizing:    true,
    columnResizeMode:        'onChange',
    enableColumnPinning:     true,
    enableHiding:            true,

    // ── Aggregation functions ──────────────────────────────────────
    aggregationFns: {
      sum:   (col, leafRows) => leafRows.reduce((acc, row) => acc + (Number(row.getValue(col.id)) || 0), 0),
      avg:   (col, leafRows) => {
        const vals = leafRows.map(r => Number(r.getValue(col.id))).filter(n => !isNaN(n))
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
      },
      count: (_col, leafRows) => leafRows.length,
    },

    // ── Filter functions ──────────────────────────────────────────
    filterFns: {
      numeric: (row, colId, filterValue: [number | null, number | null]) => {
        const val = Number(row.getValue(colId))
        if (isNaN(val)) return false
        const [min, max] = filterValue
        if (min !== null && val < min) return false
        if (max !== null && val > max) return false
        return true
      },
      textSearch: (row, colId, filterValue: string) => {
        const val = String(row.getValue(colId) ?? '').toLowerCase()
        return val.includes(filterValue.toLowerCase())
      },
      multiSelect: (row, colId, filterValue: string[]) => {
        if (!filterValue.length) return true
        return filterValue.includes(String(row.getValue(colId)))
      },
      dateRange: (row, colId, filterValue: [string | null, string | null]) => {
        const val = row.getValue(colId) as string | null
        if (!val) return false
        const [from, to] = filterValue
        if (from && val < from) return false
        if (to   && val > to)   return false
        return true
      },
    },

    defaultColumn: {
      minSize:   60,
      size:      120,
      maxSize:   600,
      enableResizing: true,
    },

    // ── Debug ─────────────────────────────────────────────────────
    debugTable:  process.env.NODE_ENV === 'development',
    debugHeaders:false,
    debugColumns:false,
  }
}
