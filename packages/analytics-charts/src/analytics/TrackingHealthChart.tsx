'use client'

/**
 * PART 5 — Tracking + CAPI Health Charts
 *
 * EventVolumeChart:    events/hour with error overlay
 * CAPIMetricsChart:    EMQ score, delivery rate, deduplication
 * AuditSeverityChart:  donut of critical/warning/info issues
 */

import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { cn } from '@/lib/utils'
import { useChartContext } from '../core/context'
import { ChartContainer } from '../primitives/ChartContainer'
import { ChartTooltip } from '../tooltips/ChartTooltip'
import { useChartState } from '../hooks/useChartState'
import { chartCssVars, CHART_GEOMETRY, CHART_TYPOGRAPHY } from '../themes/chart-tokens'
import { getChartRtlConfig, getRtlMargin, getYAxisOrientation, makeTickFormatter } from '../themes/direction-policy'
import { getAnimationDuration } from '../accessibility/a11y'
import { formatNumber, formatPercent, formatDate } from '@/lib/formatters'
import type { TrackingHealthPoint, CAPIMetrics, BaseChartProps } from '../core/types'

// ── EventVolumeChart ──────────────────────────────────────────────────────────

export interface EventVolumeChartProps extends BaseChartProps {
  data:       TrackingHealthPoint[]
  /** Show error rate line overlay */
  showErrors?:   boolean
  /** Threshold line — events/hour target */
  volumeTarget?: number
}

