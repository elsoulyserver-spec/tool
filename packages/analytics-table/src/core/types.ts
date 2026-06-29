/**
 * Easy Track Analytics Table — Core Type System
 *
 * Design rules:
 *  - All row data extends AnalyticsRow — never use `any`
 *  - Column types are discriminated unions — exhaustive switch enforced by TS
 *  - TableMode drives which features are available (client/server/hybrid)
 *  - Direction is explicit on every interface — no ambient RTL detection
 *  - Performance budgets are typed constants, not magic numbers
 */

import type {
  ColumnDef,
  RowData,
  TableOptions,
  Table,
  Row,
  Column,
  Header,
  Cell,
  SortingState,
  ColumnFiltersState,
  VisibilityState,
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  ExpandedState,
  GroupingState,
  PaginationState,
  RowSelectionState,
} from '@tanstack/react-table'
import type { SupportedLocale } from '@easytrac/design-tokens'

// ── Direction ─────────────────────────────────────────────────────────────────

export type Direction = 'ltr' | 'rtl'

// ── Table mode ────────────────────────────────────────────────────────────────

export type TableMode =
  | 'client'    // all data in memory — up to 100K rows safely
  | 'server'    // pagination/sorting/filtering delegated to API
  | 'hybrid'    // data cached locally, cursor-paginated from server

// ── Row data contract ─────────────────────────────────────────────────────────

export interface AnalyticsRow {
  /** Required: stable unique identifier for row identity + keying */
  id: string
  /** Optional: ISO 8601 timestamp of the data point */
  timestamp?: string
  /** Optional: row-level metadata (platform, segment, etc.) */
  meta?: Record<string, unknown>
}

// ── Column value types ────────────────────────────────────────────────────────
// Discriminated union — every cell renderer knows exactly what value it gets

export type ColumnValueType =
  | 'text'         // plain string, locale-aware
  | 'number'       // raw number — rendered as Integer
  | 'currency'     // { amount: number; currency: CurrencyCode }
  | 'percentage'   // decimal 0–1 (e.g. 0.9843) or raw (e.g. 98.43)
  | 'roas'         // number multiplier (e.g. 4.78)
  | 'delta'        // signed percentage change (e.g. +18.4% / -3.2%)
  | 'event-name'   // platform event identifier string
  | 'platform'     // platform badge (ga4 | meta | tiktok | ...)
  | 'status'       // status enum string
  | 'health'       // 0–100 health score
  | 'timestamp'    // ISO 8601 string
  | 'relative-time'// relative time string from ISO timestamp
  | 'boolean'      // boolean value
  | 'id'           // technical identifier (monospace)
  | 'url'          // URL string (monospace, truncated)
  | 'sparkline'    // number[] — mini trend chart
  | 'attribution'  // attribution breakdown object
  | 'json'         // arbitrary JSON — collapsible
  | 'custom'       // escape hatch — caller provides render fn

// ── Analytics column definition ───────────────────────────────────────────────

export interface AnalyticsColumnMeta {
  /** Display label in current locale */
  label:        string
  labelAr?:     string           // Arabic label override
  /** Value type drives cell renderer selection */
  valueType:    ColumnValueType
  /** Column group for header grouping */
  group?:       string
  groupAr?:     string
  /** Alignment — always 'end' for numeric types */
  align?:       'start' | 'center' | 'end'
  /** Cell direction override — numbers always 'ltr' */
  cellDir?:     Direction
  /** Locale for Intl formatting */
  locale?:      SupportedLocale
  /** Format options passed to cell renderer */
  format?:      ColumnFormatOptions
  /** Whether this column is sortable server-side */
  serverSort?:  boolean
  /** Whether this column is filterable */
  filterable?:  boolean
  /** Whether to show this column in column visibility panel */
  hideable?:    boolean
  /** Pin position — always set server-side to avoid CLS */
  defaultPin?:  'left' | 'right' | false
  /** Minimum column width in px */
  minWidth?:    number
  /** Default column width in px */
  defaultWidth?: number
  /** Whether content wraps (false = truncate + tooltip) */
  wrap?:        boolean
  /** Tooltip accessor — string key or fn */
  tooltip?:     string | ((value: unknown) => string)
  /** Sparkline data key — only for 'sparkline' type */
  sparklineKey?: string
  /** Description for screen readers */
  description?: string
}

