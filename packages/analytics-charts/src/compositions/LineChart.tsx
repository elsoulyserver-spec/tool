'use client'

/**
 * LineChart + AreaChart + TimeSeriesChart + AnomalyChart
 *
 * Engine: Recharts ComposedChart (most flexible — layers Line, Area, Bar, etc.)
 *
 * RTL: rtl-aware — Y-axis on right, margin swapped, legend mirrors
 * Performance: LTTB sampling via useSeriesData
 * Accessibility: keyboard navigation, SR data table, aria-label
 */

import { useId, useState, useCallback } from 'react'
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea,
  Legend as RechartsLegend,
} from 'recharts'
import { cn } from '@/lib/utils'
import { useChartContext } from '../core/context'
import { ChartContainer } from '../primitives/ChartContainer'
import { ChartTooltip, ComparisonTooltip } from '../tooltips/ChartTooltip'
import { ChartLegend, ComparisonLegend, useLegendState } from '../legends/ChartLegend'
import { useSeriesData } from '../hooks/useChartData'
import { useChartState } from '../hooks/useChartState'
import { seriesColor, CHART_GEOMETRY, CHART_TYPOGRAPHY, chartCssVars } from '../themes/chart-tokens'
import { getChartRtlConfig, getYAxisOrientation, getRtlMargin, makeTickFormatter } from '../themes/direction-policy'
import { A11Y_STROKE_PATTERNS, makeChartKeyboardHandler, generateChartDescription, getAnimationDuration } from '../accessibility/a11y'
import { formatDate, formatNumber, formatCurrency } from '@/lib/formatters'
import type { TimeSeriesChartProps } from '../core/types'

// ── Shared x-axis tick formatter ──────────────────────────────────────────────

function formatXTick(value: string | number, locale: string): string {
  if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}/)) {
    try { return formatDate(new Date(value), locale as any, 'short') }
    catch { return String(value) }
  }
  return String(value)
}

// ── LineChart ─────────────────────────────────────────────────────────────────