export function EventVolumeChart({
  data,
  showErrors   = true,
  volumeTarget,
  height       = 260,
  bare,
  className,
  locale:      localeProp,
  direction:   directionProp,
  reducedMotion: redProp,
  ariaLabel,
  ariaLabelAr,
}: EventVolumeChartProps) {
  const ctx       = useChartContext()
  const locale    = localeProp    ?? ctx.locale
  const direction = directionProp ?? ctx.direction
  const reduced   = redProp       ?? ctx.reducedMotion
  const isAr      = locale.startsWith('ar')

  const { chartState } = useChartState()
  const animDuration   = getAnimationDuration(reduced, CHART_GEOMETRY.animationDuration)
  const { mirrorAxes } = getChartRtlConfig('bar', direction)
  const margin         = getRtlMargin({ ...CHART_GEOMETRY.marginDefault, right: 48 }, mirrorAxes)
  const yOrient        = getYAxisOrientation('primary', mirrorAxes)
  const y2Orient       = getYAxisOrientation('secondary', mirrorAxes)

  const volLabel  = isAr ? 'حجم الأحداث' : 'Event Volume'
  const errLabel  = isAr ? 'معدل الخطأ'  : 'Error Rate'
  const missLabel = isAr ? 'أحداث مفقودة' : 'Missing'
  const dupLabel  = isAr ? 'مكررة'        : 'Duplicates'

  return (
    <ChartContainer
      chartState={chartState}
      height={height}
      bare={bare}
      className={className}
      ariaLabel={ariaLabel ?? (isAr ? 'مخطط حجم الأحداث' : 'Event volume chart')}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={margin}>
          <CartesianGrid strokeDasharray="3 3" stroke={chartCssVars.grid} vertical={false} />

          <XAxis
            dataKey="x"
            tickFormatter={(v) => { try { return formatDate(new Date(v as string), locale as any, 'short') } catch { return String(v) } }}
            tick={{ fontSize: 11, fill: chartCssVars.tick, fontFamily: CHART_TYPOGRAPHY.tickFontFamily }}
            axisLine={{ stroke: chartCssVars.axis }}
            tickLine={false}
            reversed={mirrorAxes}
          />
          <YAxis yAxisId="volume" orientation={yOrient} tick={{ fontSize: 10, fill: chartCssVars.tick }} axisLine={false} tickLine={false} width={40} />
          {showErrors && (
            <YAxis yAxisId="error" orientation={y2Orient} tick={{ fontSize: 10, fill: chartCssVars.negative }} axisLine={false} tickLine={false} width={36} domain={[0, 1]} tickFormatter={(v) => formatPercent(v, locale as any, 0)} />
          )}

          <Tooltip
            content={({ active, payload, label }) => (
              <ChartTooltip
                active={active}
                payload={payload as any}
                label={label}
                locale={locale as any}
                seriesLabels={{ y: volLabel, errors: errLabel, missing: missLabel, duplicates: dupLabel }}
              />
            )}
            cursor={{ fill: chartCssVars.selection, fillOpacity: 0.2 }}
          />

          {volumeTarget && (
            <ReferenceLine yAxisId="volume" y={volumeTarget} stroke={chartCssVars.stale} strokeDasharray="4 2"
              label={{ value: isAr ? 'الهدف' : 'Target', position: 'insideTopRight', fontSize: 10, fill: chartCssVars.tick }} />
          )}

          {/* Volume bars */}
          <Bar yAxisId="volume" dataKey="y" name={volLabel} fill={chartCssVars.series1} fillOpacity={0.85} radius={[2, 2, 0, 0]} isAnimationActive={!reduced} animationDuration={animDuration} />

          {/* Missing events (stacked negative) */}
          <Bar yAxisId="volume" dataKey="missing" name={missLabel} fill={chartCssVars.warning} fillOpacity={0.7} radius={[2, 2, 0, 0]} isAnimationActive={!reduced} />

          {/* Duplicates */}
          <Bar yAxisId="volume" dataKey="duplicates" name={dupLabel} fill={chartCssVars.stale} fillOpacity={0.7} radius={[2, 2, 0, 0]} isAnimationActive={!reduced} />

          {/* Error rate line */}
          {showErrors && (
            <Line yAxisId="error" dataKey="errors" name={errLabel} stroke={chartCssVars.negative} strokeWidth={2} dot={false} isAnimationActive={!reduced} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartContainer>
  )
}

// ── CAPIHealthGauge ───────────────────────────────────────────────────────────
// Renders 4 CAPI KPI scores as gauge bars

export function CAPIHealthGauge({
  metrics,
  locale:    localeProp,
  className,
}: {
  metrics:   CAPIMetrics
  locale?:   string
  className?: string
}) {
  const ctx    = useChartContext()
  const locale = localeProp ?? ctx.locale
  const isAr   = locale.startsWith('ar')

  const kpis = [
    {
      key:   'eventMatchQuality',
      label: isAr ? 'جودة مطابقة الأحداث' : 'Event Match Quality',
      value: metrics.eventMatchQuality,
      max:   10,
      fmt:   (v: number) => `${v.toFixed(1)}/10`,
    },
    {
      key:   'eventDeliveryRate',
      label: isAr ? 'معدل تسليم الأحداث' : 'Event Delivery Rate',
      value: metrics.eventDeliveryRate,
      max:   1,
      fmt:   (v: number) => formatPercent(v, locale as any, 1),
    },
    {
      key:   'emqScore',
      label: isAr ? 'نقاط EMQ' : 'EMQ Score',
      value: metrics.emqScore,
      max:   10,
      fmt:   (v: number) => `${v.toFixed(1)}/10`,
    },
    {
      key:   'deduplicationRate',
      label: isAr ? 'معدل إزالة التكرار' : 'Deduplication Rate',
      value: metrics.deduplicationRate,
      max:   1,
      fmt:   (v: number) => formatPercent(v, locale as any, 1),
    },
  ]

  return (
    <div className={cn('grid grid-cols-2 gap-3', className)} dir={isAr ? 'rtl' : 'ltr'}>
      {kpis.map(({ key, label, value, max, fmt }) => {
        const pct      = Math.min(value / max, 1)
        const colorCls = pct >= 0.8 ? 'bg-analytics-positive'
                       : pct >= 0.6 ? 'bg-analytics-neutral'
                       :              'bg-analytics-negative'
        return (
          <div key={key} className="p-3 bg-bg-subtle rounded-lg border border-border-default">
            <div className={cn('text-xs text-text-secondary mb-1.5', isAr ? 'font-ui-ar text-right' : 'font-ui-en')}>
              {label}
            </div>
            <div className="flex items-center gap-2">
              <span className="font-number tabular-nums text-lg font-bold text-text-primary" dir="ltr">
                {fmt(value)}
              </span>
            </div>
            <div className="mt-2 w-full h-1.5 bg-bg-default rounded-full overflow-hidden">
              <div className={cn('h-full rounded-full transition-all', colorCls)} style={{ width: `${pct * 100}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
