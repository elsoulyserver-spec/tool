/**
 * Easy Track Analytics Table — State Management
 *
 * Central reducer for all table state. Never mutate directly.
 * Serializable to JSON — safe to persist in localStorage / URL params.
 */

import type {
  AnalyticsTableState,
  PartialTableState,
  SavedView,
  TableDensity,
} from './types'

// ── Default state ─────────────────────────────────────────────────────────────

export const DEFAULT_TABLE_STATE: AnalyticsTableState = {
  sorting:          [],
  columnFilters:    [],
  columnVisibility: {},
  columnOrder:      [],
  columnPinning:    { left: [], right: [] },
  columnSizing:     {},
  expanded:         {},
  grouping:         [],
  pagination:       { pageIndex: 0, pageSize: 50 },
  rowSelection:     {},
  globalFilter:     '',
  density:          'standard',
}

// ── State actions ─────────────────────────────────────────────────────────────

export type TableAction =
  | { type: 'RESET' }
  | { type: 'PATCH'; payload: PartialTableState }
  | { type: 'SET_DENSITY'; payload: TableDensity }
  | { type: 'LOAD_VIEW'; payload: SavedView }
  | { type: 'RESET_FILTERS' }
  | { type: 'RESET_SORTING' }
  | { type: 'RESET_COLUMN_VISIBILITY' }
  | { type: 'SET_PAGE_SIZE'; payload: number }
  | { type: 'NEXT_PAGE' }
  | { type: 'PREV_PAGE' }
  | { type: 'GO_TO_PAGE'; payload: number }
  | { type: 'SELECT_ALL_ROWS'; payload: Record<string, boolean> }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'TOGGLE_GROUP'; payload: string }

// ── Reducer ───────────────────────────────────────────────────────────────────

export function tableStateReducer(
  state:  AnalyticsTableState,
  action: TableAction,
): AnalyticsTableState {
  switch (action.type) {
    case 'RESET':
      return { ...DEFAULT_TABLE_STATE }

    case 'PATCH':
      return { ...state, ...action.payload }

    case 'SET_DENSITY':
      return { ...state, density: action.payload }

    case 'LOAD_VIEW':
      return {
        ...state,
        ...(action.payload.state ?? {}),
        // Never load another view's selection or expansion — those are transient
        rowSelection: {},
        expanded:     {},
      }

    case 'RESET_FILTERS':
      return {
        ...state,
        columnFilters: [],
        globalFilter:  '',
        pagination:    { ...state.pagination, pageIndex: 0 },
      }

    case 'RESET_SORTING':
      return { ...state, sorting: [] }

    case 'RESET_COLUMN_VISIBILITY':
      return { ...state, columnVisibility: {} }

    case 'SET_PAGE_SIZE':
      return {
        ...state,
        pagination: { pageIndex: 0, pageSize: action.payload },
      }

    case 'NEXT_PAGE':
      return {
        ...state,
        pagination: {
          ...state.pagination,
          pageIndex: state.pagination.pageIndex + 1,
        },
      }

    case 'PREV_PAGE':
      return {
        ...state,
        pagination: {
          ...state.pagination,
          pageIndex: Math.max(0, state.pagination.pageIndex - 1),
        },
      }

    case 'GO_TO_PAGE':
      return {
        ...state,
        pagination: { ...state.pagination, pageIndex: action.payload },
      }

    case 'SELECT_ALL_ROWS':
      return { ...state, rowSelection: action.payload }

    case 'CLEAR_SELECTION':
      return { ...state, rowSelection: {} }

    case 'TOGGLE_GROUP': {
      const current  = state.grouping ?? []
      const existing = current.indexOf(action.payload)
      const next     = existing >= 0
        ? current.filter(g => g !== action.payload)
        : [...current, action.payload]
      return { ...state, grouping: next }
    }

    default:
      return state
  }
}

// ── State serialization ───────────────────────────────────────────────────────
// Serialize to URL-safe string for shareable table views.

export function serializeTableState(state: AnalyticsTableState): string {
  const compact = {
    s:  state.sorting.map(s => `${s.id}:${s.desc ? 'd' : 'a'}`),
    f:  state.columnFilters.map(f => `${f.id}:${JSON.stringify(f.value)}`),
    v:  Object.entries(state.columnVisibility).filter(([,v]) => !v).map(([k]) => k),
    p:  `${state.pagination.pageIndex}:${state.pagination.pageSize}`,
    d:  state.density,
    g:  state.grouping,
    gf: state.globalFilter || undefined,
  }
  return btoa(JSON.stringify(compact))
}

export function deserializeTableState(encoded: string): PartialTableState {
  try {
    const compact = JSON.parse(atob(encoded)) as {
      s?:  string[]
      f?:  string[]
      v?:  string[]
      p?:  string
      d?:  TableDensity
      g?:  string[]
      gf?: string
    }

    const [pageIndex, pageSize] = (compact.p ?? '0:50').split(':').map(Number)

    return {
      sorting: (compact.s ?? []).map(s => {
        const [id, dir] = s.split(':')
        return { id, desc: dir === 'd' }
      }),
      columnFilters: (compact.f ?? []).map(f => {
        const colonIdx = f.indexOf(':')
        return { id: f.slice(0, colonIdx), value: JSON.parse(f.slice(colonIdx + 1)) }
      }),
      columnVisibility: Object.fromEntries((compact.v ?? []).map(k => [k, false])),
      pagination:   { pageIndex: pageIndex || 0, pageSize: pageSize || 50 },
      density:      compact.d ?? 'standard',
      grouping:     compact.g ?? [],
      globalFilter: compact.gf ?? '',
    }
  } catch {
    return {}
  }
}

// ── localStorage persistence ──────────────────────────────────────────────────

const STORAGE_VERSION = 'v1'

export function persistTableState(tableId: string, state: AnalyticsTableState): void {
  if (typeof localStorage === 'undefined') return
  try {
    const key = `et-table:${STORAGE_VERSION}:${tableId}`
    // Persist only non-transient state — never selection or expansion
    const toSave: PartialTableState = {
      sorting:          state.sorting,
      columnFilters:    state.columnFilters,
      columnVisibility: state.columnVisibility,
      columnOrder:      state.columnOrder,
      columnPinning:    state.columnPinning,
      columnSizing:     state.columnSizing,
      pagination:       { pageIndex: 0, pageSize: state.pagination.pageSize },
      density:          state.density,
      grouping:         state.grouping,
    }
    localStorage.setItem(key, JSON.stringify(toSave))
  } catch { /* quota exceeded — silent fail */ }
}

export function loadTableState(tableId: string): PartialTableState {
  if (typeof localStorage === 'undefined') return {}
  try {
    const key  = `et-table:${STORAGE_VERSION}:${tableId}`
    const raw  = localStorage.getItem(key)
    if (!raw) return {}
    return JSON.parse(raw) as PartialTableState
  } catch { return {} }
}

export function clearTableState(tableId: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(`et-table:${STORAGE_VERSION}:${tableId}`)
}
