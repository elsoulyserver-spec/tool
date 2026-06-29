'use client'

/**
 * Easy Track Analytics Table — Cell Renderers
 *
 * All cells follow these invariants:
 *  1. Numbers: always Inter + tabular-nums + dir="ltr"
 *  2. Arabic text: always IBM Plex Sans Arabic + dir="rtl" + min 13px
 *  3. English text: always Inter + dir="ltr"
 *  4. Technical IDs: always JetBrains Mono + dir="ltr"
 *  5. No cell ever wraps — overflow:hidden + text-overflow:ellipsis
 *  6. Every cell receives the row height via CSS var(--table-row-height)
 *
 * Cell renderers are pure functions — no side effects, no hooks beyond
 * formatting utilities.
 */

import { type CellContext } from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatROAS,
  formatDelta,
  formatDate,
  formatRelativeTime,
  type SupportedLocale,
} from '@/lib/formatters'
import type {
  AnalyticsRow,
  AnalyticsColumnMeta,
  SparklineData,
  AttributionBreakdown,
  HealthScore,
} from '../core/types'

// ── Base cell wrapper ─────────────────────────────────────────────────────────
// Every cell uses this wrapper. Sets the row height, overflow, and alignment.

interface CellWrapperProps {
  align?:    'start' | 'center' | 'end'
  dir?:      'ltr' | 'rtl'
  className?: string
  title?:    string
  children:  React.ReactNode
}

function CellWrapper({ align = 'start', dir, className, title, children }: CellWrapperProps) {
  return (
    <div
      dir={dir}
      title={title}
      style={{ height: 'var(--table-row-height, 36px)' }}
      className={cn(
        'flex items-center w-full overflow-hidden',
        align === 'start'  && 'justify-start',
        align === 'center' && 'justify-center',
        align === 'end'    && 'justify-end',
        className,
      )}
    >
      {children}
    </div>
  )
}

// ── CurrencyCell ──────────────────────────────────────────────────────────────

interface CurrencyCellProps {
  value:   number
  meta:    AnalyticsColumnMeta
}

