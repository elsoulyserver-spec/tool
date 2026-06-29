'use client'

/**
 * EventsTable — Analytics Events Table
 *
 * Demonstrates the complete typography system in a production analytics context.
 *
 * Typography rules applied:
 *  - Event names:    Inter, LTR, medium weight, truncate
 *  - Arabic labels:  IBM Plex Sans Arabic, RTL, 13px minimum
 *  - Currency:       Inter, tabular-nums, LTR, right-aligned
 *  - Percentages:    Inter, tabular-nums, LTR, color-coded
 *  - Deltas:         Inter, tabular-nums, LTR, green/red
 *  - Platform IDs:   JetBrains Mono, LTR
 *  - Row height:     36px (standard density) — required for virtual scroll
 *
 * For 10K+ rows: replace the <tbody> map with TanStack Virtual.
 * Row height must match .table-density-standard → 36px exactly.
 */

import { cn } from '@/lib/utils'
import { EventName }       from '@/components/typography/EventName'
import { CurrencyValue }   from '@/components/typography/CurrencyValue'
import { PercentageValue } from '@/components/typography/PercentageValue'
import { MetricValue }     from '@/components/typography/MetricValue'
import { LocalizedText }   from '@/components/typography/LocalizedText'
import type { SupportedLocale } from '@/lib/formatters'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EventRow {
  id:            string
  eventName:     string
  platform:      'ga4' | 'meta' | 'tiktok' | 'snapchat' | 'google-ads' | 'sgtm' | 'custom'
  /** Arabic label for the event */
  labelAr?:      string
  conversions:   number
  revenue:       number
  roas:          number
  conversionRate:number   // decimal, e.g. 0.0478
  costPerResult: number
  deltaRevenue:  number   // decimal, e.g. 0.184
}

interface EventsTableProps {
  rows:          EventRow[]
  locale:        SupportedLocale
  density?:      'comfortable' | 'standard' | 'compact' | 'dense'
  /** Show Arabic event labels column */
  showArabicLabel?: boolean
}

// ── Column definitions ─────────────────────────────────────────────────────────

interface Column {
  key:       string
  labelEn:   string
  labelAr:   string
  align:     'start' | 'end'
  width:     string
}

const COLUMNS: Column[] = [
  { key: 'event',   labelEn: 'Event',             labelAr: 'الحدث',              align: 'start', width: '220px' },
  { key: 'label',   labelEn: 'Arabic Label',       labelAr: 'التسمية',            align: 'start', width: '180px' },
  { key: 'conv',    labelEn: 'Conversions',        labelAr: 'التحويلات',          align: 'end',   width: '110px' },
  { key: 'revenue', labelEn: 'Revenue',            labelAr: 'الإيرادات',          align: 'end',   width: '130px' },
  { key: 'roas',    labelEn: 'ROAS',               labelAr: 'عائد الإنفاق',       align: 'end',   width: '80px'  },
  { key: 'cvr',     labelEn: 'CVR',                labelAr: 'معدل التحويل',       align: 'end',   width: '80px'  },
  { key: 'cpr',     labelEn: 'Cost/Result',        labelAr: 'التكلفة/نتيجة',      align: 'end',   width: '110px' },
  { key: 'delta',   labelEn: 'Revenue Δ',          labelAr: 'تغيير الإيرادات',    align: 'end',   width: '90px'  },
]

