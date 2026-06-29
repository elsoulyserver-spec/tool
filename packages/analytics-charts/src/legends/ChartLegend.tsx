'use client'

/**
 * PART 9 — Legend System
 *
 * ChartLegend:       standard interactive legend (click to hide/show series)
 * ComparisonLegend:  current vs previous period labels
 * GroupedLegend:     legend with group headers (e.g. "Paid" / "Organic")
 *
 * RTL: legend mirrors in rtl-aware charts.
 * Numbers: always Inter + tabular-nums + dir="ltr".
 * Arabic: IBM Plex Sans Arabic + min 13px.
 */

import { useCallback, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { formatNumber, formatCurrency, formatPercent } from '@/lib/formatters'
import type { LegendItem } from '../core/types'
import type { SupportedLocale } from '@/lib/formatters'

// ── Legend swatch ─────────────────────────────────────────────────────────────

function LegendSwatch({ color, hidden }: { color: string; hidden: boolean }) {
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0 transition-opacity"
      style={{ background: color, opacity: hidden ? 0.3 : 1 }}
      aria-hidden="true"
    />
  )
}

// ── Single item ───────────────────────────────────────────────────────────────

function LegendItemButton({
  item,
  locale,
  onToggle,
  showValue,
  valueFormat,
  currency,
}: {
  item:        LegendItem
  locale:      SupportedLocale
  onToggle?:   (id: string) => void
  showValue?:  boolean
  valueFormat?:'number' | 'currency' | 'percent'
  currency?:   string
}) {
  const isAr   = locale.startsWith('ar')
  const label  = isAr && item.labelAr ? item.labelAr : item.label
  const isDisabled = item.hidden

  const formattedValue = showValue && item.value != null
    ? valueFormat === 'currency' ? formatCurrency(item.value, locale, (currency ?? 'SAR') as any)
    : valueFormat === 'percent'  ? formatPercent(item.value, locale)
    :                              formatNumber(item.value, locale)
    : undefined

  const handleClick = useCallback(() => onToggle?.(item.id), [item.id, onToggle])

  return (
    <button
      onClick={onToggle ? handleClick : undefined}
      disabled={!onToggle}
      aria-pressed={!isDisabled}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded transition-all',
        'text-xs select-none',
        onToggle && 'hover:bg-bg-subtle cursor-pointer',
        !onToggle && 'cursor-default',
        isDisabled && 'opacity-50',
        isAr ? 'flex-row-reverse font-ui-ar' : 'font-ui-en',
      )}
    >
      <LegendSwatch color={item.color} hidden={isDisabled} />
      <span className={cn('text-text-secondary', isAr ? 'text-right' : 'text-left')}>
        {label}
      </span>
      {formattedValue && (
        <span
          className="font-number tabular-nums text-text-primary font-semibold ms-auto ps-2"
          dir="ltr"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {formattedValue}
        </span>
      )}
    </button>
  )
}

// ── ChartLegend ───────────────────────────────────────────────────────────────

export interface ChartLegendProps {
  items:       LegendItem[]
  locale:      SupportedLocale
  direction?:  'ltr' | 'rtl'
  onToggle?:   (id: string) => void
  layout?:     'horizontal' | 'vertical'
  showValues?: boolean
  valueFormat?:'number' | 'currency' | 'percent'
  currency?:   string
  className?:  string
}

export function ChartLegend({
  items,
  locale,
  direction = 'ltr',
  onToggle,
  layout    = 'horizontal',
  showValues,
  valueFormat,
  currency,
  className,
}: ChartLegendProps) {
  const isRtl = direction === 'rtl'

  return (
    <div
      className={cn(
        'flex flex-wrap gap-1',
        layout === 'vertical' && 'flex-col',
        isRtl && 'flex-row-reverse',
        className,
      )}
      role="list"
      aria-label={locale.startsWith('ar') ? 'مفتاح المخطط' : 'Chart legend'}
    >
      {items.map(item => (
        <div key={item.id} role="listitem">
          <LegendItemButton
            item={item}
            locale={locale}
            onToggle={onToggle}
            showValue={showValues}
            valueFormat={valueFormat}
            currency={currency}
          />
        </div>
      ))}
    </div>
  )
}

