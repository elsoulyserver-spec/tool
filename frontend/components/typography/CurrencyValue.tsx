'use client'

/**
 * CurrencyValue
 *
 * Renders a monetary amount.
 * Always Inter + tabular-nums + LTR, even inside RTL UI.
 * Supports compact display, VAT labeling (ZATCA compliance),
 * and delta indicators.
 *
 * @example
 * <CurrencyValue amount={284500} locale="ar-SA" />
 * // → SAR 284,500
 *
 * <CurrencyValue amount={284500} locale="ar-SA" vat="inclusive" size="2xl" />
 * // → SAR 284,500 (شامل ضريبة القيمة المضافة)
 *
 * <CurrencyValue amount={25.6} locale="en-SA" decimals={2} />
 * // → SAR 25.60
 */

import { type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import { formatCurrency, formatCompact, type SupportedLocale, type CurrencyCode } from '@/lib/formatters'

type VatDisplay = 'inclusive' | 'exclusive' | 'none'

interface CurrencyValueProps extends HTMLAttributes<HTMLSpanElement> {
  amount:     number
  locale?:    SupportedLocale
  currency?:  CurrencyCode
  decimals?:  number
  /** Use compact notation (1.2M) for large values */
  compact?:   boolean
  /** ZATCA compliance: show VAT status label */
  vat?:       VatDisplay
  size?:       'sm' | 'base' | 'md' | 'xl' | '2xl' | '3xl' | '4xl'
  weight?:    'regular' | 'medium' | 'semibold' | 'bold'
  /** Dim the currency code symbol */
  dimSymbol?: boolean
}

const vatLabels: Record<Exclude<VatDisplay, 'none'>, Record<'ar-SA' | 'en-SA', string>> = {
  inclusive: {
    'ar-SA': 'شامل ضريبة القيمة المضافة',
    'en-SA': 'incl. VAT',
  },
  exclusive: {
    'ar-SA': 'غير شامل ضريبة القيمة المضافة',
    'en-SA': 'excl. VAT',
  },
}

const sizeClasses = {
  'sm':   'text-sm',
  'base': 'text-base',
  'md':   'text-md',
  'xl':   'text-xl',
  '2xl':  'text-2xl',
  '3xl':  'text-3xl',
  '4xl':  'text-4xl',
} as const

const weightClasses = {
  regular:  'font-regular',
  medium:   'font-medium',
  semibold: 'font-semibold',
  bold:     'font-bold',
} as const

export function CurrencyValue({
  amount,
  locale    = 'en-SA',
  currency,
  decimals,
  compact   = false,
  vat       = 'none',
  size      = 'base',
  weight    = 'medium',
  dimSymbol = false,
  className,
  ...props
}: CurrencyValueProps) {
  const vatLocale = locale === 'ar-SA' ? 'ar-SA' : 'en-SA'

  const formatted = compact
    ? formatCompact(amount, locale)
    : formatCurrency(amount, locale, currency, 0, decimals ?? 2)

  const vatLabel = vat !== 'none' ? vatLabels[vat][vatLocale] : null

  return (
    <span
      className={cn(
        'inline-flex items-baseline gap-1.5 whitespace-nowrap',
        // Critical: always Inter + tabular + LTR — no exceptions
        'font-number font-tabular dir-ltr bidi-isolate',
        sizeClasses[size],
        weightClasses[weight],
        className,
      )}
      dir="ltr"
      {...props}
    >
      <span
        style={{
          fontVariantNumeric:  'tabular-nums lining-nums',
          fontFeatureSettings: '"tnum" 1, "lnum" 1, "zero" 1',
        }}
      >
        {formatted}
      </span>

      {vatLabel && (
        <span
          className={cn(
            'text-xs font-regular text-slate-500 dark:text-slate-400',
            // VAT label in Arabic must be RTL but isolated from the number
            locale === 'ar-SA' ? 'font-ui-ar dir-rtl bidi-isolate' : 'font-ui-en',
          )}
          dir={locale === 'ar-SA' ? 'rtl' : 'ltr'}
        >
          ({vatLabel})
        </span>
      )}
    </span>
  )
}
