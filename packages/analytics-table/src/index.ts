// Easy Track Analytics Table — Public API
// All internal modules are private — import only from this barrel.

// Core types
export type {
  AnalyticsRow,
  ColumnValueType,
  AnalyticsColumnMeta,
  TableDensity,
  TableMode,
  Direction,
  TableDataState,
  AnalyticsTableState,
  ServerCallbacks,
  SavedView,
  SparklineData,
  AttributionBreakdown,
  HealthScore,
} from './core/types'

export { DENSITY_CONFIG, PERF_THRESHOLDS, MEMORY_BUDGETS, AR_MIN_FONT_SIZE } from './core/types'

// Engine
export {
  createAnalyticsColumnHelper,
  adaptPinningForDirection,
  assertModeForRowCount,
  buildTableOptions,
} from './core/engine'

// State
export {
  tableStateReducer,
  DEFAULT_TABLE_STATE,
  serializeTableState,
  deserializeTableState,
  persistTableState,
  loadTableState,
  clearTableState,
} from './core/state'
export type { TableAction } from './core/state'

// Virtualizer
export { useRowVirtualizer, useColVirtualizer, SparseRowModel } from './virtualization/row-virtualizer'

// Column factories
export {
  colText,
  colNumber,
  colCurrency,
  colPercent,
  colROAS,
  colDelta,
  colEventName,
  colPlatform,
  colTimestamp,
  colStatus,
  colHealth,
  colSparkline,
  colId,
  colAttribution,
  eventsTableColumns,
  attributionTableColumns,
  auditTableColumns,
} from './columns/analytics-columns'

// Cell renderers
export {
  CurrencyCell,
  PercentageCell,
  ROASCell,
  DeltaCell,
  EventNameCell,
  PlatformCell,
  TimestampCell,
  StatusCell,
  HealthCell,
  SparklineCell,
  IdCell,
  AttributionCell,
  TextCell,
  NumberCell,
  AnalyticsCellRenderer,
} from './cells'

// Hooks
export { useAnalyticsTable } from './hooks/useAnalyticsTable'
export { useExport }         from './hooks/useExport'
export type { UseAnalyticsTableConfig, UseAnalyticsTableResult } from './hooks/useAnalyticsTable'
export type { UseExportConfig, UseExportResult, ExportFormat, ExportStatus } from './hooks/useExport'

// Components
export { AnalyticsTable }    from './components/AnalyticsTable'
export { TableHeader }       from './components/TableHeader'
export { TableBody }         from './components/TableBody'
export { TableToolbar }      from './components/TableToolbar'
export {
  TableDataStateRenderer,
  LoadingState,
  LoadingMoreState,
  ErrorState,
  EmptyState,
  StaleDataBanner,
  OfflineState,
  PartialDataBanner,
} from './components/TableStates'
export type { AnalyticsTableProps } from './components/AnalyticsTable'
