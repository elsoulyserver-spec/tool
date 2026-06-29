'use client'

import { PieChart as RechartsPieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { cn } from '@/lib/utils'
import { useChartContext } from '../core/context'
import { ChartContainer } from '../primitives/ChartContainer'
import { ChartTooltip } from '../tooltips/ChartTooltip'
import { useChartState } from '../hooks/useChartState'
import { seriesColor, chartCssVars, CHART_TYPOGRAPHY } from '../themes/chart-tokens'
import { getAnimationDuration } from '../accessibility/a11y'
import { formatNumber, formatCurrency, formatPercent } from '@/lib/formatters'
import type { PieChartProps } from '../core/types'

export function DonutChart({
  data,
  donut          = true,
  innerRadius    = 60,
  centerLabel,
  centerValue,
  centerValueFormat = 'number',
  showPercentages= false,
  height         = 280,
  bare,
  className,
  locale:        localeProp,
  direction:     directionProp,
  tenantPalette,
  reducedMotion: reducedMotionProp,
  ariaLabel,
  ariaLabelAr,
  currency,
}: PieChartProps & { currency?: string }) {
  const ctx       = useChartContext()
  const locale    = localeProp    ?? ctx.locale
  const palette   = tenantPalette ?? ctx.tenantPalette
  const reduced   = reducedMotionProp ?? ctx.reducedMotion
  const isAr      = locale.startsWith('ar')
  const direction = directionProp ?? ctx.direction

  const { chartState } = useChartState()
  const animDuration   = getAnimationDuration(reduced, 600)

  const total = data.reduce((acc, d) => acc + d.value, 0)

  const formattedCenter = centerValue != null
    ? centerValueFormat === 'currency' ? formatCurrency(Number(centerValue), locale, (currency ?? 'SAR') as any)
    : centerValueFormat === 'percent'  ? formatPercent(Number(centerValue), locale)
    :                                    formatNumber(Number(centerValue), locale)
    : undefined

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
        <RechartsPieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={donut ? `${innerRadius}%` : 0}
            outerRadius="75%"
            dataKey="value"
            nameKey={isAr ? 'labelAr' : 'label'}
            paddingAngle={2}
            isAnimationActive={!reduced}
            animationDuration={animDuration}
            animationEasing="ease-out"
          >
            {data.map((entry, i) => (
              <Cell
                key={entry.id}
                fill={entry.color ?? seriesColor(i, palette)}
                stroke="var(--semantic-color-bg-default)"
                strokeWidth={2}
              />
            ))}
          </Pie>

          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const entry = payload[0]
              const pct   = total > 0 ? (Number(entry.value) / total) : 0
              return (
                <ChartTooltip
                  active={active}
                  payload={[{
                    ...entry as any,
                    dataKey: entry.name,
                    value: showPercentages ? pct : entry.value,
                  }]}
                  label={isAr && (entry.payload as any)?.labelAr
                    ? (entry.payload as any).labelAr
                    : entry.name}
                  locale={locale}
                  format={showPercentages ? 'percent' : 'number'}
                />
              )
            }}
          />
        </RechartsPieChart>
      </ResponsiveContainer>

      {/* Center label for donut */}
      {donut && (centerLabel || formattedCenter) && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
          aria-hidden="true"
        >
          {formattedCenter && (
            <span
              className="font-number tabular-nums font-bold text-text-primary"
              style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums' }}
              dir="ltr"
            >
              {formattedCenter}
            </span>
          )}
          {centerLabel && (
            <span className={cn(
              'text-xs text-text-secondary mt-0.5',
              isAr ? 'font-ui-ar' : 'font-ui-en',
            )}>
              {centerLabel}
            </span>
          )}
        </div>
      )}

      {/* External legend */}
      <div className="px-4 pb-3">
        <div className={cn('flex flex-wrap gap-2', direction === 'rtl' && 'flex-row-reverse')}>
          {data.map((entry, i) => {
            const label = isAr && entry.labelAr ? entry.labelAr : entry.label
            const pct   = total > 0 ? ((entry.value / total) * 100).toFixed(1) : '0'
            return (
              <div
                key={entry.id}
                className={cn('flex items-center gap-1.5', direction === 'rtl' && 'flex-row-reverse')}
              >
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: entry.color ?? seriesColor(i, palette) }} />
                <span className={cn('text-xs text-text-secondary', isAr ? 'font-ui-ar' : 'font-ui-en')}>{label}</span>
                <span className="font-number tabular-nums text-xs text-text-tertiary" dir="ltr">{pct}%</span>
              </div>
            )
          })}
        </div>
      </div>
    </ChartContainer>
  )
}

export function PieChart(props: PieChartProps & { currency?: string }) {
  return <DonutChart {...props} donut={false} />
}
