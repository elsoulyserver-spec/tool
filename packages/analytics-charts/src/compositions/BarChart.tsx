'use client'

import {
  BarChart as RechartsBarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Cell, ResponsiveContainer, LabelList,
} from 'recharts'
import { cn } from '@/lib/utils'
import { useChartContext } from '../core/context'
import { ChartContainer } from '../primitives/ChartContainer'
import { ChartTooltip } from '../tooltips/ChartTooltip'
import { ChartLegend, useLegendState } from '../legends/ChartLegend'
import { useChartState } from '../hooks/useChartState'
import { seriesColor, CHART_GEOMETRY, CHART_TYPOGRAPHY, chartCssVars } from '../themes/chart-tokens'
import { getChartRtlConfig, getYAxisOrientation, getRtlMargin, makeTickFormatter } from '../themes/direction-policy'
import { getAnimationDuration } from '../accessibility/a11y'
import { formatNumber, formatCurrency, formatPercent } from '@/lib/formatters'
import type { BarChartProps, ChartSeries } from '../core/types'

export function BarChart({
  data,
  seriesKeys,
  seriesLabels,
  seriesLabelsAr,
  stacked        = false,
  horizontal     = false,
  showValues     = false,
  valueFormat    = 'number',
  currency       = 'SAR',
  height         = 280,
  bare,
  className,
  locale:        localeProp,
  direction:     directionProp,
  tenantPalette,
  reducedMotion: reducedMotionProp,
  ariaLabel,
  ariaLabelAr,
}: BarChartProps) {
  const ctx       = useChartContext()
  const locale    = localeProp    ?? ctx.locale
  const direction = directionProp ?? ctx.direction
  const palette   = tenantPalette ?? ctx.tenantPalette
  const reduced   = reducedMotionProp ?? ctx.reducedMotion
  const isAr      = locale.startsWith('ar')

  const { chartState } = useChartState()

  // Build ChartSeries shape for legend
  const legendSeries: ChartSeries[] = seriesKeys.map((key, i) => ({
    id:      key,
    label:   seriesLabels?.[key]   ?? key,
    labelAr: seriesLabelsAr?.[key],
    data:    [],
    colorVar:seriesColor(i, palette),
  }))
  const { legendItems, toggleSeries, hiddenSeries } = useLegendState(legendSeries, palette)

  const { mirrorAxes, flipLegend } = getChartRtlConfig('bar', direction)
  const margin = getRtlMargin(CHART_GEOMETRY.marginDefault, mirrorAxes)
  const yOrient = getYAxisOrientation('primary', mirrorAxes)
  const animDuration = getAnimationDuration(reduced, CHART_GEOMETRY.animationDuration)

  const tickFormatter = makeTickFormatter(locale, (v) => {
    const n = Number(v)
    if (isNaN(n)) return String(v)
    if (valueFormat === 'currency') return formatCurrency(n, locale, currency as any)
    if (valueFormat === 'percent')  return formatPercent(n, locale, 0)
    return formatNumber(n, locale, 0)
  })

  const visibleKeys = seriesKeys.filter(k => !hiddenSeries.has(k))
  const barRadius   = horizontal ? CHART_GEOMETRY.barRadiusHoriz : CHART_GEOMETRY.barRadius
  const stackId     = stacked ? 'stack' : undefined

  // For horizontal bar charts, swap X and Y
  const XAxisComp = horizontal ? YAxis : XAxis
  const YAxisComp = horizontal ? XAxis : YAxis

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
        <RechartsBarChart
          data={data}
          margin={margin}
          layout={horizontal ? 'vertical' : 'horizontal'}
          barCategoryGap={CHART_GEOMETRY.barCategoryGap}
          barGap={CHART_GEOMETRY.barGap}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={chartCssVars.grid}
            strokeWidth={CHART_GEOMETRY.gridStrokeWidth}
            vertical={!horizontal}
            horizontal={horizontal}
          />

          <XAxisComp
            dataKey={horizontal ? undefined : 'x'}
            type={horizontal ? 'number' : 'category'}
            tickFormatter={horizontal ? tickFormatter as any : undefined}
            tick={{ fontSize: CHART_TYPOGRAPHY.tickFontSize, fill: chartCssVars.tick, fontFamily: CHART_TYPOGRAPHY.tickFontFamily }}
            axisLine={horizontal ? false : { stroke: chartCssVars.axis }}
            tickLine={false}
            reversed={mirrorAxes && !horizontal}
          />

          <YAxisComp
            dataKey={horizontal ? 'x' : undefined}
            type={horizontal ? 'category' : 'number'}
            orientation={horizontal ? undefined : yOrient}
            tickFormatter={horizontal ? undefined : tickFormatter as any}
            tick={{
              fontSize: isAr ? CHART_TYPOGRAPHY.labelFontSizeAr : CHART_TYPOGRAPHY.tickFontSize,
              fill: chartCssVars.tick,
              fontFamily: isAr ? CHART_TYPOGRAPHY.labelFontFamilyAr : CHART_TYPOGRAPHY.tickFontFamily,
            }}
            axisLine={false}
            tickLine={false}
            width={horizontal ? 120 : 44}
          />

          <Tooltip
            cursor={{ fill: chartCssVars.selection, fillOpacity: 0.3 }}
            content={({ active, payload, label }) => (
              <ChartTooltip
                active={active}
                payload={payload as any}
                label={label}
                locale={locale}
                format={valueFormat}
                currency={currency}
                seriesLabels={seriesLabels}
                seriesLabelsAr={seriesLabelsAr}
              />
            )}
          />

          {visibleKeys.map((key, i) => (
            <Bar
              key={key}
              dataKey={key}
              name={isAr && seriesLabelsAr?.[key] ? seriesLabelsAr[key] : (seriesLabels?.[key] ?? key)}
              fill={seriesColor(seriesKeys.indexOf(key), palette)}
              stackId={stackId}
              radius={!stacked || key === visibleKeys[visibleKeys.length - 1] ? barRadius : [0, 0, 0, 0]}
              isAnimationActive={!reduced}
              animationDuration={animDuration}
            >
              {showValues && (
                <LabelList
                  dataKey={key}
                  position={horizontal ? 'right' : 'top'}
                  formatter={(v: number) => {
                    if (valueFormat === 'currency') return formatCurrency(v, locale, currency as any)
                    if (valueFormat === 'percent')  return formatPercent(v, locale, 0)
                    return formatNumber(v, locale, 0)
                  }}
                  style={{
                    fontSize: 10,
                    fill: chartCssVars.tick,
                    fontFamily: CHART_TYPOGRAPHY.tickFontFamily,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                />
              )}
            </Bar>
          ))}
        </RechartsBarChart>
      </ResponsiveContainer>

      <div className={cn('px-4 pb-3', flipLegend && 'flex justify-end')}>
        <ChartLegend items={legendItems} locale={locale} direction={direction} onToggle={toggleSeries} />
      </div>
    </ChartContainer>
  )
}

// ── StackedBarChart ───────────────────────────────────────────────────────────

export function StackedBarChart(props: BarChartProps) {
  return <BarChart {...props} stacked={true} />
}
