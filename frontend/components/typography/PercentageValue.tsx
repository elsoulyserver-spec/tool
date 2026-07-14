'use client'

/**
 * PercentageValue
 *
 * Renders a percentage or ratio.
 * Always Inter + tabular-nums + LTR.
 * Supports delta coloring and sign prefixes.
 *
 * @example
 * <PercentageValue value={98.43} />                    → 98.43%
 * <PercentageValue value={0.9843} asDecimal />          → 98.43%
 * <PercentageValue value={18.4} showSign size="2xl" /> → +18.4%
 */

import { type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import { formatPercent, type SupportedLocale } from '@/lib/formatters'

interface PercentageValueProps extends HTMLAttributes<HTMLSpanElement> {
  value:       number
  locale?:     SupportedLocale
  /** If true, value is a decimal (0.9843). If false, value is already percent (98.43). */
  asDecimal?:  boolean
  decimals?:   number
  /** Show + prefix for positive values */
  showSign?:   boolean
  /** Color-code based on direction — green positive, red negative */
  colorCode?:  boolean
  positiveIsGood?: boolean  // default true — false for cost metrics (lower is better)
  size?:       'sm' | 'base' | 'md' | 'xl' | '2xl' | '3xl'
  weight?:     'regular' | 'medium' | 'semibold' | 'bold'
}

const sizeClasses = {
  'sm':   'text-sm',
  'base': 'text-base',
  'md':   'text-md',
  'xl':   'text-xl',
  '2xl':  'text-2xl',
  '3xl':  'text-3xl',
} as const

const weightClasses = {
  regular:  'font-regular',
  medium:   'font-medium',
  semibold: 'font-semibold',
  bold:     'font-bold',
} as const

export function PercentageValue({
  value,
  locale           = 'en-SA',
  asDecimal        = false,
  decimals         = 2,
  showSign         = false,
  colorCode        = false,
  positiveIsGood   = true,
  size             = 'base',
  weight           = 'semibold',
  className,
  ...props
}: PercentageValueProps) {
  // Normalise to decimal for Intl
  const decimal = asDecimal ? value : value / 100
  const formatted = formatPercent(decimal, locale, decimals)

  const sign = showSign && value > 0 ? '+' : ''
  const display = `${sign}${formatted}`

  const colorClass = colorCode
    ? value > 0
      ? positiveIsGood
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-red-600 dark:text-red-400'
      : value < 0
        ? positiveIsGood
          ? 'text-red-600 dark:text-red-400'
          : 'text-emerald-600 dark:text-emerald-400'
        : 'text-slate-500 dark:text-slate-400'
    : ''

  return (
    <span
      className={cn(
        'inline-block whitespace-nowrap',
        'font-number font-tabular dir-ltr bidi-isolate',
        sizeClasses[size],
        weightClasses[weight],
        colorClass,
        className,
      )}
      dir="ltr"
      style={{
        fontVariantNumeric:  'tabular-nums',
        fontFeatureSettings: '"tnum" 1',
      }}
      {...props}
    >
      {display}
    </span>
  )
}
