'use client'

/**
 * PART 8 — Enterprise Tooltip System
 *
 * ChartTooltip:       standard single-series + multi-series tooltip
 * ComparisonTooltip:  current vs previous period
 * AnalyticsTooltip:   analytics-specific with ROAS, CAC, LTV coloring
 *
 * All tooltips:
 *  - Fully bilingual (Arabic + English)
 *  - Keyboard navigable (arrow keys move crosshair → tooltip updates)
 *  - Screen reader: aria-live="polite" region mirrors tooltip content
 *  - Numbers always Inter + tabular-nums + dir="ltr"
 *  - Arabic labels always IBM Plex Sans Arabic + min 13px
 *  - Renders outside SVG (absolute positioned div) — avoids SVG text limitations
 */

import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { formatCurrency, formatNumber, formatPercent, formatROAS } from '@/lib/formatters'
import type { ChartTooltipData, TooltipSeries } from '../core/types'
import type { SupportedLocale } from '@/lib/formatters'
import { chartCssVars } from '../themes/chart-tokens'

// ── Recharts tooltip payload shape ────────────────────────────────────────────
// Recharts passes payload[] to the contentComponent prop

export interface RechartsTooltipPayload {
  name:        string
  value:       number | string
  color:       string
  dataKey:     string
  payload:     Record<string, unknown>
}

export interface RechartsTooltipProps {
  active?:  boolean
  payload?: RechartsTooltipPayload[]
  label?:   string | number
  locale:   SupportedLocale
  format?:  'currency' | 'number' | 'percent' | 'roas'
  currency?:string
  seriesLabels?:   Record<string, string>
  seriesLabelsAr?: Record<string, string>
  comparePayload?: RechartsTooltipPayload[]
  compareLabel?:   string
}

// ── Tooltip shell ─────────────────────────────────────────────────────────────

function TooltipShell({ children, isAr }: { children: ReactNode; isAr: boolean }) {
  return (
    <div
      dir={isAr ? 'rtl' : 'ltr'}
      role="tooltip"
      className={cn(
        'min-w-[140px] max-w-[280px] px-3 py-2 rounded-lg shadow-lg',
        'border border-border-default',
        'pointer-events-none',
      )}
      style={{
        background:  chartCssVars.tooltipBg,
        borderColor: chartCssVars.tooltipBorder,
        boxShadow:   chartCssVars.tooltipShadow,
      }}
    >
      {children}
    </div>
  )
}

function TooltipLabel({ children, isAr }: { children: ReactNode; isAr: boolean }) {
  return (
    <div
      className={cn(
        'text-xs text-text-secondary mb-1.5 font-semibold border-b border-border-subtle pb-1',
        isAr ? 'font-ui-ar text-right' : 'font-ui-en',
      )}
    >
      {children}
    </div>
  )
}

function TooltipRow({
  color,
  label,
  value,
  isAr,
  isDelta,
  positive,
}: {
  color:     string
  label:     string
  value:     string
  isAr:      boolean
  isDelta?:  boolean
  positive?: boolean
}) {
  return (
    <div className={cn('flex items-center gap-1.5 py-0.5', isAr && 'flex-row-reverse')}>
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span className={cn(
        'flex-1 text-xs text-text-secondary truncate',
        isAr ? 'font-ui-ar text-right' : 'font-ui-en text-left',
      )}>
        {label}
      </span>
      <span
        className={cn(
          'font-number tabular-nums text-xs font-semibold flex-shrink-0',
          isDelta
            ? positive ? 'text-analytics-positive' : 'text-analytics-negative'
            : 'text-text-primary',
        )}
        dir="ltr"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </span>
    </div>
  )
}

// ── Value formatter ───────────────────────────────────────────────────────────

function formatTooltipValue(
  value:    number,
  format:   'currency' | 'number' | 'percent' | 'roas' | 'raw',
  locale:   SupportedLocale,
  currency: string = 'SAR',
): string {
  if (typeof value !== 'number' || isNaN(value)) return '—'
  switch (format) {
    case 'currency': return formatCurrency(value, locale, currency as any)
    case 'percent':  return formatPercent(value, locale)
    case 'roas':     return formatROAS(value)
    case 'number':
    default:         return formatNumber(value, locale)
  }
}

// ── ChartTooltip (Recharts contentComponent) ──────────────────────────────────

export function ChartTooltip({
  active,
  payload,
  label,
  locale,
  format        = 'number',
  currency,
  seriesLabels,
  seriesLabelsAr,
}: RechartsTooltipProps) {
  if (!active || !payload?.length) return null

  const isAr = locale.startsWith('ar')

  return (
    <TooltipShell isAr={isAr}>
      {label != null && (
        <TooltipLabel isAr={isAr}>
          <span dir="ltr" className="font-number tabular-nums">{String(label)}</span>
        </TooltipLabel>
      )}
      {payload.map(entry => {
        const key   = entry.dataKey
        const label = isAr && seriesLabelsAr?.[key]
          ? seriesLabelsAr[key]
          : seriesLabels?.[key] ?? entry.name
        const val   = formatTooltipValue(Number(entry.value), format, locale, currency)

        return (
          <TooltipRow
            key={key}
            color={entry.color}
            label={label}
            value={val}
            isAr={isAr}
          />
        )
      })}
    </TooltipShell>
  )
}

// ── ComparisonTooltip ─────────────────────────────────────────────────────────

