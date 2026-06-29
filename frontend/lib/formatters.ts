/**
 * Easy Track — Analytics Formatters
 *
 * Rules enforced by every formatter:
 *  1. Numbers always rendered with Latin digits (0–9), never Eastern Arabic (٠–٩)
 *  2. All numeric strings are logically LTR — callers must wrap in dir="ltr" span
 *  3. Intl API used for all locale-sensitive formatting — no manual string building
 *  4. Currency always uses SAR with 'ر.س' display symbol in Arabic locale
 *  5. formatters are pure functions — no side effects, no DOM access
 */

// ── Locale types ──────────────────────────────────────────────────────────────

export type SupportedLocale =
  | 'ar-SA'   // Arabic (Saudi Arabia) — primary market
  | 'ar-AE'   // Arabic (UAE)
  | 'ar-KW'   // Arabic (Kuwait)
  | 'ar-QA'   // Arabic (Qatar)
  | 'ar-BH'   // Arabic (Bahrain)
  | 'ar-OM'   // Arabic (Oman)
  | 'en-SA'   // English (Saudi Arabia) — bilingual enterprise users
  | 'en-US'   // English (US) — international fallback
  | 'en-GB'   // English (UK)

export type CurrencyCode = 'SAR' | 'AED' | 'KWD' | 'QAR' | 'BHD' | 'OMR' | 'USD' | 'EUR' | 'GBP'

// Default currency per locale
const LOCALE_CURRENCY: Record<SupportedLocale, CurrencyCode> = {
  'ar-SA': 'SAR',
  'ar-AE': 'AED',
  'ar-KW': 'KWD',
  'ar-QA': 'QAR',
  'ar-BH': 'BHD',
  'ar-OM': 'OMR',
  'en-SA': 'SAR',
  'en-US': 'USD',
  'en-GB': 'GBP',
}

// Enforce Latin numerals regardless of locale — always latn numeral system
// This prevents Eastern Arabic numeral rendering in ar-SA by forcing -u-nu-latn
function latinLocale(locale: SupportedLocale): string {
  return `${locale}-u-nu-latn`
}

// ── Intl formatter cache ──────────────────────────────────────────────────────
// Intl.NumberFormat construction is expensive. Cache instances per config key.

const formatterCache = new Map<string, Intl.NumberFormat>()

function getFormatter(key: string, locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const cacheKey = `${key}:${locale}`
  if (!formatterCache.has(cacheKey)) {
    formatterCache.set(cacheKey, new Intl.NumberFormat(locale, options))
  }
  return formatterCache.get(cacheKey)!
}

// ── formatNumber ──────────────────────────────────────────────────────────────
/**
 * Format an integer or decimal with grouping separators.
 *
 * @example
 * formatNumber(12500, 'ar-SA')     → '12,500'
 * formatNumber(12500.5, 'en-SA')   → '12,500.5'
 * formatNumber(0.0032, 'en-SA', 4) → '0.0032'
 */
export function formatNumber(
  value: number,
  locale: SupportedLocale,
  maximumFractionDigits = 2,
  minimumFractionDigits = 0,
): string {
  const fmt = getFormatter('number', latinLocale(locale), {
    style:                  'decimal',
    useGrouping:            true,
    minimumFractionDigits,
    maximumFractionDigits,
  })
  return fmt.format(value)
}

// ── formatCurrency ────────────────────────────────────────────────────────────
/**
 * Format a monetary value.
 * Always uses Latin digits. Symbol placement follows locale convention.
 * For ar-SA: 'SAR 12,500' or '12,500 ر.س' depending on Intl implementation.
 *
 * @example
 * formatCurrency(12500, 'ar-SA')           → 'SAR 12,500'
 * formatCurrency(12500, 'ar-SA', 'SAR', 2) → 'SAR 12,500.00'
 * formatCurrency(284500, 'en-SA')          → 'SAR 284,500'
 */
export function formatCurrency(
  value: number,
  locale: SupportedLocale,
  currency?: CurrencyCode,
  minimumFractionDigits = 0,
  maximumFractionDigits = 2,
): string {
  const resolvedCurrency = currency ?? LOCALE_CURRENCY[locale]
  const fmt = getFormatter(
    `currency-${resolvedCurrency}-${minimumFractionDigits}`,
    latinLocale(locale),
    {
      style:    'currency',
      currency: resolvedCurrency,
      currencyDisplay: 'symbol',
      minimumFractionDigits,
      maximumFractionDigits,
    },
  )
  return fmt.format(value)
}

// ── formatPercent ─────────────────────────────────────────────────────────────
/**
 * Format a decimal as a percentage string.
 * Input: decimal (0.9843 → '98.43%')
 *
 * @example
 * formatPercent(0.9843, 'en-SA')  → '98.43%'
 * formatPercent(0.9843, 'ar-SA')  → '98.43%'  (Latin digits, % symbol)
 * formatPercent(0.185, 'en-SA', 1) → '18.5%'
 */
export function formatPercent(
  value: number,
  locale: SupportedLocale,
  maximumFractionDigits = 2,
): string {
  const fmt = getFormatter(`percent-${maximumFractionDigits}`, latinLocale(locale), {
    style:                'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits,
  })
  return fmt.format(value)
}

// ── formatCompact ─────────────────────────────────────────────────────────────
/**
 * Format large numbers in compact notation.
 *
 * @example
 * formatCompact(1200000, 'en-SA') → '1.2M'
 * formatCompact(1200000, 'ar-SA') → '1.2M'   (Latin digits + Latin suffix)
 * formatCompact(84500,   'en-SA') → '84.5K'
 * formatCompact(1000000000, 'en-SA') → '1B'
 */
