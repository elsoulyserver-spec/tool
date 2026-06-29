'use client'

/**
 * MetricValue
 *
 * Renders a KPI or analytics metric number.
 * Always: Inter, tabular-nums, dir="ltr", unicode-bidi: isolate.
 * Even when the surrounding page is dir="rtl".
 *
 * Supports optional delta indicator and unit suffix.
 *
 * @example
 * <MetricValue value={284500} locale="ar-SA" size="5xl" />
 * // → SAR 284,500 (in LTR Inter regardless of page direction)
 *
 * <MetricValue value={4.78} formatter="roas" size="4xl" />
 * // → 4.78x
 */

import { type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import {
  formatNumber,
  formatCurrency,
  formatCompact,
  formatROAS,
  formatPercent,
  formatDelta,
  type SupportedLocale,
  type CurrencyCode,
} from '@/lib/formatters'

type MetricFormatter =
  | 'number'       // 12,500
  | 'currency'     // SAR 12,500
  | 'compact'      // 1.2M
  | 'percent'      // 98.43%
  | 'roas'         // 4.78x
  | 'raw'          // renders value.toString() with no formatting

type DeltaDirection = 'up' | 'down' | 'neutral'

interface DeltaProps {
  value:     number         // decimal — e.g. 0.184 for +18.4%
  direction: DeltaDirection
  locale:    SupportedLocale
}

interface MetricValueProps extends HTMLAttributes<HTMLSpanElement> {
  value:       number
  locale?:     SupportedLocale
  formatter?:  MetricFormatter
  currency?:   CurrencyCode
  decimals?:   number
  size?:       'sm' | 'base' | 'md' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | '6xl'
  weight?:     'medium' | 'semibold' | 'bold'
  delta?:      DeltaProps
  unit?:       string   // suffix appended after number, e.g. ' users'
  /** sr-only label for screen readers */
  label?:      string
}

const sizeClasses = {
  'sm':   'text-sm',
  'base': 'text-base',
  'md':   'text-md',
  'xl':   'text-xl',
  '2xl':  'text-2xl',
  '3xl':  'text-3xl',
  '4xl':  'text-4xl',
  '5xl':  'text-5xl',
  '6xl':  'text-6xl',
} as const

const weightClasses = {
  medium:   'font-medium',
  semibold: 'font-semibold',
  bold:     'font-bold',
} as const

const deltaColorClasses: Record<DeltaDirection, string> = {
  up:      'text-emerald-600 dark:text-emerald-400',
  down:    'text-red-600 dark:text-red-400',
  neutral: 'text-slate-500 dark:text-slate-400',
}

function formatValue(
  value:     number,
  formatter: MetricFormatter,
  locale:    SupportedLocale,
  currency?: CurrencyCode,
  decimals?: number,
): string {
  switch (formatter) {
    case 'currency': return formatCurrency(value, locale, currency, 0, decimals ?? 2)
    case 'compact':  return formatCompact(value, locale, decimals ?? 1)
    case 'percent':  return formatPercent(value / 100, locale, decimals ?? 2) // accepts 98.43, not 0.9843
    case 'roas':     return formatROAS(value, decimals ?? 2)
    case 'raw':      return String(value)
    case 'number':
    default:         return formatNumber(value, locale, decimals ?? 0)
  }
}

function Delta({ value, direction, locale }: DeltaProps) {
  const formatted = formatDelta(value, locale)
  const icon = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-sm font-semibold ms-2',
        'font-number font-tabular dir-ltr bidi-isolate',
        deltaColorClasses[direction],
      )}
      aria-label={`${direction === 'up' ? 'increased' : direction === 'down' ? 'decreased' : 'unchanged'} by ${formatted}`}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{formatted}</span>
    </span>
  )
}

export function MetricValue({
  value,
  locale      = 'en-SA',
  formatter   = 'number',
  currency,
  decimals,
  size        = '3xl',
  weight      = 'bold',
  delta,
  unit,
  label,
  className,
  ...props
}: MetricValueProps) {
  const formatted = formatValue(value, formatter, locale, currency, decimals)

  return (
    <span
      className={cn(
        // Critical: always Inter, always LTR, always tabular — no exceptions
        'font-number font-tabular dir-ltr bidi-isolate',
        'inline-flex items-baseline whitespace-nowrap',
        sizeClasses[size],
        weightClasses[weight],
        className,
      )}
      dir="ltr"
      {...props}
    >
      {/* Screen reader accessible label */}
      {label && <span className="sr-only">{label}: </span>}

      <span
        aria-label={label ? undefined : formatted}
        style={{ fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum" 1, "lnum" 1, "zero" 1' }}
      >
        {formatted}
      </span>

      {unit && (
        <span className="ms-1 text-sm font-medium text-slate-500 font-ui-en">
          {unit}
        </span>
      )}

      {delta && <Delta {...delta} />}
    </span>
  )
}