export interface ColumnFormatOptions {
  decimals?:             number
  currency?:             string
  compact?:              boolean
  showSign?:             boolean
  colorCode?:            boolean
  positiveIsGood?:       boolean
  showBadge?:            boolean
  maxLength?:            number
  dateStyle?:            Intl.DateTimeFormatOptions['dateStyle']
  timeStyle?:            Intl.DateTimeFormatOptions['timeStyle']
  asDecimal?:            boolean   // percentage: true = input is 0.98, false = input is 98
}

// Augment TanStack's ColumnMeta with our typed meta
declare module '@tanstack/react-table' {
  interface ColumnMeta<TData extends RowData, TValue> {
    analytics: AnalyticsColumnMeta
  }
}

// ── Density modes ─────────────────────────────────────────────────────────────

export type TableDensity = 'comfortable' | 'standard' | 'compact' | 'dense'

export const DENSITY_CONFIG: Record<TableDensity, {
  rowHeight:   number   // px — FIXED, required for virtualizer
  fontSize:    number   // px
  paddingBlock:number   // px
  paddingInline:number  // px
}> = {
  comfortable: { rowHeight: 44, fontSize: 13, paddingBlock: 10, paddingInline: 14 },
  standard:    { rowHeight: 36, fontSize: 13, paddingBlock:  7, paddingInline: 12 },
  compact:     { rowHeight: 32, fontSize: 12, paddingBlock:  6, paddingInline: 10 },
  dense:       { rowHeight: 28, fontSize: 12, paddingBlock:  4, paddingInline:  8 },
}

// Arabic minimum font-size override — enforced regardless of density
export const AR_MIN_FONT_SIZE = 13  // px — WCAG + readability requirement

// ── Table state ───────────────────────────────────────────────────────────────

export interface AnalyticsTableState {
  sorting:         SortingState
  columnFilters:   ColumnFiltersState
  columnVisibility:VisibilityState
  columnOrder:     ColumnOrderState
  columnPinning:   ColumnPinningState
  columnSizing:    ColumnSizingState
  expanded:        ExpandedState
  grouping:        GroupingState
  pagination:      PaginationState
  rowSelection:    RowSelectionState
  globalFilter:    string
  density:         TableDensity
}

export type PartialTableState = Partial<AnalyticsTableState>

// ── Server-side callbacks ─────────────────────────────────────────────────────

export interface ServerCallbacks<TRow extends AnalyticsRow> {
  onSortingChange?:   (sorting: SortingState) => Promise<void> | void
  onFilterChange?:    (filters: ColumnFiltersState) => Promise<void> | void
  onPageChange?:      (pagination: PaginationState) => Promise<void> | void
  onGlobalFilter?:    (value: string) => Promise<void> | void
  fetchPage?:         (params: ServerFetchParams) => Promise<ServerPage<TRow>>
  fetchCount?:        (params: Omit<ServerFetchParams, 'page' | 'pageSize'>) => Promise<number>
}

export interface ServerFetchParams {
  page:       number
  pageSize:   number
  sorting:    SortingState
  filters:    ColumnFiltersState
  globalFilter:string
  groupBy?:   string[]
}

export interface ServerPage<TRow> {
  rows:       TRow[]
  totalCount: number
  pageCount:  number
  cursor?:    string   // for cursor-based pagination
  staleAfter?:number  // ms until data is considered stale
}

// ── Table data states ─────────────────────────────────────────────────────────

export type TableDataState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loading-more'; currentCount: number }
  | { status: 'error'; error: Error; retryable: boolean }
  | { status: 'empty'; reason: 'no-data' | 'filtered' | 'permission' }
  | { status: 'stale'; lastUpdated: Date; age: number }
  | { status: 'partial'; loadedCount: number; totalCount: number }
  | { status: 'live'; rowCount: number; lastUpdated: Date }
  | { status: 'offline' }

