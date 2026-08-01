'use client'

/**
 * PART 5 — Attribution Chart
 *
 * Supports 6 attribution models:
 *   first-click, last-click, linear, time-decay, position-based, data-driven
 *
 * direction policy: preserve (flow is meaningful — top→bottom channel hierarchy)
 *
 * Renders as a horizontal bar chart with:
 *  - Model selector tabs
 *  - Channel breakdown
 *  - Revenue + conversions columns
 *  - Weight bars
 *  - RTL channel labels
 */

import { useState, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { useChartContext } from '../core/context'
import { ChartContainer } from '../primitives/ChartContainer'
import { useChartState } from '../hooks/useChartState'
import { seriesColor, chartCssVars } from '../themes/chart-tokens'
import { formatCurrency, formatNumber, formatPercent, formatROAS } from '@/lib/formatters'
import type { AttributionChartProps, AttributionModel } from '../core/types'

const MODEL_LABELS: Record<AttributionModel, { en: string; ar: string }> = {
  'first-click':    { en: 'First Click',     ar: 'النقرة الأولى' },
  'last-click':     { en: 'Last Click',      ar: 'النقرة الأخيرة' },
  'linear':         { en: 'Linear',          ar: 'خطي' },
  'time-decay':     { en: 'Time Decay',      ar: 'التراجع الزمني' },
  'position-based': { en: 'Position Based',  ar: 'الموضع' },
  'data-driven':    { en: 'Data Driven',     ar: 'مدفوع بالبيانات' },
}

export function AttributionChart({
  data,
  activeModel,
  onModelChange,
  compareModel,
  currency       = 'SAR',
  height         = 360,
  bare,
  className,
  locale:        localeProp,
  direction:     directionProp,
  tenantPalette,
  ariaLabel,
  ariaLabelAr,
}: AttributionChartProps) {
  const ctx       = useChartContext()
  const locale    = localeProp    ?? ctx.locale
  const palette   = tenantPalette ?? ctx.tenantPalette
  const isAr      = locale.startsWith('ar')

  const { chartState } = useChartState()

  const modelData    = data.filter(d => d.model === activeModel)
  const compareData  = compareModel ? data.filter(d => d.model === compareModel) : []
  const maxRevenue   = Math.max(...modelData.map(d => d.revenue), 1)

  const models = [...new Set(data.map(d => d.model))]

  return (
    <ChartContainer
      chartState={chartState}
      height={height}
      bare={bare}
      className={className}
      ariaLabel={ariaLabel ?? (isAr ? 'مخطط الإسناد' : 'Attribution chart')}
      ariaLabelAr={ariaLabelAr}
    >
      {/* Model tabs */}
      <div
        className={cn(
          'flex gap-1 px-4 py-2 border-b border-border-default overflow-x-auto',
          isAr && 'flex-row-reverse',
        )}
        role="tablist"
        aria-label={isAr ? 'نموذج الإسناد' : 'Attribution model'}
      >
        {models.map(model => {
          const label = isAr ? MODEL_LABELS[model].ar : MODEL_LABELS[model].en
          return (
            <button
              key={model}
              role="tab"
              aria-selected={model === activeModel}
              onClick={() => onModelChange?.(model)}
              className={cn(
                'px-2.5 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors',
                isAr ? 'font-ui-ar' : 'font-ui-en',
                model === activeModel
                  ? 'bg-action-primary text-action-primary-text'
                  : 'text-text-secondary hover:bg-bg-subtle',
              )}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* Channel table */}
      <div className="overflow-auto" style={{ height: height - 80 }}>
        <table className="w-full" dir={isAr ? 'rtl' : 'ltr'} role="grid">
          <thead>
            <tr className="border-b border-border-default">
              <th className={cn('px-4 py-2 text-xs font-semibold text-text-secondary text-start', isAr ? 'font-ui-ar' : 'font-ui-en')}>
                {isAr ? 'القناة' : 'Channel'}
              </th>
              <th className="px-4 py-2 text-xs font-semibold text-text-secondary text-end font-ui-en w-24">
                {isAr ? 'الوزن' : 'Weight'}
              </th>
              <th className="px-4 py-2 text-xs font-semibold text-text-secondary text-end font-ui-en w-28">
                {isAr ? 'الإيرادات' : 'Revenue'}
              </th>
              <th className="px-4 py-2 text-xs font-semibold text-text-secondary text-end font-ui-en w-24">
                {isAr ? 'التحويلات' : 'Conversions'}
              </th>
              {modelData.some(d => d.roas != null) && (
                <th className="px-4 py-2 text-xs font-semibold text-text-secondary text-end font-ui-en w-20">
                  ROAS
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {modelData
              .sort((a, b) => b.revenue - a.revenue)
              .map((entry, i) => {
                const cmpEntry = compareData.find(c => c.channel === entry.channel)
                const label    = isAr && entry.channelAr ? entry.channelAr : entry.channel
                const widthPct = maxRevenue > 0 ? (entry.revenue / maxRevenue) * 100 : 0
                const color    = seriesColor(i, palette)

                return (
                  <tr
                    key={`${entry.channel}-${entry.model}`}
                    className="border-b border-border-subtle hover:bg-bg-subtle transition-colors"
                  >
                    {/* Channel */}
                    <td className="px-4 py-2.5">
                      <div className={cn('flex items-center gap-2', isAr && 'flex-row-reverse')}>
                        <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: color }} />
                        <span className={cn('text-sm text-text-primary', isAr ? 'font-ui-ar' : 'font-ui-en')}>
                          {label}
                        </span>
                      </div>
                    </td>

                    {/* Weight bar */}
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5 justify-end">
                        <span className="font-number tabular-nums text-xs text-text-secondary" dir="ltr">
                          {formatPercent(entry.weight, locale, 1)}
                        </span>
                        <div className="w-12 h-1.5 bg-bg-subtle rounded-full overflow-hidden flex-shrink-0">
                          <div className="h-full rounded-full" style={{ width: `${widthPct}%`, background: color }} />
                        </div>
                      </div>
                    </td>

                    {/* Revenue */}
                    <td className="px-4 py-2.5 text-end">
                      <span className="font-number tabular-nums text-sm text-text-primary font-medium" dir="ltr">
                        {formatCurrency(entry.revenue, locale, currency as any)}
                      </span>
                      {cmpEntry && (
                        <DeltaChip
                          current={entry.revenue}
                          previous={cmpEntry.revenue}
                          locale={locale}
                        />
                      )}
                    </td>

                    {/* Conversions */}
                    <td className="px-4 py-2.5 text-end">
                      <span className="font-number tabular-nums text-sm text-text-primary" dir="ltr">
                        {formatNumber(entry.conversions, locale, 0)}
                      </span>
                    </td>

                    {/* ROAS */}
                    {modelData.some(d => d.roas != null) && (
                      <td className="px-4 py-2.5 text-end">
                        {entry.roas != null ? (
                          <span
                            className={cn(
                              'font-number tabular-nums text-sm font-semibold',
                              entry.roas >= 3 ? 'text-analytics-positive'
                              : entry.roas >= 1 ? 'text-text-primary'
                              : 'text-analytics-negative',
                            )}
                            dir="ltr"
                          >
                            {formatROAS(entry.roas)}
                          </span>
                        ) : (
                          <span className="text-text-tertiary">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>
    </ChartContainer>
  )
}

function DeltaChip({ current, previous, locale }: { current: number; previous: number; locale: string }) {
  if (previous === 0) return null
  const delta = (current - previous) / Math.abs(previous)
  const isPos = delta >= 0
  return (
    <div
      className={cn('text-2xs font-number tabular-nums font-semibold', isPos ? 'text-analytics-positive' : 'text-analytics-negative')}
      dir="ltr"
    >
      {isPos ? '+' : ''}{formatPercent(delta, locale as any, 1)}
    </div>
  )
}