export function LineChart({
  series,
  height        = 280,
  bare,
  className,
  locale:       localeProp,
  direction:    directionProp,
  compareMode,
  compareSeries,
  showAnomalyBands,
  anomalyData,
  annotations,
  aiSummary,
  onInsightClick,
  tenantPalette,
  reducedMotion: reducedMotionProp,
  ariaLabel,
  ariaLabelAr,
  ...containerProps
}: TimeSeriesChartProps & { title?: string; titleAr?: string; subtitle?: string }) {
  const ctx        = useChartContext()
  const locale     = localeProp    ?? ctx.locale
  const direction  = directionProp ?? ctx.direction
  const palette    = tenantPalette ?? ctx.tenantPalette
  const reduced    = reducedMotionProp ?? ctx.reducedMotion
  const isAr       = locale.startsWith('ar')
  const chartId    = useId()

  const { series: processedSeries, isProcessing } = useSeriesData(series, 'line')
  const { chartState, startLoad, setLoaded, setError, retry } = useChartState({ staleAfterMs: 900_000 })
  const { legendItems, toggleSeries, visibleSeries } = useLegendState(processedSeries, palette)

  // Track active tooltip index for keyboard navigation
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const { mirrorAxes, flipLegend } = getChartRtlConfig('line', direction)
  const margin = getRtlMargin(CHART_GEOMETRY.marginDefault, mirrorAxes)
  const yAxisOrientation = getYAxisOrientation('primary', mirrorAxes)
  const xTickFormatter   = makeTickFormatter(locale, (v) => formatXTick(v as string, locale))

  const chartDescription = generateChartDescription(series, locale, isAr ? 'خط بياني' : 'Line chart')

  const keyboardHandler = makeChartKeyboardHandler({
    onArrowRight: () => setActiveIndex(i => i == null ? 0 : Math.min(i + 1, (series[0]?.data.length ?? 1) - 1)),
    onArrowLeft:  () => setActiveIndex(i => i == null ? 0 : Math.max(i - 1, 0)),
  })

  const animDuration = getAnimationDuration(reduced, CHART_GEOMETRY.animationDuration)

  // Build flat data for Recharts ComposedChart (needs [{x, seriesId1, seriesId2}])
  const allXValues = [...new Set(visibleSeries.flatMap(s => s.data.map(d => d.x)))]
  const chartData  = allXValues.map(x => {
    const row: Record<string, unknown> = { x }
    for (const s of visibleSeries) {
      const pt = s.data.find(d => d.x === x)
      row[s.id] = pt?.y ?? null
    }
    if (compareMode && compareSeries?.length) {
      for (const s of compareSeries) {
        const pt = s.data.find(d => d.x === x)
        row[`__cmp_${s.id}`] = pt?.y ?? null
      }
    }
    if (showAnomalyBands && anomalyData) {
      const band = anomalyData.find(b => b.x === x)
      if (band) { row.__anom_upper = band.upper; row.__anom_lower = band.lower }
    }
    return row
  })

  const tooltipContent = compareMode
    ? <ComparisonTooltip locale={locale} format="number" active={false} />
    : <ChartTooltip locale={locale} format="number" active={false} />

  return (
    <ChartContainer
      chartState={isProcessing ? 'loading' : chartState}
      height={height}
      bare={bare}
      className={className}
      ariaLabel={ariaLabel}
      ariaLabelAr={ariaLabelAr}
      aiSummary={aiSummary}
      onInsightClick={onInsightClick}
      {...containerProps}
    >
      <div
        role="img"
        aria-label={isAr && ariaLabelAr ? ariaLabelAr : (ariaLabel ?? chartDescription)}
        tabIndex={0}
        onKeyDown={keyboardHandler}
        className="w-full h-full focus-visible:outline-2 focus-visible:outline-action-primary focus-visible:outline-offset-2 rounded"
      >
        {/* SR data table — visually hidden */}
        <div className="sr-only" aria-label={isAr ? 'بيانات المخطط' : 'Chart data'}>
          <table>
            <caption>{isAr ? 'بيانات الخط البياني' : 'Line chart data'}</caption>
            <thead>
              <tr>
                <th>{isAr ? 'الوقت' : 'Time'}</th>
                {visibleSeries.map(s => <th key={s.id}>{isAr && s.labelAr ? s.labelAr : s.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {chartData.slice(0, 50).map((row, i) => (
                <tr key={i}>
                  <td>{String(row.x)}</td>
                  {visibleSeries.map(s => <td key={s.id}>{String(row[s.id] ?? '—')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={margin}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke={chartCssVars.grid}
              strokeWidth={CHART_GEOMETRY.gridStrokeWidth}
              vertical={false}
            />

            <XAxis
              dataKey="x"
              tickFormatter={xTickFormatter as any}
              tick={{ fontSize: CHART_TYPOGRAPHY.tickFontSize, fill: chartCssVars.tick, fontFamily: CHART_TYPOGRAPHY.tickFontFamily }}
              axisLine={{ stroke: chartCssVars.axis }}
              tickLine={false}
              reversed={mirrorAxes}
            />

            <YAxis
              orientation={yAxisOrientation}
              tickFormatter={makeTickFormatter(locale) as any}
              tick={{ fontSize: CHART_TYPOGRAPHY.tickFontSize, fill: chartCssVars.tick, fontFamily: CHART_TYPOGRAPHY.tickFontFamily }}
              axisLine={false}
              tickLine={false}
              width={40}
            />

            <Tooltip
              content={({ active, payload, label }) =>
                compareMode ? (
                  <ComparisonTooltip
                    active={active}
                    payload={payload as any}
                    label={label}
                    locale={locale}
                    format="number"
                    seriesLabels={Object.fromEntries(visibleSeries.map(s => [s.id, s.label]))}
                    seriesLabelsAr={Object.fromEntries(visibleSeries.filter(s => s.labelAr).map(s => [s.id, s.labelAr!]))}
                  />
                ) : (
                  <ChartTooltip
                    active={active}
                    payload={payload as any}
                    label={label}
                    locale={locale}
                    format="number"
                    seriesLabels={Object.fromEntries(visibleSeries.map(s => [s.id, s.label]))}
                    seriesLabelsAr={Object.fromEntries(visibleSeries.filter(s => s.labelAr).map(s => [s.id, s.labelAr!]))}
                  />
                )
              }
              cursor={{ stroke: chartCssVars.crosshair, strokeWidth: CHART_GEOMETRY.crosshairWidth }}
            />

            {/* Anomaly bands */}
            {showAnomalyBands && (
              <>
                <Area dataKey="__anom_upper" fill={chartCssVars.warning} stroke="none" fillOpacity={0.1} legendType="none" />
                <Area dataKey="__anom_lower" fill={chartCssVars.chartBg}  stroke="none" fillOpacity={1}   legendType="none" />
              </>
            )}

            {/* Annotation reference lines */}
            {annotations?.map(ann => ann.type === 'reference-line' && ann.x != null ? (
              <ReferenceLine
                key={ann.id}
                x={ann.x}
                stroke={ann.color ?? chartCssVars.annotationMarker}
                strokeDasharray="4 2"
                label={{ value: ann.label ?? '', position: 'top', fontSize: 10, fill: chartCssVars.tick }}
              />
            ) : null)}

            {/* Annotation regions */}
            {annotations?.map(ann => ann.type === 'region' && ann.x != null && ann.xEnd != null ? (
              <ReferenceArea
                key={ann.id}
                x1={ann.x}
                x2={ann.xEnd}
                fill={ann.color ?? chartCssVars.annotationRegion}
                fillOpacity={0.15}
              />
            ) : null)}

            {/* Series lines */}
            {visibleSeries.map((s, i) => (
              <Line
                key={s.id}
                dataKey={s.id}
                name={isAr && s.labelAr ? s.labelAr : s.label}
                stroke={s.colorVar ?? s.color ?? seriesColor(i, palette)}
                strokeWidth={CHART_GEOMETRY.lineStrokeWidth}
                strokeDasharray={s.strokeDasharray ?? A11Y_STROKE_PATTERNS[i]}
                dot={false}
                activeDot={{
                  r: CHART_GEOMETRY.dotRadiusActive,
                  stroke: s.colorVar ?? s.color ?? seriesColor(i, palette),
                  strokeWidth: 2,
                  fill: 'var(--semantic-color-bg-default)',
                }}
                isAnimationActive={!reduced}
                animationDuration={animDuration}
                animationEasing={CHART_GEOMETRY.animationEasing}
                connectNulls={false}
              />
            ))}

            {/* Compare series — dashed */}
            {compareMode && compareSeries?.map((s, i) => (
              <Line
                key={`__cmp_${s.id}`}
                dataKey={`__cmp_${s.id}`}
                name={`${isAr && s.labelAr ? s.labelAr : s.label} (prev)`}
                stroke={s.colorVar ?? s.color ?? seriesColor(i, palette)}
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                isAnimationActive={false}
                legendType="none"
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* External legend */}
      <div className={cn('px-4 pb-3', flipLegend && 'flex justify-end')}>
        <ChartLegend
          items={legendItems}
          locale={locale}
          direction={direction}
          onToggle={toggleSeries}
        />
      </div>
    </ChartContainer>
  )
}

// ── AreaChart (wraps LineChart with showArea=true) ────────────────────────────

export function AreaChart(props: TimeSeriesChartProps) {
  // AreaChart is LineChart with Area components instead of Line
  // Implemented as a thin config wrapper
  const ctx        = useChartContext()
  const locale     = props.locale    ?? ctx.locale
  const direction  = props.direction ?? ctx.direction
  const palette    = props.tenantPalette ?? ctx.tenantPalette
  const reduced    = props.reducedMotion ?? ctx.reducedMotion
  const isAr       = locale.startsWith('ar')

  const { series: processedSeries } = useSeriesData(props.series, 'area')
  const { chartState }              = useChartState()
  const { legendItems, toggleSeries, visibleSeries } = useLegendState(processedSeries, palette)

  const { mirrorAxes, flipLegend } = getChartRtlConfig('area', direction)
  const margin = getRtlMargin(CHART_GEOMETRY.marginDefault, mirrorAxes)
  const yAxisOrientation = getYAxisOrientation('primary', mirrorAxes)
  const xTickFormatter   = makeTickFormatter(locale, (v) => formatXTick(v as string, locale))
  const animDuration     = getAnimationDuration(reduced, CHART_GEOMETRY.animationDuration)

  const allX   = [...new Set(visibleSeries.flatMap(s => s.data.map(d => d.x)))]
  const chartData = allX.map(x => {
    const row: Record<string, unknown> = { x }
    for (const s of visibleSeries) {
      const pt = s.data.find(d => d.x === x)
      row[s.id] = pt?.y ?? null
    }
    return row
  })

  return (
    <ChartContainer chartState={chartState} height={props.height ?? 280} bare={props.bare} className={props.className}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={margin}>
          <defs>
            {visibleSeries.map((s, i) => {
              const color = s.colorVar ?? s.color ?? seriesColor(i, palette)
              const gradId = `area-grad-${s.id.replace(/\W/g, '_')}`
              return (
                <linearGradient key={gradId} id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={color} stopOpacity={0.20} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              )
            })}
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke={chartCssVars.grid} vertical={false} />
          <XAxis dataKey="x" tickFormatter={xTickFormatter as any} tick={{ fontSize: 11, fill: chartCssVars.tick }} axisLine={{ stroke: chartCssVars.axis }} tickLine={false} reversed={mirrorAxes} />
          <YAxis orientation={yAxisOrientation} tick={{ fontSize: 11, fill: chartCssVars.tick }} axisLine={false} tickLine={false} width={40} />
          <Tooltip content={({ active, payload, label }) => (
            <ChartTooltip
              active={active} payload={payload as any} label={label} locale={locale}
              seriesLabels={Object.fromEntries(visibleSeries.map(s => [s.id, s.label]))}
              seriesLabelsAr={Object.fromEntries(visibleSeries.filter(s => s.labelAr).map(s => [s.id, s.labelAr!]))}
            />
          )} cursor={{ stroke: chartCssVars.crosshair, strokeWidth: 1 }} />

          {visibleSeries.map((s, i) => {
            const color  = s.colorVar ?? s.color ?? seriesColor(i, palette)
            const gradId = `area-grad-${s.id.replace(/\W/g, '_')}`
            return (
              <Area
                key={s.id}
                dataKey={s.id}
                name={isAr && s.labelAr ? s.labelAr : s.label}
                stroke={color}
                strokeWidth={CHART_GEOMETRY.areaStrokeWidth}
                fill={`url(#${gradId})`}
                dot={false}
                activeDot={{ r: 4, stroke: color, strokeWidth: 2, fill: 'var(--semantic-color-bg-default)' }}
                isAnimationActive={!reduced}
                animationDuration={animDuration}
              />
            )
          })}
        </ComposedChart>
      </ResponsiveContainer>
      <div className={cn('px-4 pb-3', flipLegend && 'flex justify-end')}>
        <ChartLegend items={legendItems} locale={locale} direction={direction} onToggle={toggleSeries} />
      </div>
    </ChartContainer>
  )
}

// ── TimeSeriesChart — alias with better defaults for time-based data ───────────
export const TimeSeriesChart = LineChart