// ── ComparisonLegend ──────────────────────────────────────────────────────────

export function ComparisonLegend({
  currentLabel,
  compareLabel,
  currentColor,
  compareColor,
  locale,
  direction = 'ltr',
}: {
  currentLabel:  string
  compareLabel:  string
  currentColor:  string
  compareColor:  string
  locale:        SupportedLocale
  direction?:    'ltr' | 'rtl'
}) {
  const isAr  = locale.startsWith('ar')
  const isRtl = direction === 'rtl'

  return (
    <div
      className={cn('flex items-center gap-4', isRtl && 'flex-row-reverse')}
      aria-label={isAr ? 'مقارنة الفترات' : 'Period comparison'}
    >
      {[
        { label: currentLabel, color: currentColor, dashed: false },
        { label: compareLabel, color: compareColor, dashed: true  },
      ].map(({ label, color, dashed }) => (
        <div
          key={label}
          className={cn('flex items-center gap-1.5', isRtl && 'flex-row-reverse')}
        >
          <svg width="20" height="10" aria-hidden="true">
            <line
              x1="0" y1="5" x2="20" y2="5"
              stroke={color}
              strokeWidth="2"
              strokeDasharray={dashed ? '4 2' : undefined}
            />
          </svg>
          <span className={cn('text-xs text-text-secondary', isAr ? 'font-ui-ar' : 'font-ui-en')}>
            {label}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── GroupedLegend ─────────────────────────────────────────────────────────────

export interface LegendGroup {
  id:       string
  label:    string
  labelAr?: string
  items:    LegendItem[]
}

export function GroupedLegend({
  groups,
  locale,
  direction = 'ltr',
  onToggle,
  showValues,
  valueFormat,
  currency,
}: {
  groups:      LegendGroup[]
  locale:      SupportedLocale
  direction?:  'ltr' | 'rtl'
  onToggle?:   (id: string) => void
  showValues?: boolean
  valueFormat?:'number' | 'currency' | 'percent'
  currency?:   string
}) {
  const isAr  = locale.startsWith('ar')
  const isRtl = direction === 'rtl'

  return (
    <div
      className={cn('flex flex-col gap-3', isRtl && 'items-end')}
      role="list"
    >
      {groups.map(group => {
        const groupLabel = isAr && group.labelAr ? group.labelAr : group.label
        return (
          <div key={group.id} role="listitem">
            <p className={cn(
              'text-2xs font-semibold text-text-tertiary uppercase tracking-wide mb-1 px-2',
              isAr ? 'font-ui-ar text-right' : 'font-ui-en',
            )}>
              {groupLabel}
            </p>
            <ChartLegend
              items={group.items}
              locale={locale}
              direction={direction}
              onToggle={onToggle}
              layout="vertical"
              showValues={showValues}
              valueFormat={valueFormat}
              currency={currency}
            />
          </div>
        )
      })}
    </div>
  )
}

// ── useLegendState — manage series visibility ─────────────────────────────────

import { useState, useCallback as useCallbackHook } from 'react'
import { seriesColor } from '../themes/chart-tokens'
import type { ChartSeries } from '../core/types'

export function useLegendState(
  series:       ChartSeries[],
  tenantPalette?: string[],
): {
  legendItems:    LegendItem[]
  hiddenSeries:   Set<string>
  toggleSeries:   (id: string) => void
  visibleSeries:  ChartSeries[]
} {
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(series.filter(s => s.hidden).map(s => s.id)),
  )

  const toggleSeries = useCallbackHook((id: string) => {
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const legendItems: LegendItem[] = series.map((s, i) => ({
    id:      s.id,
    label:   s.label,
    labelAr: s.labelAr,
    color:   s.colorVar ?? s.color ?? seriesColor(i, tenantPalette),
    hidden:  hidden.has(s.id),
  }))

  const visibleSeries = series.filter(s => !hidden.has(s.id))

  return { legendItems, hiddenSeries: hidden, toggleSeries, visibleSeries }
}
