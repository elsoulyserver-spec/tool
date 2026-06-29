'use client'

import { flexRender, type Header, type Table, type HeaderGroup } from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import type { AnalyticsRow } from '../core/types'
import type { SupportedLocale } from '@/lib/formatters'

// ── Sort indicator ────────────────────────────────────────────────────────────

function SortIndicator({ sorted }: { sorted: false | 'asc' | 'desc' }) {
  if (!sorted) return <span className="opacity-30 text-text-tertiary" aria-hidden="true">⇅</span>
  return (
    <span className="text-action-primary" aria-hidden="true">
      {sorted === 'asc' ? '↑' : '↓'}
    </span>
  )
}

// ── Resize handle ─────────────────────────────────────────────────────────────

function ResizeHandle<TRow extends AnalyticsRow>({ header }: { header: Header<TRow, unknown> }) {
  if (!header.column.getCanResize()) return null
  return (
    <div
      onMouseDown={header.getResizeHandler()}
      onTouchStart={header.getResizeHandler()}
      className={cn(
        'absolute inset-y-0 end-0 w-1 cursor-col-resize select-none touch-none z-10',
        'hover:bg-action-primary',
        header.column.getIsResizing() && 'bg-action-primary',
      )}
      aria-hidden="true"
    />
  )
}

// ── Header cell ───────────────────────────────────────────────────────────────

function HeaderCell<TRow extends AnalyticsRow>({
  header,
  locale,
}: {
  header: Header<TRow, unknown>
  locale: SupportedLocale
}) {
  const isAr    = locale.startsWith('ar')
  const meta    = header.column.columnDef.meta?.analytics
  const canSort = header.column.getCanSort()
  const sorted  = header.column.getIsSorted()
  const align   = meta?.align ?? 'start'

  const labelAr = meta?.labelAr
  const label   = flexRender(header.column.columnDef.header, header.getContext())
  const displayLabel = isAr && labelAr ? labelAr : label

  return (
    <th
      key={header.id}
      colSpan={header.colSpan}
      style={{ width: header.getSize(), minWidth: meta?.minWidth ?? 60 }}
      className={cn(
        'relative px-3 py-2 border-b border-border-default bg-bg-subtle',
        'select-none text-text-secondary font-semibold text-xs whitespace-nowrap',
        canSort && 'cursor-pointer hover:text-text-primary',
        align === 'end'    && 'text-end',
        align === 'center' && 'text-center',
        header.column.getIsPinned() && 'sticky z-10',
        header.column.getIsPinned() === 'left'  && 'start-0 shadow-[2px_0_4px_-2px_var(--semantic-shadow-sm)]',
        header.column.getIsPinned() === 'right' && 'end-0  shadow-[-2px_0_4px_-2px_var(--semantic-shadow-sm)]',
      )}
      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
      aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}
      dir={isAr && labelAr ? 'rtl' : 'ltr'}
    >
      <span className={cn(
        'inline-flex items-center gap-1',
        isAr && labelAr ? 'font-ui-ar flex-row-reverse' : 'font-ui-en',
      )}>
        {displayLabel}
        {canSort && <SortIndicator sorted={sorted} />}
      </span>
      <ResizeHandle header={header} />
    </th>
  )
}

// ── Header row ────────────────────────────────────────────────────────────────

function HeaderRow<TRow extends AnalyticsRow>({
  headerGroup,
  locale,
}: {
  headerGroup: HeaderGroup<TRow>
  locale:      SupportedLocale
}) {
  return (
    <tr key={headerGroup.id}>
      {headerGroup.headers.map(header =>
        header.isPlaceholder ? (
          <th key={header.id} style={{ width: header.getSize() }} className="bg-bg-subtle border-b border-border-default" />
        ) : (
          <HeaderCell key={header.id} header={header} locale={locale} />
        ),
      )}
    </tr>
  )
}

// ── Public component ──────────────────────────────────────────────────────────

export interface TableHeaderProps<TRow extends AnalyticsRow> {
  table:  Table<TRow>
  locale: SupportedLocale
}

export function TableHeader<TRow extends AnalyticsRow>({ table, locale }: TableHeaderProps<TRow>) {
  return (
    <thead className="sticky top-0 z-20">
      {table.getHeaderGroups().map(hg => (
        <HeaderRow key={hg.id} headerGroup={hg} locale={locale} />
      ))}
    </thead>
  )
}
