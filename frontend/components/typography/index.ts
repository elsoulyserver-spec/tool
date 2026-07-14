/**
 * Easy Track Typography Component Library
 *
 * Import from this barrel file in all consumers:
 *   import { MetricValue, CurrencyValue, EventName } from '@/components/typography'
 */

export { LocalizedText, ArText, BrandArText, EnText } from './LocalizedText'
export { MetricValue }  from './MetricValue'
export { EventName }    from './EventName'
export { CurrencyValue } from './CurrencyValue'
export { PercentageValue } from './PercentageValue'

// Re-export formatter types for convenience
export type { SupportedLocale, CurrencyCode } from '@/lib/formatters'
