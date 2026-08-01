'use client'

/**
 * PART 5 — Revenue Chart
 *
 * Composite chart combining:
 *  - Revenue bars (primary Y)
 *  - ROAS line (secondary Y)
 *  - Spend area (optional)
 *  - CAC / LTV trend (optional)
 *
 * RTL: rtl-aware
 * Numbers: always Inter + dir=ltr
 * Currency: formatCurrency with locale-aware SAR/AED/etc.
 */

import {
  ComposedChart, Bar, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { useChartContext } from '../core/context'
import { ChartContainer } from '../primitives/ChartContainer'
import { makeAnalyticsTooltip } from '../tooltips/ChartTooltip'
import { ChartLegend, useLegendState } from '../legends/ChartLegend'
import { useChartState } from '../hooks/useChartState'
import { chartCssVars, CHART_GEOMETRY, CHART_TYPOGRAPHY, seriesColor } from '../themes/chart-tokens'
import { getChartRtlConfig, getYAxisOrientation, getRtlMargin, makeTickFormatter } from '../themes/direction-policy'
import { getAnimationDuration } from '../accessibility/a11y'
import { formatCurrency, formatROAS, formatDate } from '@/lib/formatters'
import type { RevenueDataPoint, BaseChartProps, ChartSeries } from '../core/types'

export interface RevenueChartProps extends BaseChartProps {
  data:          RevenueDataPoint[]
  currency?:     string
  showROAS?:     boolean
  showSpend?:    boolean
  showCAC?:      boolean
  showLTV?:      boolean
  showMargin?:   boolean
  /** Target ROAS reference line */
  targetROAS?:   number
}

export function RevenueChart({
  data,
  currency       = 'SAR',
  showROAS       = true,
  showSpend      = true,
  showCAC        = false,
  showLTV        = false,
  showMargin     = false,
  targetROAS,
  height         = 320,
  bare,
  className,
  locale:        localeProp,
  direction:     directionProp,
  tenantPalette,
  reducedMotion: reducedMotionProp,
  ariaLabel,
  ariaLabelAr,
}: RevenueChartProps) {
  const ctx       = useChartContext()
  const locale    = localeProp    ?? ctx.locale
  const direction = directionProp ?? ctx.direction
  const palette   = tenantPalette ?? ctx.tenantPalette
  const reduced   = reducedMotionProp ?? ctx.reducedMotion
  const isAr      = locale.startsWith('ar')

  const { chartState } = useChartState()
  const animDuration   = getAnimationDuration(reduced, CHART_GEOMETRY.animationDuration)

  const { mirrorAxes, flipLegend } = getChartRtlConfig('revenue', direction)
  const margin = getRtlMargin({ ...CHART_GEOMETRY.marginDefault, right: 56 }, mirrorAxes)
  const yOrient    = getYAxisOrientation('primary', mirrorAxes)
  const y2Orient   = getYAxisOrientation('secondary', mirrorAxes)

  const revenueFormatter = makeTickFormatter(locale, (v) => formatCurrency(Number(v), locale as any, currency as any))
  const roasFormatter    = makeTickFormatter(locale, (v) => `${Number(v).toFixed(1)}x`)

  const TooltipContent = makeAnalyticsTooltip({
    revenueKey: 'y',
    roasKey:    'roas',
    currency,
    vatInclusive: false,
  })

  // Build legend series
  const legendSeries: ChartSeries[] = [
    { id: 'y',      label: isAr ? 'الإيرادات' : 'Revenue', labelAr: 'الإيرادات', data: [], colorVar: seriesColor(0, palette) },
    ...(showSpend  ? [{ id: 'spend',  label: isAr ? 'الإنفاق' : 'Spend',   labelAr: 'الإنفاق',  data: [], colorVar: seriesColor(1, palette) }] : []),
    ...(showROAS   ? [{ id: 'roas',   label: 'ROAS',  data: [], colorVar: chartCssVars.positive }] : []),
    ...(showMargin ? [{ id: 'margin', label: isAr ? 'الهامش' : 'Margin', labelAr: 'الهامش', data: [], colorVar: seriesColor(2, palette) }] : []),
  ]

  const { legendItems, toggleSeries, hiddenSeries } = useLegendState(legendSeries, palette)

  const gradRevId  = 'rev-grad'
  const gradSpendId= 'spend-grad'

  return (
    <ChartContainer
      chartState={chartState}
      height={height}
      bare={bare}
      className={className}
      ariaLabel={ariaLabel}
      ariaLabelAr={ariaLabelAr}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={margin}>
          <defs>
            <linearGradient id={gradRevId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={seriesColor(0, palette)} stopOpacity={0.18} />
              <stop offset="100%" stopColor={seriesColor(0, palette)} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id={gradSpendId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={seriesColor(1, palette)} stopOpacity={0.12} />
              <stop offset="100%" stopColor={seriesColor(1, palette)} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke={chartCssVars.grid} vertical={false} />

          <XAxis
            dataKey="x"
            tickFormatter={(v) => {
              try { return formatDate(new Date(v), locale as any, 'short') } catch { return String(v) }
            }}
            tick={{ fontSize: 11, fill: chartCssVars.tick, fontFamily: CHART_TYPOGRAPHY.tickFontFamily }}
            axisLine={{ stroke: chartCssVars.axis }}
            tickLine={false}
            reversed={mirrorAxes}
          />

          {/* Revenue Y-axis */}
          <YAxis
            yAxisId="revenue"
            orientation={yOrient}
            tickFormatter={revenueFormatter as any}
            tick={{ fontSize: 10, fill: chartCssVars.tick, fontFamily: CHART_TYPOGRAPHY.tickFontFamily }}
            axisLine={false}
            tickLine={false}
            width={56}
          />

          {/* ROAS Y-axis */}
          {showROAS && (
            <YAxis
              yAxisId="roas"
              orientation={y2Orient}
              tickFormatter={roasFormatter as any}
              tick={{ fontSize: 10, fill: chartCssVars.positive, fontFamily: CHART_TYPOGRAPHY.tickFontFamily }}
              axisLine={false}
              tickLine={false}
              width={36}
            />
          )}

          <Tooltip
            content={({ active, payload, label }) => (
              <TooltipContent active={active} payload={payload as any} label={label} locale={locale as any} />
            )}
            cursor={{ fill: chartCssVars.selection, fillOpacity: 0.2 }}
          />

          {/* Target ROAS reference line */}
          {showROAS && targetROAS != null && (
            <ReferenceLine
              yAxisId="roas"
              y={targetROAS}
              stroke={chartCssVars.positive}
              strokeDasharray="4 2"
              label={{
                value: isAr ? `هدف ROAS: ${targetROAS}x` : `Target ROAS: ${targetROAS}x`,
                position: 'insideTopRight',
                fontSize: 10,
                fill: chartCssVars.tick,
                fontFamily: isAr ? CHART_TYPOGRAPHY.labelFontFamilyAr : CHART_TYPOGRAPHY.labelFontFamily,
              }}
            />
          )}

          {/* Spend area */}
          {showSpend && !hiddenSeries.has('spend') && (
            <Area
              yAxisId="revenue"
              dataKey="spend"
              name={isAr ? 'الإنفاق' : 'Spend'}
              stroke={seriesColor(1, palette)}
              fill={`url(#${gradSpendId})`}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={!reduced}
              animationDuration={animDuration}
            />
          )}

          {/* Revenue bars */}
          {!hiddenSeries.has('y') && (
            <Bar
              yAxisId="revenue"
              dataKey="y"
              name={isAr ? 'الإيرادات' : 'Revenue'}
              fill={seriesColor(0, palette)}
              fillOpacity={0.9}
              radius={CHART_GEOMETRY.barRadius}
              isAnimationActive={!reduced}
              animationDuration={animDuration}
            />
          )}

          {/* ROAS line */}
          {showROAS && !hiddenSeries.has('roas') && (
            <Line
              yAxisId="roas"
              dataKey="roas"
              name="ROAS"
              stroke={chartCssVars.positive}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: chartCssVars.positive, strokeWidth: 2, fill: 'var(--semantic-color-bg-default)' }}
              isAnimationActive={!reduced}
              animationDuration={animDuration}
            />
          )}

          {/* Margin line */}
          {showMargin && !hiddenSeries.has('margin') && (
            <Line
              yAxisId="revenue"
              dataKey="margin"
              name={isAr ? 'الهامش' : 'Margin'}
              stroke={seriesColor(2, palette)}
              strokeWidth={2}
              strokeDasharray="5 3"
              dot={false}
              isAnimationActive={!reduced}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      <div className="px-4 pb-3">
        <ChartLegend items={legendItems} locale={locale as any} direction={direction} onToggle={toggleSeries} />
      </div>
    </ChartContainer>
  )
}
