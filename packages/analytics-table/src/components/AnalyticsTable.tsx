'use client'

/**
 * AnalyticsTable — main table component
 *
 * Assembles: TableToolbar + TableHeader + TableDataStateRenderer + TableBody
 * All virtualization, RTL, density, and state is handled by useAnalyticsTable.
 *
 * Props:
 *   All config from useAnalyticsTable +
 *   onRowClick, title, actions, containerHeight, hidePagination
 *
 * The component owns no internal state — caller passes `config` from
 * useAnalyticsTable or this component manages it internally (default mode).
 */

import { useRef, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { useAnalyticsTable, type UseAnalyticsTableConfig } from '../hooks/useAnalyticsTable'
import { useExport }                                       from '../hooks/useExport'
import { TableHeader }                                     from './TableHeader'
import { TableBody }                                       from './TableBody'
import { TableToolbar }                                    from './TableToolbar'
import { TableDataStateRenderer }                          from './TableStates'
import { DENSITY_CONFIG }                                  from '../core/types'
import type { AnalyticsRow, TableDensity }                 from '../core/types'
import type { SupportedLocale }                            from '@/lib/formatters'
import type { Row }                                        from '@tanstack/react-table'

// ── Pagination bar ────────────────────────────────────────────────────────────

function PaginationBar<TRow extends AnalyticsRow>({
  table,
  locale,
}: {
  table:  ReturnType<typeof useAnalyticsTable<TRow>>['table']
  locale: SupportedLocale
}) {
  const isAr      = locale.startsWith('ar')
  const { pageIndex, pageSize } = table.getState().pagination
  const pageCount = table.getPageCount()
  const canPrev   = table.getCanPreviousPage()
  const canNext   = table.getCanNextPage()

  const fmt = (n: number) => n.toLocaleString(isAr ? 'ar-SA-u-nu-latn' : 'en-SA')

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2 border-t border-border-default bg-bg-default text-xs',
        isAr && 'flex-row-reverse',
      )}
      role="navigation"
      aria-label={isAr ? 'تصفح الصفحات' : 'Table pagination'}
    >
      <button
        onClick={() => table.setPageIndex(0)}
        disabled={!canPrev}
        className="px-2 py-1 rounded border border-border-default text-text-secondary hover:bg-bg-subtle disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label={isAr ? 'الصفحة الأولى' : 'First page'}
      >
        {isAr ? '»' : '«'}
      </button>
      <button
        onClick={() => table.previousPage()}
        disabled={!canPrev}
        className="px-2 py-1 rounded border border-border-default text-text-secondary hover:bg-bg-subtle disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label={isAr ? 'الصفحة السابقة' : 'Previous page'}
      >
        {isAr ? '›' : '‹'}
      </button>

      <span className={cn('text-text-secondary font-number tabular-nums', isAr ? 'font-ui-ar' : 'font-ui-en')} dir="ltr">
        {isAr
          ? `صفحة ${fmt(pageIndex + 1)} من ${pageCount > 0 ? fmt(pageCount) : '…'}`
          : `Page ${fmt(pageIndex + 1)} of ${pageCount > 0 ? fmt(pageCount) : '…'}`}
      </span>

      <button
        onClick={() => table.nextPage()}
        disabled={!canNext}
        className="px-2 py-1 rounded border border-border-default text-text-secondary hover:bg-bg-subtle disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label={isAr ? 'الصفحة التالية' : 'Next page'}
      >
        {isAr ? '‹' : '›'}
      </button>
      <button
        onClick={() => table.setPageIndex(pageCount - 1)}
        disabled={!canNext}
        className="px-2 py-1 rounded border border-border-default text-text-secondary hover:bg-bg-subtle disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label={isAr ? 'الصفحة الأخيرة' : 'Last page'}
      >
        {isAr ? '«' : '»'}
      </button>

      <div className="flex-1" />

      {/* Page size selector */}
      <label className={cn('text-text-tertiary flex items-center gap-1', isAr ? 'flex-row-reverse font-ui-ar' : 'font-ui-en')}>
        {isAr ? 'صفوف:' : 'Rows:'}
        <select
          value={pageSize}
          onChange={e => table.setPageSize(Number(e.target.value))}
          className="rounded border border-border-default bg-bg-default text-text-primary px-1 py-0.5 text-xs font-number"
          dir="ltr"
        >
          {[25, 50, 100, 200].map(n => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export interface AnalyticsTableProps<TRow extends AnalyticsRow>
  extends UseAnalyticsTableConfig<TRow> {
  /** Max height of the scroll container. Default: 600px */
  containerHeight?: number | string
  /** Hide pagination bar (e.g. infinite scroll or server streaming) */
  hidePagination?:  boolean
  onRowClick?:      (row: Row<TRow>) => void
  title?:           string
  /** Optional error message when dataState === 'error' */
  errorMessage?:    string
  onRetry?:         () => void
  /** Extra toolbar actions (React nodes) */
  actions?:         React.ReactNode
  className?:       string
}

export function AnalyticsTable<TRow extends AnalyticsRow>({
  containerHeight = 600,
  hidePagination  = false,
  onRowClick,
  title,
  errorMessage,
  onRetry,
  actions,
  className,
  ...config
}: AnalyticsTableProps<TRow>) {
  const containerRef = useRef<HTMLDivElement>(null)

  const analyticsTable = useAnalyticsTable<TRow>({
    ...config,
    containerWidth: containerRef.current?.clientWidth ?? 1200,
  })

  const {
    table, state, dispatch, dataState, locale, direction,
    scrollRef, virtualRows, totalRowsHeight,
    isRowVirt, setDensity, resetFilters, clearSelection,
  } = analyticsTable

  const { exportCsv, exportJson, status: exportStatus } = useExport({
    table,
    filename: title?.toLowerCase().replace(/\s+/g, '-') ?? 'easytrac',
  })

  const visibleLeafCount = table.getVisibleLeafColumns().length
  const rowModel         = table.getRowModel()

  // Set row height CSS variable on the scroll container
  const rowHeight = DENSITY_CONFIG[state.density].rowHeight
  const cssVars: CSSProperties = {
    '--table-row-height': `${rowHeight}px`,
    height: typeof containerHeight === 'number' ? `${containerHeight}px` : containerHeight,
  } as CSSProperties

  return (
    <div
      ref={containerRef}
      dir={direction}
      className={cn('flex flex-col border border-border-default rounded-lg overflow-hidden bg-bg-default', className)}
    >
      {/* Toolbar */}
      <TableToolbar
        table={table}
        locale={locale}
        density={state.density}
        onDensityChange={setDensity}
        onExportCsv={exportCsv}
        onExportJson={exportJson}
        onResetFilters={resetFilters}
        rowCount={rowModel.rows.length}
        totalCount={config.rowCount}
        isExporting={exportStatus === 'exporting'}
        title={title}
        actions={actions}
      />

      {/* Data states + table */}
      <div ref={scrollRef} className="overflow-auto flex-1" style={cssVars}>
        <TableDataStateRenderer
          dataState={dataState}
          locale={locale}
          columns={visibleLeafCount}
          onRetry={onRetry}
          onClearFilters={resetFilters}
          error={errorMessage}
        >
          <table
            className="w-full border-collapse table-fixed"
            style={{ minWidth: table.getTotalSize() }}
            role="grid"
            aria-rowcount={config.rowCount ?? rowModel.rows.length}
          >
            <TableHeader table={table} locale={locale} />
            <TableBody
              table={table}
              density={state.density}
              locale={locale}
              isVirtualized={isRowVirt}
              virtualRows={virtualRows}
              totalHeight={totalRowsHeight}
              onRowClick={onRowClick}
            />
          </table>
        </TableDataStateRenderer>
      </div>

      {/* Pagination */}
      {!hidePagination && <PaginationBar table={table} locale={locale} />}
    </div>
  )
}