// ── Density row height map ─────────────────────────────────────────────────────
// These must match the values in typography.css — virtual scroll depends on it.
const DENSITY_CLASS: Record<NonNullable<EventsTableProps['density']>, string> = {
  comfortable: 'table-density-comfortable',
  standard:    'table-density-standard',
  compact:     'table-density-compact',
  dense:       'table-density-dense',
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EventsTable({
  rows,
  locale,
  density          = 'standard',
  showArabicLabel  = false,
}: EventsTableProps) {
  const isAr          = locale.startsWith('ar')
  const labelKey      = isAr ? 'labelAr' : 'labelEn'
  const visibleColumns = showArabicLabel
    ? COLUMNS
    : COLUMNS.filter(c => c.key !== 'label')

  return (
    <div
      className="w-full overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800"
      role="region"
      aria-label={isAr ? 'جدول الأحداث' : 'Events Table'}
    >
      <table
        className={cn(
          'table-analytics w-full border-collapse',
          DENSITY_CLASS[density],
        )}
        aria-label={isAr ? 'أحداث التتبع' : 'Tracking events'}
      >
        {/* ── Column group for fixed widths ── */}
        <colgroup>
          {visibleColumns.map(col => (
            <col key={col.key} style={{ width: col.width, minWidth: col.width }} />
          ))}
        </colgroup>

        {/* ── Header ── */}
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
            {visibleColumns.map(col => (
              <th
                key={col.key}
                scope="col"
                className={cn(
                  'table-header-cell table-cell',
                  // Numeric columns: always right-aligned
                  col.align === 'end' && 'table-cell-numeric',
                  // Text alignment via logical property
                  col.align === 'start' ? 'text-start' : 'text-end',
                  'text-slate-500 dark:text-slate-400',
                )}
              >
                {isAr ? col.labelAr : col.labelEn}
              </th>
            ))}
          </tr>
        </thead>

        {/* ── Body ── */}
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.id}
              className={cn(
                'border-b border-slate-100 dark:border-slate-800/50',
                'hover:bg-slate-50/50 dark:hover:bg-slate-800/30',
                'transition-colors duration-75',
                // Last row: no border
                i === rows.length - 1 && 'border-b-0',
              )}
            >
              {/* Event name — always Inter LTR */}
              {visibleColumns.some(c => c.key === 'event') && (
                <td className="table-cell text-start">
                  <EventName
                    name={row.eventName}
                    platform={row.platform}
                    showBadge
                    maxLength={30}
                    size="sm"
                    weight="medium"
                  />
                </td>
              )}

              {/* Arabic label — IBM Plex Sans Arabic RTL */}
              {visibleColumns.some(c => c.key === 'label') && showArabicLabel && (
                <td className="table-cell">
                  {row.labelAr ? (
                    <LocalizedText
                      locale="ar-SA"
                      variant="ui-ar"
                      size="base"
                      truncate
                      className="block max-w-[160px]"
                    >
                      {row.labelAr}
                    </LocalizedText>
                  ) : (
                    <span className="text-slate-400 text-xs font-ui-en">—</span>
                  )}
                </td>
              )}

              {/* Conversions — Inter tabular right-aligned */}
              {visibleColumns.some(c => c.key === 'conv') && (
                <td className="table-cell table-cell-numeric">
                  <MetricValue
                    value={row.conversions}
                    locale={locale}
                    formatter="number"
                    size="base"
                    weight="medium"
                  />
                </td>
              )}

              {/* Revenue — SAR currency */}
              {visibleColumns.some(c => c.key === 'revenue') && (
                <td className="table-cell table-cell-numeric">
                  <CurrencyValue
                    amount={row.revenue}
                    locale={locale}
                    size="base"
                    weight="medium"
                  />
                </td>
              )}

              {/* ROAS */}
              {visibleColumns.some(c => c.key === 'roas') && (
                <td className="table-cell table-cell-numeric">
                  <MetricValue
                    value={row.roas}
                    formatter="roas"
                    size="base"
                    weight="semibold"
                    className={cn(
                      row.roas >= 3 ? 'text-emerald-600 dark:text-emerald-400'
                    : row.roas >= 1 ? 'text-slate-700 dark:text-slate-200'
                    :                 'text-red-600 dark:text-red-400',
                    )}
                  />
                </td>
              )}

              {/* CVR — percentage, color-coded */}
              {visibleColumns.some(c => c.key === 'cvr') && (
                <td className="table-cell table-cell-numeric">
                  <PercentageValue
                    value={row.conversionRate * 100}
                    locale={locale}
                    size="base"
                    decimals={2}
                  />
                </td>
              )}

              {/* Cost per result */}
              {visibleColumns.some(c => c.key === 'cpr') && (
                <td className="table-cell table-cell-numeric">
                  <CurrencyValue
                    amount={row.costPerResult}
                    locale={locale}
                    decimals={2}
                    size="base"
                  />
                </td>
              )}

              {/* Revenue delta */}
              {visibleColumns.some(c => c.key === 'delta') && (
                <td className="table-cell table-cell-numeric">
                  <PercentageValue
                    value={row.deltaRevenue * 100}
                    locale={locale}
                    size="base"
                    weight="semibold"
                    showSign
                    colorCode
                    positiveIsGood
                  />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Example usage (for Storybook / tests) ─────────────────────────────────────

export const SAMPLE_ROWS: EventRow[] = [
  {
    id:             'evt-001',
    eventName:      'GA4 Purchase',
    platform:       'ga4',
    labelAr:        'حدث الشراء - GA4',
    conversions:    2847,
    revenue:        284500,
    roas:           4.78,
    conversionRate: 0.0324,
    costPerResult:  25.60,
    deltaRevenue:   0.184,
  },
  {
    id:             'evt-002',
    eventName:      'Meta Purchase',
    platform:       'meta',
    labelAr:        'حدث الشراء - ميتا',
    conversions:    1240,
    revenue:        156800,
    roas:           3.21,
    conversionRate: 0.0189,
    costPerResult:  48.30,
    deltaRevenue:   -0.032,
  },
  {
    id:             'evt-003',
    eventName:      'TikTok ViewContent',
    platform:       'tiktok',
    labelAr:        'مشاهدة المحتوى - تيك توك',
    conversions:    18400,
    revenue:        0,
    roas:           0,
    conversionRate: 0.1240,
    costPerResult:  1.20,
    deltaRevenue:   0.456,
  },
  {
    id:             'evt-004',
    eventName:      'Snap Purchase',
    platform:       'snapchat',
    labelAr:        'حدث الشراء - سناب شات',
    conversions:    340,
    revenue:        42000,
    roas:           2.10,
    conversionRate: 0.0098,
    costPerResult:  88.50,
    deltaRevenue:   -0.118,
  },
]
