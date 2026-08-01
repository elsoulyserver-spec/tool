'use client'

import { flexRender, type Table, type Row, type Cell } from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import { AnalyticsCellRenderer } from '../cells'
import type { AnalyticsRow, TableDensity, DENSITY_CONFIG as DC } from '../core/types'
import { DENSITY_CONFIG } from '../core/types'
import type { SupportedLocale } from '@/lib/formatters'

// ── Types ─────────────────────────────────────────────────────────────────────

interface VirtualItem {
  index:  number
  start:  number
  size:   number
  key:    string | number
}

// ── Single cell ───────────────────────────────────────────────────────────────

function BodyCell<TRow extends AnalyticsRow>({
  cell,
  locale,
}: {
  cell:   Cell<TRow, unknown>
  locale: SupportedLocale
}) {
  const meta    = cell.column.columnDef.meta?.analytics
  const isPinned= cell.column.getIsPinned()
  const align   = meta?.align ?? 'start'

  return (
    <td
      key={cell.id}
      style={{
        width:    cell.column.getSize(),
        minWidth: meta?.minWidth ?? 60,
        ...(isPinned === 'left'  ? { left:  cell.column.getStart('left')  } : {}),
        ...(isPinned === 'right' ? { right: cell.column.getAfter('right') } : {}),
      }}
      className={cn(
        'border-b border-border-default overflow-hidden',
        'group-hover:bg-bg-subtle',
        isPinned && 'sticky z-[5] bg-bg-default',
        isPinned === 'left'  && 'shadow-[2px_0_4px_-2px_var(--semantic-shadow-sm)]',
        isPinned === 'right' && 'shadow-[-2px_0_4px_-2px_var(--semantic-shadow-sm)]',
        align === 'end'    && 'text-end',
        align === 'center' && 'text-center',
      )}
    >
      <AnalyticsCellRenderer cell={cell} locale={locale} />
    </td>
  )
}

// ── Single row ────────────────────────────────────────────────────────────────

function BodyRow<TRow extends AnalyticsRow>({
  row,
  density,
  locale,
  isSelected,
  onClick,
  style,
}: {
  row:        Row<TRow>
  density:    TableDensity
  locale:     SupportedLocale
  isSelected: boolean
  onClick?:   (row: Row<TRow>) => void
  style?:     React.CSSProperties
}) {
  const { rowHeight } = DENSITY_CONFIG[density]

  return (
    <tr
      key={row.id}
      style={{ height: rowHeight, ...style }}
      className={cn(
        'group transition-colors',
        isSelected && 'bg-action-selected',
        onClick && 'cursor-pointer',
      )}
      onClick={onClick ? () => onClick(row) : undefined}
      aria-selected={isSelected}
      data-row-index={row.index}
    >
      {row.getVisibleCells().map(cell => (
        <BodyCell key={cell.id} cell={cell} locale={locale} />
      ))}
    </tr>
  )
}

// ── Public component ──────────────────────────────────────────────────────────

export interface TableBodyProps<TRow extends AnalyticsRow> {
  table:       Table<TRow>
  density:     TableDensity
  locale:      SupportedLocale
  isVirtualized: boolean
  virtualRows:   VirtualItem[]
  totalHeight:   number
  onRowClick?:   (row: Row<TRow>) => void
}

export function TableBody<TRow extends AnalyticsRow>({
  table,
  density,
  locale,
  isVirtualized,
  virtualRows,
  totalHeight,
  onRowClick,
}: TableBodyProps<TRow>) {
  const rows = table.getRowModel().rows

  if (!isVirtualized) {
    // Non-virtualized — render all rows
    return (
      <tbody>
        {rows.map(row => (
          <BodyRow
            key={row.id}
            row={row}
            density={density}
            locale={locale}
            isSelected={row.getIsSelected()}
            onClick={onRowClick}
          />
        ))}
      </tbody>
    )
  }

  // Virtualized — padding spacers + visible rows only
  const { rowHeight } = DENSITY_CONFIG[density]
  const topPad    = virtualRows[0]?.start ?? 0
  const bottomPad = totalHeight - (virtualRows.at(-1)?.start ?? 0) - rowHeight

  return (
    <tbody>
      {/* Top spacer — fills the space above visible rows */}
      {topPad > 0 && (
        <tr aria-hidden="true">
          <td style={{ height: topPad, padding: 0, border: 'none' }} colSpan={table.getAllLeafColumns().length} />
        </tr>
      )}

      {virtualRows.map(vRow => {
        const row = rows[vRow.index]
        if (!row) return null
        return (
          <BodyRow
            key={row.id}
            row={row}
            density={density}
            locale={locale}
            isSelected={row.getIsSelected()}
            onClick={onRowClick}
          />
        )
      })}

      {/* Bottom spacer */}
      {bottomPad > 0 && (
        <tr aria-hidden="true">
          <td style={{ height: bottomPad, padding: 0, border: 'none' }} colSpan={table.getAllLeafColumns().length} />
        </tr>
      )}
    </tbody>
  )
}