export function formatCompact(
  value: number,
  locale: SupportedLocale,
  maximumFractionDigits = 1,
): string {
  // Force en-SA notation for compact — Arabic compact suffixes (م، مليار)
  // are ambiguous at small sizes. Use Latin suffix (K/M/B) regardless of locale.
  const fmt = getFormatter(`compact-${maximumFractionDigits}`, 'en-SA-u-nu-latn', {
    notation:             'compact',
    compactDisplay:       'short',
    minimumFractionDigits: 0,
    maximumFractionDigits,
  })
  return fmt.format(value)
}

// ── formatROAS ────────────────────────────────────────────────────────────────
/**
 * Format Return on Ad Spend as a multiplier.
 *
 * @example
 * formatROAS(4.78)  → '4.78x'
 * formatROAS(4)     → '4.00x'
 * formatROAS(12.5)  → '12.50x'
 */
export function formatROAS(value: number, decimals = 2): string {
  return `${value.toFixed(decimals)}x`
}

// ── formatCPA ─────────────────────────────────────────────────────────────────
/**
 * Format Cost Per Acquisition.
 * Always 2 decimal places for financial precision.
 *
 * @example
 * formatCPA(25.6, 'en-SA') → 'SAR 25.60'
 */
export function formatCPA(value: number, locale: SupportedLocale, currency?: CurrencyCode): string {
  return formatCurrency(value, locale, currency, 2, 2)
}

// ── formatDelta ───────────────────────────────────────────────────────────────
/**
 * Format a percentage delta with sign prefix.
 *
 * @example
 * formatDelta(0.184,  'en-SA') → '+18.4%'
 * formatDelta(-0.032, 'en-SA') → '-3.2%'
 * formatDelta(0,      'en-SA') → '0.0%'
 */
export function formatDelta(
  value: number,
  locale: SupportedLocale,
  maximumFractionDigits = 1,
): string {
  const sign = value > 0 ? '+' : ''
  const fmt = getFormatter(`delta-${maximumFractionDigits}`, latinLocale(locale), {
    style:                'percent',
    minimumFractionDigits: maximumFractionDigits,
    maximumFractionDigits,
    signDisplay:          'never',   // we handle sign manually for '+' prefix
  })
  return `${sign}${fmt.format(value)}`
}

// ── formatDate ────────────────────────────────────────────────────────────────
/**
 * Format a date for analytics display.
 * Always Gregorian calendar (analytics timestamps must be unambiguous).
 * Arabic locale uses Latin digits for consistency with numeric columns.
 *
 * @example
 * formatDate(new Date(), 'ar-SA', 'short') → '29‏/6‏/2026'
 * formatDate(new Date(), 'en-SA', 'medium') → 'Jun 29, 2026'
 */
export function formatDate(
  date: Date | number,
  locale: SupportedLocale,
  dateStyle: Intl.DateTimeFormatOptions['dateStyle'] = 'medium',
): string {
  const fmt = getFormatter(`date-${dateStyle}`, `${latinLocale(locale)}-u-ca-gregory`, {
    dateStyle,
    calendar: 'gregory',   // always Gregorian for analytics data
  })
  return fmt.format(date instanceof Date ? date : new Date(date))
}

// ── formatRelativeTime ────────────────────────────────────────────────────────
/**
 * Format a relative timestamp string.
 * Returns Arabic or English relative time string.
 *
 * @example
 * formatRelativeTime(-5, 'minutes', 'ar-SA') → 'قبل 5 دقائق'
 * formatRelativeTime(-2, 'hours',   'en-SA') → '2 hours ago'
 * formatRelativeTime(-1, 'days',    'ar-SA') → 'أمس'
 */
export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale: SupportedLocale,
): string {
  // Note: RelativeTimeFormat uses the locale's numeral system.
  // We force Latin digits here via the extension tag.
  const fmt = new Intl.RelativeTimeFormat(latinLocale(locale), {
    numeric: 'auto',
    style:   'long',
  })
  return fmt.format(value, unit)
}

// ── formatDuration ────────────────────────────────────────────────────────────
/**
 * Format a duration in milliseconds to a human-readable string.
 * Used for API latency, load time metrics.
 *
 * @example
 * formatDuration(1240)  → '1,240ms'
 * formatDuration(65000) → '1m 5s'
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
}

// ── formatFileSize ────────────────────────────────────────────────────────────
/**
 * Format bytes to human-readable file size.
 *
 * @example
 * formatFileSize(1024)        → '1.0 KB'
 * formatFileSize(1536000)     → '1.5 MB'
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

// ── Conversion helpers ────────────────────────────────────────────────────────

/** Convert a decimal ratio to percentage points. (0.9843 → 98.43) */
export function toPercent(decimal: number): number {
  return decimal * 100
}

/** Round to N significant figures. */
export function toSignificant(value: number, figures = 3): number {
  if (value === 0) return 0
  const magnitude = Math.floor(Math.log10(Math.abs(value)))
  const factor = Math.pow(10, figures - 1 - magnitude)
  return Math.round(value * factor) / factor
}

// ── Type exports ──────────────────────────────────────────────────────────────

export type FormatNumberOptions = {
  locale:                SupportedLocale
  maximumFractionDigits?: number
  minimumFractionDigits?: number
}

export type FormatCurrencyOptions = {
  locale:                SupportedLocale
  currency?:             CurrencyCode
  minimumFractionDigits?: number
  maximumFractionDigits?: number
}