// ── Saved views ───────────────────────────────────────────────────────────────

export interface SavedView {
  id:          string
  name:        string
  nameAr?:     string
  description?:string
  createdAt:   string
  updatedAt:   string
  ownerId:     string
  isShared:    boolean
  isDefault:   boolean
  state:       PartialTableState
  columns:     string[]   // ordered visible column ids
}

// ── Export ────────────────────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'excel' | 'json' | 'clipboard'

export interface ExportOptions {
  format:          ExportFormat
  filename?:       string
  columns?:        string[]     // subset of column ids; defaults to visible
  locale:          SupportedLocale
  includeHeaders?: boolean
  /** For large exports — triggers server-side job instead of client */
  serverSide?:     boolean
  /** Row limit before forcing server-side export */
  clientSideLimit?: number      // default: 50_000
}

export interface ExportJob {
  jobId:    string
  status:   'queued' | 'processing' | 'complete' | 'failed'
  progress: number  // 0–100
  url?:     string  // download URL when complete
  error?:   string
}

// ── Virtualization config ─────────────────────────────────────────────────────

export interface VirtualizationConfig {
  /** Row height in px — MUST match DENSITY_CONFIG */
  estimateSize:     (index: number) => number
  /** Number of rows to render outside visible area */
  overscan:         number
  /** Scroll container element ref */
  scrollElement?:   HTMLElement | null
  /** Enable horizontal (column) virtualization */
  horizontalVirt:   boolean
  /** Minimum columns to show before horizontal virt kicks in */
  horizontalThreshold: number
}

/** Performance thresholds that gate feature availability */
export const PERF_THRESHOLDS = {
  /** Max rows for DOM rendering without virtualization */
  VIRT_REQUIRED:     500,
  /** Max rows for client-side sorting/filtering */
  CLIENT_MAX:      100_000,
  /** Force server-side above this count */
  SERVER_REQUIRED: 500_000,
  /** Max rows for client-side CSV export */
  CLIENT_EXPORT_MAX: 50_000,
  /** Overscan rows for standard virtualization */
  OVERSCAN_DEFAULT:  10,
  /** Overscan rows for fast scroll (reduced) */
  OVERSCAN_FAST:     5,
  /** Column overscan */
  COL_OVERSCAN:      2,
} as const

/** Memory budgets per row count tier */
export const MEMORY_BUDGETS = {
  ROWS_100K:  { heapMB: 50,  recommendation: 'client mode, full client-side features' },
  ROWS_1M:    { heapMB: 80,  recommendation: 'server mode, cursor pagination, sparse row model' },
  ROWS_10M:   { heapMB: 100, recommendation: 'server mode, streaming cursor, background export only' },
} as const

// ── Attribution types ─────────────────────────────────────────────────────────

export interface AttributionBreakdown {
  platform:    string
  channel:     string
  touchpoints: number
  weight:      number   // 0–1
  revenue:     number
  model:       'last-click' | 'linear' | 'time-decay' | 'data-driven'
}

// ── Sparkline types ───────────────────────────────────────────────────────────

export interface SparklineData {
  values:    number[]
  trend:     'up' | 'down' | 'flat'
  delta?:    number   // most recent vs previous period
}

// ── Health score ──────────────────────────────────────────────────────────────

export interface HealthScore {
  score:   number   // 0–100
  label?:  string
  issues?: string[]
}

// ── Column preset ─────────────────────────────────────────────────────────────

export interface TablePreset {
  id:      string
  name:    string
  nameAr?: string
  columns: string[]        // ordered column ids
  state:   PartialTableState
}

// ── Re-export TanStack types needed by consumers ──────────────────────────────

export type {
  ColumnDef,
  Table,
  Row,
  Column,
  Header,
  Cell,
  SortingState,
  ColumnFiltersState,
  VisibilityState,
  PaginationState,
  RowSelectionState,
}