export function CurrencyCell({ value, meta }: CurrencyCellProps) {
  if (value == null) return <CellWrapper align="end"><span className="text-text-tertiary">—</span></CellWrapper>

  const formatted = formatCurrency(
    value,
    meta.locale as SupportedLocale ?? 'en-SA',
    meta.format?.currency as any,
    0,
    meta.format?.decimals ?? 2,
  )

  return (
    <CellWrapper align="end" dir="ltr">
      <span
        className="font-number tabular-nums text-text-primary text-sm whitespace-nowrap"
        style={{ fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum" 1, "lnum" 1' }}
      >
        {formatted}
      </span>
    </CellWrapper>
  )
}

// ── PercentageCell ────────────────────────────────────────────────────────────

export function PercentageCell({ value, meta }: { value: number; meta: AnalyticsColumnMeta }) {
  if (value == null) return <CellWrapper align="end"><span className="text-text-tertiary">—</span></CellWrapper>

  const decimal   = meta.format?.asDecimal ? value : value / 100
  const locale    = meta.locale as SupportedLocale ?? 'en-SA'
  const formatted = formatPercent(decimal, locale, meta.format?.decimals ?? 2)
  const colorCode = meta.format?.colorCode ?? false
  const isPositive = meta.format?.positiveIsGood ?? true

  const colorClass = colorCode
    ? value > 0
      ? isPositive ? 'text-analytics-positive' : 'text-analytics-negative'
      : value < 0
        ? isPositive ? 'text-analytics-negative' : 'text-analytics-positive'
        : 'text-text-tertiary'
    : ''

  return (
    <CellWrapper align="end" dir="ltr">
      <span
        className={cn('font-number tabular-nums text-sm whitespace-nowrap', colorClass || 'text-text-primary')}
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {meta.format?.showSign && value > 0 ? '+' : ''}{formatted}
      </span>
    </CellWrapper>
  )
}

// ── ROASCell ──────────────────────────────────────────────────────────────────

export function ROASCell({ value }: { value: number }) {
  if (value == null || value === 0) return <CellWrapper align="end"><span className="text-text-tertiary">—</span></CellWrapper>

  const colorClass = value >= 3 ? 'text-analytics-positive'
                   : value >= 1 ? 'text-text-primary'
                   :              'text-analytics-negative'

  return (
    <CellWrapper align="end" dir="ltr">
      <span
        className={cn('font-number tabular-nums font-semibold text-sm whitespace-nowrap', colorClass)}
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {formatROAS(value, 2)}
      </span>
    </CellWrapper>
  )
}

// ── DeltaCell ─────────────────────────────────────────────────────────────────

export function DeltaCell({ value, meta }: { value: number; meta: AnalyticsColumnMeta }) {
  if (value == null) return <CellWrapper align="end"><span className="text-text-tertiary">—</span></CellWrapper>

  const locale        = meta.locale as SupportedLocale ?? 'en-SA'
  const isGood        = meta.format?.positiveIsGood ?? true
  const positive      = value > 0
  const isPositiveOutcome = positive === isGood

  const formatted = formatDelta(value, locale)
  const icon      = value > 0 ? '↑' : value < 0 ? '↓' : '→'
  const colorClass = value === 0
    ? 'text-text-tertiary'
    : isPositiveOutcome ? 'text-analytics-positive' : 'text-analytics-negative'

  return (
    <CellWrapper align="end" dir="ltr">
      <span
        className={cn('font-number tabular-nums font-semibold text-sm whitespace-nowrap inline-flex items-center gap-0.5', colorClass)}
        style={{ fontVariantNumeric: 'tabular-nums' }}
        aria-label={`${isPositiveOutcome ? 'increased' : 'decreased'} by ${formatted}`}
      >
        <span aria-hidden="true">{icon}</span>
        {formatted}
      </span>
    </CellWrapper>
  )
}

// ── EventNameCell ─────────────────────────────────────────────────────────────

const PLATFORM_BADGES: Record<string, { label: string; className: string }> = {
  ga4:        { label: 'GA4',    className: 'bg-platform-ga4-bg    text-platform-ga4-text' },
  meta:       { label: 'Meta',   className: 'bg-platform-meta-bg   text-platform-meta-text' },
  tiktok:     { label: 'TikTok', className: 'bg-platform-tiktok-bg text-platform-tiktok-text' },
  snapchat:   { label: 'Snap',   className: 'bg-platform-snap-bg   text-platform-snap-text' },
  'google-ads':{ label: 'Ads',   className: 'bg-status-info        text-status-info-text' },
  sgtm:       { label: 'sGTM',   className: 'bg-platform-sgtm-bg   text-platform-sgtm-text' },
  custom:     { label: 'Custom', className: 'bg-bg-subtle          text-text-secondary' },
}

export function EventNameCell({ value, meta }: { value: string; meta: AnalyticsColumnMeta }) {
  if (!value) return <CellWrapper><span className="text-text-tertiary">—</span></CellWrapper>

  const maxLen   = meta.format?.maxLength ?? 40
  const display  = value.length > maxLen ? `${value.slice(0, maxLen - 1)}…` : value
  const showBadge= meta.format?.showBadge ?? false

  return (
    <CellWrapper align="start" dir="ltr" title={value.length > maxLen ? value : undefined}>
      <div className="flex items-center gap-1.5 overflow-hidden min-w-0">
        {showBadge && (
          <span
            className="font-ui-en text-2xs font-semibold px-1 py-0.5 rounded flex-shrink-0"
            aria-hidden="true"
          >
            {/* Badge injected by PlatformCell alongside */}
          </span>
        )}
        <span className="font-ui-en text-sm font-medium text-text-primary truncate">
          {display}
        </span>
      </div>
    </CellWrapper>
  )
}

// ── PlatformCell ──────────────────────────────────────────────────────────────

export function PlatformCell({ value }: { value: string }) {
  const badge = PLATFORM_BADGES[value?.toLowerCase()] ?? PLATFORM_BADGES.custom
  return (
    <CellWrapper align="start" dir="ltr">
      <span
        className={cn(
          'inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-semibold font-ui-en',
          badge.className,
        )}
        aria-label={badge.label}
      >
        {badge.label}
      </span>
    </CellWrapper>
  )
}

// ── TimestampCell ─────────────────────────────────────────────────────────────

export function TimestampCell({ value, meta }: { value: string; meta: AnalyticsColumnMeta }) {
  if (!value) return <CellWrapper align="end"><span className="text-text-tertiary">—</span></CellWrapper>

  const locale    = meta.locale as SupportedLocale ?? 'en-SA'
  const isRelative= meta.valueType === 'relative-time'

  let display: string
  let fullDate: string

  try {
    const date = new Date(value)
    fullDate   = formatDate(date, locale, 'long')
    if (isRelative) {
      const now      = Date.now()
      const diffMs   = now - date.getTime()
      const diffMins = Math.floor(diffMs / 60_000)
      const diffHrs  = Math.floor(diffMs / 3_600_000)
      const diffDays = Math.floor(diffMs / 86_400_000)

      if (diffMins < 1)     display = locale.startsWith('ar') ? 'الآن' : 'just now'
      else if (diffMins < 60) display = formatRelativeTime(-diffMins, 'minutes', locale)
      else if (diffHrs < 24)  display = formatRelativeTime(-diffHrs,  'hours',   locale)
      else                    display = formatRelativeTime(-diffDays,  'days',    locale)
    } else {
      display = formatDate(date, locale, meta.format?.dateStyle ?? 'medium')
    }
  } catch {
    return <CellWrapper align="end"><span className="text-analytics-negative text-sm">Invalid date</span></CellWrapper>
  }

  return (
    <CellWrapper align="end" dir="ltr" title={fullDate}>
      <span
        className={cn(
          'text-sm whitespace-nowrap',
          isRelative ? 'text-text-secondary font-regular' : 'font-number tabular-nums text-text-primary',
        )}
        style={!isRelative ? { fontVariantNumeric: 'tabular-nums' } : undefined}
      >
        {display}
      </span>
    </CellWrapper>
  )
}

// ── StatusCell ────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { bg: string; text: string; label?: string; labelAr?: string }> = {
  active:       { bg: 'bg-status-success',    text: 'text-status-success-text',  label: 'Active',       labelAr: 'نشط' },
  inactive:     { bg: 'bg-bg-subtle',          text: 'text-text-secondary',        label: 'Inactive',     labelAr: 'غير نشط' },
  error:        { bg: 'bg-status-error',       text: 'text-status-error-text',    label: 'Error',        labelAr: 'خطأ' },
  warning:      { bg: 'bg-status-warning',     text: 'text-status-warning-text',  label: 'Warning',      labelAr: 'تحذير' },
  pending:      { bg: 'bg-status-info',        text: 'text-status-info-text',     label: 'Pending',      labelAr: 'معلق' },
  healthy:      { bg: 'bg-status-success',     text: 'text-status-success-text',  label: 'Healthy',      labelAr: 'سليم' },
  degraded:     { bg: 'bg-status-warning',     text: 'text-status-warning-text',  label: 'Degraded',     labelAr: 'متدهور' },
  critical:     { bg: 'bg-status-error',       text: 'text-status-error-text',    label: 'Critical',     labelAr: 'حرج' },
  verified:     { bg: 'bg-status-success',     text: 'text-status-success-text',  label: 'Verified',     labelAr: 'مُحقق' },
  unverified:   { bg: 'bg-bg-subtle',          text: 'text-text-secondary',        label: 'Unverified',   labelAr: 'غير مُحقق' },
}

export function StatusCell({ value, locale = 'en-SA' }: { value: string; locale?: SupportedLocale }) {
  const style   = STATUS_STYLES[value?.toLowerCase()] ?? { bg: 'bg-bg-subtle', text: 'text-text-secondary' }
  const isAr    = locale.startsWith('ar')
  const display = isAr && style.labelAr ? style.labelAr : (style.label ?? value)

  return (
    <CellWrapper align="start">
      <span
        className={cn(
          'inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-semibold',
          isAr ? 'font-ui-ar' : 'font-ui-en',
          style.bg,
          style.text,
        )}
        dir={isAr ? 'rtl' : 'ltr'}
      >
        {display}
      </span>
    </CellWrapper>
  )
}

// ── HealthCell ────────────────────────────────────────────────────────────────

export function HealthCell({ value }: { value: number | HealthScore }) {
  const score   = typeof value === 'number' ? value : value?.score ?? 0
  const label   = typeof value === 'object' ? value.label : undefined
  const clamped = Math.max(0, Math.min(100, score))

  const colorClass = clamped >= 80 ? 'bg-analytics-positive'
                   : clamped >= 60 ? 'bg-status-warning-icon'
                   :                 'bg-analytics-negative'

  return (
    <CellWrapper align="end" dir="ltr">
      <div className="flex items-center gap-1.5 w-full justify-end">
        <span
          className="font-number tabular-nums text-sm font-medium text-text-primary"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {clamped}
        </span>
        <div
          className="w-12 h-1.5 rounded-full bg-bg-subtle overflow-hidden flex-shrink-0"
          role="progressbar"
          aria-valuenow={clamped}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label ?? `Health score: ${clamped}%`}
        >
          <div
            className={cn('h-full rounded-full transition-all', colorClass)}
            style={{ width: `${clamped}%` }}
          />
        </div>
      </div>
    </CellWrapper>
  )
}

