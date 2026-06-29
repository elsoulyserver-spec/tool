'use client'

import { type Table } from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import type { AnalyticsRow, TableDensity } from '../core/types'
import type { SupportedLocale } from '@/lib/formatters'

const DENSITY_OPTIONS: { value: TableDensity; labelEn: string; labelAr: string }[] = [
  { value: 'comfortable', labelEn: 'Comfortable', labelAr: 'مريح' },
  { value: 'standard',    labelEn: 'Standard',    labelAr: 'عادي' },
  { value: 'compact',     labelEn: 'Compact',     labelAr: 'مضغوط' },
  { value: 'dense',       labelEn: 'Dense',       labelAr: 'كثيف' },
]

interface ToolbarButtonProps {
  onClick:    () => void
  children:   React.ReactNode
  active?:    boolean
  className?: string
  title?:     string
}

function ToolbarButton({ onClick, children, active, className, title }: ToolbarButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'px-2.5 py-1 rounded text-xs font-semibold font-ui-en transition-colors',
        'border border-border-default',
        active
          ? 'bg-action-primary text-action-primary-text border-action-primary'
          : 'bg-bg-default text-text-secondary hover:bg-bg-subtle hover:text-text-primary',
        className,
      )}
      aria-pressed={active}
    >
      {children}
    </button>
  )
}

export interface TableToolbarProps<TRow extends AnalyticsRow> {
  table:          Table<TRow>
  locale:         SupportedLocale
  density:        TableDensity
  onDensityChange:(d: TableDensity) => void
  onExportCsv?:   () => void
  onExportJson?:  () => void
  onResetFilters?:() => void
  rowCount?:      number
  totalCount?:    number
  isExporting?:   boolean
  title?:         string
  actions?:       React.ReactNode
}

export function TableToolbar<TRow extends AnalyticsRow>({
  table,
  locale,
  density,
  onDensityChange,
  onExportCsv,
  onExportJson,
  onResetFilters,
  rowCount,
  totalCount,
  isExporting,
  title,
  actions,
}: TableToolbarProps<TRow>) {
  const isAr        = locale.startsWith('ar')
  const activeFilters = table.getState().columnFilters.length +
                        (table.getState().globalFilter ? 1 : 0)
  const hiddenCols  = table.getAllLeafColumns().filter(c => !c.getIsVisible()).length

  const rowLabel = isAr
    ? `${(rowCount ?? table.getRowModel().rows.length).toLocaleString('ar-SA-u-nu-latn')} صف`
    : `${(rowCount ?? table.getRowModel().rows.length).toLocaleString('en-SA')} rows`

  const totalLabel = totalCount
    ? isAr
      ? `من ${totalCount.toLocaleString('ar-SA-u-nu-latn')}`
      : `of ${totalCount.toLocaleString('en-SA')}`
    : ''

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2 border-b border-border-default bg-bg-default flex-wrap',
        isAr && 'flex-row-reverse',
      )}
      role="toolbar"
    >
      {/* Title */}
      {title && (
        <span className={cn('text-sm font-semibold text-text-primary me-2', isAr ? 'font-ui-ar' : 'font-ui-en')}>
          {title}
        </span>
      )}

      {/* Row count */}
      <span
        className="text-xs text-text-tertiary font-number tabular-nums"
        dir="ltr"
        aria-live="polite"
      >
        {rowLabel} {totalLabel}
      </span>

      <div className="flex-1" />

      {/* Custom actions */}
      {actions}

      {/* Active filters badge */}
      {activeFilters > 0 && onResetFilters && (
        <button
          onClick={onResetFilters}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold',
            'bg-status-warning text-status-warning-text border border-status-warning',
            'hover:opacity-90 transition-opacity',
            isAr ? 'font-ui-ar flex-row-reverse' : 'font-ui-en',
          )}
        >
          <span aria-hidden="true">✕</span>
          {isAr ? `${activeFilters} فلتر نشط` : `${activeFilters} active filter${activeFilters > 1 ? 's' : ''}`}
        </button>
      )}

      {/* Hidden columns badge */}
      {hiddenCols > 0 && (
        <button
          onClick={() => table.resetColumnVisibility()}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold',
            'bg-bg-subtle text-text-secondary border border-border-default',
            'hover:bg-bg-default transition-colors',
            isAr ? 'font-ui-ar flex-row-reverse' : 'font-ui-en',
          )}
        >
          {isAr ? `${hiddenCols} عمود مخفي` : `${hiddenCols} hidden col${hiddenCols > 1 ? 's' : ''}`}
        </button>
      )}

      {/* Density picker */}
      <div className="flex items-center rounded border border-border-default overflow-hidden">
        {DENSITY_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => onDensityChange(opt.value)}
            title={isAr ? opt.labelAr : opt.labelEn}
            aria-pressed={density === opt.value}
            className={cn(
              'px-2 py-1 text-xs font-ui-en transition-colors',
              density === opt.value
                ? 'bg-action-primary text-action-primary-text'
                : 'bg-bg-default text-text-tertiary hover:text-text-primary',
            )}
          >
            {/* Density icons as dot patterns */}
            {opt.value === 'comfortable' ? '⬛' :
             opt.value === 'standard'    ? '▬'  :
             opt.value === 'compact'     ? '━'  : '─'}
          </button>
        ))}
      </div>

      {/* Column visibility */}
      <ToolbarButton
        onClick={() => {/* Column picker panel opens via parent */}}
        title={isAr ? 'إخفاء/إظهار الأعمدة' : 'Column visibility'}
      >
        {isAr ? 'أعمدة' : 'Cols'}
      </ToolbarButton>

      {/* Export */}
      {(onExportCsv || onExportJson) && (
        <div className="flex items-center rounded border border-border-default overflow-hidden">
          {onExportCsv && (
            <ToolbarButton onClick={onExportCsv} className="border-0 rounded-none" title="Export CSV">
              {isExporting ? '…' : 'CSV'}
            </ToolbarButton>
          )}
          {onExportJson && onExportCsv && (
            <span className="w-px h-4 bg-border-default" aria-hidden="true" />
          )}
          {onExportJson && (
            <ToolbarButton onClick={onExportJson} className="border-0 rounded-none" title="Export JSON">
              {isExporting ? '…' : 'JSON'}
            </ToolbarButton>
          )}
        </div>
      )}
    </div>
  )
}