export function ComparisonTooltip({
  active,
  payload,
  label,
  locale,
  format     = 'number',
  currency,
  seriesLabels,
  seriesLabelsAr,
  comparePayload,
  compareLabel,
}: RechartsTooltipProps) {
  if (!active || !payload?.length) return null

  const isAr = locale.startsWith('ar')

  // Pair current and compare values
  const pairs = payload.map(entry => {
    const cmp = comparePayload?.find(c => c.dataKey === entry.dataKey)
    const curr = Number(entry.value)
    const prev = cmp ? Number(cmp.value) : undefined
    const delta= prev != null && prev !== 0 ? (curr - prev) / Math.abs(prev) : undefined

    const seriesLabel = isAr && seriesLabelsAr?.[entry.dataKey]
      ? seriesLabelsAr[entry.dataKey]
      : seriesLabels?.[entry.dataKey] ?? entry.name

    return { entry, curr, prev, delta, seriesLabel }
  })

  return (
    <TooltipShell isAr={isAr}>
      {label != null && (
        <TooltipLabel isAr={isAr}>
          <span dir="ltr" className="font-number tabular-nums">{String(label)}</span>
        </TooltipLabel>
      )}
      {pairs.map(({ entry, curr, prev, delta, seriesLabel }) => (
        <div key={entry.dataKey} className="mb-1.5 last:mb-0">
          <TooltipRow
            color={entry.color}
            label={seriesLabel}
            value={formatTooltipValue(curr, format, locale, currency)}
            isAr={isAr}
          />
          {prev != null && (
            <div className={cn('flex items-center gap-1.5 ps-3.5', isAr && 'flex-row-reverse')}>
              <span className={cn(
                'text-2xs text-text-tertiary',
                isAr ? 'font-ui-ar' : 'font-ui-en',
              )}>
                {compareLabel ?? (isAr ? 'الفترة السابقة' : 'Previous')}
              </span>
              <span className="font-number tabular-nums text-2xs text-text-tertiary" dir="ltr">
                {formatTooltipValue(prev, format, locale, currency)}
              </span>
              {delta != null && (
                <span
                  className={cn(
                    'font-number tabular-nums text-2xs font-semibold',
                    delta > 0 ? 'text-analytics-positive' : 'text-analytics-negative',
                  )}
                  dir="ltr"
                >
                  {delta > 0 ? '+' : ''}{formatPercent(delta, locale, 1)}
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </TooltipShell>
  )
}

// ── AnalyticsTooltip ──────────────────────────────────────────────────────────
// Pre-configured for revenue analytics: ROAS coloring, VAT labels, etc.

export interface AnalyticsTooltipConfig {
  revenueKey?:     string
  roasKey?:        string
  conversionsKey?: string
  currency?:       string
  vatInclusive?:   boolean
}

export function makeAnalyticsTooltip(config: AnalyticsTooltipConfig) {
  return function AnalyticsTooltipContent(props: RechartsTooltipProps) {
    const { active, payload, label, locale } = props
    if (!active || !payload?.length) return null

    const isAr = locale.startsWith('ar')
    const { revenueKey, roasKey, conversionsKey, currency = 'SAR', vatInclusive } = config

    return (
      <TooltipShell isAr={isAr}>
        {label != null && (
          <TooltipLabel isAr={isAr}>
            <span dir="ltr" className="font-number tabular-nums">{String(label)}</span>
          </TooltipLabel>
        )}
        {payload.map(entry => {
          const key    = entry.dataKey
          const val    = Number(entry.value)
          const isROAS = key === roasKey
          const isRev  = key === revenueKey
          const isConv = key === conversionsKey

          let formatted: string
          if (isROAS)       formatted = formatROAS(val)
          else if (isRev)   formatted = formatCurrency(val, locale, currency as any)
          else if (isConv)  formatted = formatNumber(val, locale, 0)
          else              formatted = formatNumber(val, locale)

          const label = isAr && props.seriesLabelsAr?.[key]
            ? props.seriesLabelsAr[key]
            : props.seriesLabels?.[key] ?? entry.name

          return (
            <div key={key}>
              <TooltipRow
                color={entry.color}
                label={label}
                value={formatted}
                isAr={isAr}
                isDelta={isROAS}
                positive={isROAS ? val >= 1 : undefined}
              />
              {isRev && vatInclusive != null && (
                <div className={cn('text-2xs text-text-tertiary ps-3.5 mt-0.5', isAr ? 'font-ui-ar text-right' : 'font-ui-en')}>
                  {isAr
                    ? vatInclusive ? 'شامل ضريبة القيمة المضافة' : 'غير شامل ضريبة القيمة المضافة'
                    : vatInclusive ? 'Incl. VAT' : 'Excl. VAT'}
                </div>
              )}
            </div>
          )
        })}
      </TooltipShell>
    )
  }
}

// ── Screen reader live region ─────────────────────────────────────────────────
// Synced with the active tooltip for assistive tech

export function TooltipAriaLive({
  data,
  locale,
}: {
  data?:   ChartTooltipData | null
  locale:  SupportedLocale
}) {
  const isAr = locale.startsWith('ar')

  if (!data) return <div aria-live="polite" aria-atomic="true" className="sr-only" />

  const summary = data.series
    .map(s => `${s.label}: ${s.value}`)
    .join(isAr ? '، ' : ', ')

  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {data.xLabel}: {summary}
    </div>
  )
}