// ── SparklineCell ─────────────────────────────────────────────────────────────
// Micro SVG sparkline — no chart library dependency, zero bundle cost

export function SparklineCell({ value }: { value: number[] | SparklineData }) {
  const rawValues = Array.isArray(value) ? value : value?.values ?? []
  if (!rawValues.length) return <CellWrapper align="center"><span className="text-text-tertiary">—</span></CellWrapper>

  const W = 80, H = 20, PAD = 2
  const min  = Math.min(...rawValues)
  const max  = Math.max(...rawValues)
  const range= max - min || 1

  const points = rawValues.map((v, i) => {
    const x = PAD + (i / (rawValues.length - 1)) * (W - PAD * 2)
    const y = H - PAD - ((v - min) / range) * (H - PAD * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  const trend     = !Array.isArray(value) ? value.trend : undefined
  const strokeCol = trend === 'up'   ? 'var(--semantic-color-analytics-positive)'
                  : trend === 'down' ? 'var(--semantic-color-analytics-negative)'
                  :                    'var(--semantic-color-chart-series-1)'

  return (
    <CellWrapper align="center">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        aria-hidden="true"
        style={{ overflow: 'visible' }}
      >
        <polyline
          points={points}
          fill="none"
          stroke={strokeCol}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </CellWrapper>
  )
}

// ── IdCell ────────────────────────────────────────────────────────────────────

export function IdCell({ value, meta }: { value: string; meta: AnalyticsColumnMeta }) {
  if (!value) return <CellWrapper><span className="text-text-tertiary">—</span></CellWrapper>

  const maxLen  = meta.format?.maxLength ?? 30
  const display = value.length > maxLen ? `${value.slice(0, maxLen - 1)}…` : value

  return (
    <CellWrapper align="start" dir="ltr" title={value.length > maxLen ? value : undefined}>
      <span className="font-code text-xs text-text-secondary tracking-wide truncate">
        {display}
      </span>
    </CellWrapper>
  )
}

// ── AttributionCell ───────────────────────────────────────────────────────────

export function AttributionCell({ value }: { value: AttributionBreakdown }) {
  if (!value) return <CellWrapper><span className="text-text-tertiary">—</span></CellWrapper>

  const pct = (value.weight * 100).toFixed(0)

  return (
    <CellWrapper align="start">
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        <div className="w-12 h-1.5 rounded-full bg-bg-subtle overflow-hidden flex-shrink-0">
          <div
            className="h-full rounded-full bg-action-primary"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="font-number tabular-nums text-xs text-text-secondary" dir="ltr">
          {pct}%
        </span>
        <span className="text-xs text-text-tertiary font-ui-en truncate flex-shrink-0">
          {value.model}
        </span>
      </div>
    </CellWrapper>
  )
}

// ── TextCell ──────────────────────────────────────────────────────────────────

export function TextCell({ value, meta, locale = 'en-SA' }: {
  value:   string
  meta:    AnalyticsColumnMeta
  locale?: SupportedLocale
}) {
  if (!value) return <CellWrapper><span className="text-text-tertiary">—</span></CellWrapper>

  const isAr = locale.startsWith('ar')

  return (
    <CellWrapper align={meta.align ?? 'start'} dir={isAr ? 'rtl' : 'ltr'}>
      <span
        className={cn(
          'truncate text-text-primary',
          isAr ? 'font-ui-ar text-base' : 'font-ui-en text-sm',
        )}
        title={value}
      >
        {value}
      </span>
    </CellWrapper>
  )
}

// ── NumberCell ────────────────────────────────────────────────────────────────

export function NumberCell({ value, meta }: { value: number; meta: AnalyticsColumnMeta }) {
  if (value == null) return <CellWrapper align="end"><span className="text-text-tertiary">—</span></CellWrapper>

  const locale    = meta.locale as SupportedLocale ?? 'en-SA'
  const formatted = meta.format?.compact
    ? formatNumber(value, locale, 1, 0)    // will be overridden with compact formatter
    : formatNumber(value, locale, meta.format?.decimals ?? 0)

  return (
    <CellWrapper align="end" dir="ltr">
      <span
        className="font-number tabular-nums text-sm text-text-primary whitespace-nowrap"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {formatted}
      </span>
    </CellWrapper>
  )
}

// ── Master cell dispatcher ────────────────────────────────────────────────────
// Called by the AnalyticsTable component for every cell.

export function AnalyticsCellRenderer<TRow extends AnalyticsRow>({
  cell,
  locale = 'en-SA',
}: {
  cell:   import('@tanstack/react-table').Cell<TRow, unknown>
  locale: SupportedLocale
}) {
  const meta  = cell.column.columnDef.meta?.analytics
  const value = cell.getValue()

  if (!meta) {
    return (
      <CellWrapper>
        <span className="text-sm text-text-primary">{String(value ?? '')}</span>
      </CellWrapper>
    )
  }

  switch (meta.valueType) {
    case 'currency':      return <CurrencyCell    value={value as number}   meta={meta} />
    case 'percentage':    return <PercentageCell  value={value as number}   meta={meta} />
    case 'roas':          return <ROASCell         value={value as number} />
    case 'delta':         return <DeltaCell        value={value as number}   meta={meta} />
    case 'event-name':    return <EventNameCell    value={value as string}   meta={meta} />
    case 'platform':      return <PlatformCell     value={value as string} />
    case 'timestamp':
    case 'relative-time': return <TimestampCell    value={value as string}   meta={meta} />
    case 'status':        return <StatusCell       value={value as string}   locale={locale} />
    case 'health':        return <HealthCell       value={value as number} />
    case 'sparkline':     return <SparklineCell    value={value as number[]} />
    case 'id':
    case 'url':           return <IdCell           value={value as string}   meta={meta} />
    case 'attribution':   return <AttributionCell  value={value as AttributionBreakdown} />
    case 'number':        return <NumberCell       value={value as number}   meta={meta} />
    case 'text':
    default:              return <TextCell         value={value as string}   meta={meta} locale={locale} />
  }
}
