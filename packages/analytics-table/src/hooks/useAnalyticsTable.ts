'use client'

/**
 * useAnalyticsTable — master hook composing engine + virtualizer + state
 *
 * Usage:
 *   const table = useAnalyticsTable({ tableId, data, columns, mode, locale, direction })
 *
 * Returns everything AnalyticsTable needs — table instance, virtualizer refs,
 * state dispatch, data state, and export helpers.
 */

import { useReducer, useCallback, useEffect, useMemo, useRef } from 'react'
import { useReactTable } from '@tanstack/react-table'
import {
  buildTableOptions,
  adaptPinningForDirection,
  assertModeForRowCount,
} from '../core/engine'
import {
  tableStateReducer,
  DEFAULT_TABLE_STATE,
  persistTableState,
  loadTableState,
} from '../core/state'
import { useRowVirtualizer, useColVirtualizer } from '../virtualization/row-virtualizer'
import type {
  AnalyticsRow,
  AnalyticsTableState,
  TableMode,
  Direction,
  TableDataState,
  ServerCallbacks,
  TableDensity,
  SavedView,
  ColumnDef,
} from '../core/types'
import type { SupportedLocale } from '@/lib/formatters'

// ── Public API ────────────────────────────────────────────────────────────────

export interface UseAnalyticsTableConfig<TRow extends AnalyticsRow> {
  tableId:           string
  data:              TRow[]
  columns:           ColumnDef<TRow>[]
  mode?:             TableMode
  locale?:           SupportedLocale
  direction?:        Direction
  dataState?:        TableDataState
  /** Total row count for server-side pagination */
  rowCount?:         number
  server?:           ServerCallbacks<TRow>
  /** Override initial state — e.g. from URL params */
  initialState?:     Partial<AnalyticsTableState>
  /** Persist state to localStorage on every change */
  persistState?:     boolean
  /** Container width in px — needed for column virtualizer */
  containerWidth?:   number
  getRowId?:         (row: TRow) => string
  getSubRows?:       (row: TRow) => TRow[] | undefined
  enableMultiSort?:  boolean
}

export interface UseAnalyticsTableResult<TRow extends AnalyticsRow> {
  table:           ReturnType<typeof useReactTable<TRow>>
  state:           AnalyticsTableState
  dispatch:        React.Dispatch<import('../core/state').TableAction>
  dataState:       TableDataState
  locale:          SupportedLocale
  direction:       Direction
  mode:            TableMode
  scrollRef:       React.RefObject<HTMLDivElement>
  virtualRows:     Array<{ index: number; start: number; size: number; key: string | number }>
  virtualColumns:  Array<{ index: number; start: number; size: number; key: string | number }>
  totalRowsHeight: number
  isRowVirt:       boolean
  isColVirt:       boolean
  scrollToRow:     (index: number) => void
  scrollToTop:     () => void
  setDensity:      (d: TableDensity) => void
  loadView:        (view: SavedView) => void
  resetFilters:    () => void
  clearSelection:  () => void
}

export function useAnalyticsTable<TRow extends AnalyticsRow>(
  config: UseAnalyticsTableConfig<TRow>,
): UseAnalyticsTableResult<TRow> {
  const {
    tableId,
    data,
    columns,
    mode          = 'client',
    locale        = 'en-SA',
    direction     = 'ltr',
    dataState     = 'live',
    rowCount,
    server,
    persistState  = true,
    containerWidth= 1200,
    getRowId,
    getSubRows,
    enableMultiSort,
  } = config

  // ── State ──────────────────────────────────────────────────────────────────
  const [state, dispatch] = useReducer(tableStateReducer, DEFAULT_TABLE_STATE, () => {
    const persisted = persistState ? loadTableState(tableId) : {}
    return {
      ...DEFAULT_TABLE_STATE,
      ...(config.initialState ?? {}),
      ...persisted,
    }
  })

  // Persist on every state change (debounced via requestIdleCallback if available)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!persistState) return
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => persistTableState(tableId, state), 300)
    return () => { if (persistTimer.current) clearTimeout(persistTimer.current) }
  }, [tableId, state, persistState])

  // ── Mode guard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    try { assertModeForRowCount(data.length, mode) } catch (e) {
      console.error((e as Error).message)
    }
  }, [data.length, mode])

  // ── State change handler ───────────────────────────────────────────────────
  const onStateChange = useCallback(
    (updater: (prev: AnalyticsTableState) => AnalyticsTableState) => {
      dispatch({ type: 'PATCH', payload: updater(state) })
    },
    [state],
  )

  // ── TanStack Table instance ────────────────────────────────────────────────
  const tableOptions = useMemo(
    () =>
      buildTableOptions<TRow>({
        data,
        columns: columns as any,
        mode,
        state,
        onStateChange,
        rowCount,
        server,
        direction,
        getRowId,
        getSubRows,
        enableMultiSort,
      }),
    // data and columns are refs — deep comparison would be too expensive
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, columns, mode, state, direction],
  )

  const table = useReactTable<TRow>(tableOptions)

  // ── Virtualizer ────────────────────────────────────────────────────────────
  const rows = table.getRowModel().rows
  const {
    scrollRef, virtualItems: virtualRows, totalSize: totalRowsHeight,
    isVirtualized: isRowVirt, scrollToRow, scrollToTop,
  } = useRowVirtualizer({
    rowCount:  rows.length,
    density:   state.density,
    fastScroll:rows.length > 10_000,
  })

  const leafColumns    = table.getVisibleLeafColumns()
  const columnWidths   = leafColumns.map(c => c.getSize())

  const { virtualColumns, isVirtualized: isColVirt } = useColVirtualizer(scrollRef, {
    columnWidths,
    containerWidth,
    enabled: true,
  })

  // ── Convenience callbacks ──────────────────────────────────────────────────
  const setDensity   = useCallback((d: TableDensity)  => dispatch({ type: 'SET_DENSITY', payload: d }), [])
  const loadView     = useCallback((v: SavedView)      => dispatch({ type: 'LOAD_VIEW',  payload: v }), [])
  const resetFilters = useCallback(()                  => dispatch({ type: 'RESET_FILTERS' }), [])
  const clearSelection= useCallback(()                 => dispatch({ type: 'CLEAR_SELECTION' }), [])

  return {
    table,
    state,
    dispatch,
    dataState,
    locale,
    direction,
    mode,
    scrollRef,
    virtualRows,
    virtualColumns,
    totalRowsHeight,
    isRowVirt,
    isColVirt,
    scrollToRow,
    scrollToTop,
    setDensity,
    loadView,
    resetFilters,
    clearSelection,
  }
}
