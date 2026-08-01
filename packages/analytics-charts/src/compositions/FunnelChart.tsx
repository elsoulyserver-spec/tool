'use client'

/**
 * FunnelChart — direction policy: "preserve" (never mirrors)
 *
 * Recharts has a Funnel component but it's limited.
 * We implement a custom SVG funnel for enterprise control:
 *  - Trapezoid shapes with smooth transitions
 *  - Conversion rates between stages
 *  - Dropoff labels
 *  - RTL text labels
 */

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { useChartContext } from '../core/context'
import { ChartContainer } from '../primitives/ChartContainer'
import { useChartState } from '../hooks/useChartState'
import { seriesColor, chartCssVars, CHART_TYPOGRAPHY } from '../themes/chart-tokens'
import { formatNumber, formatPercent } from '@/lib/formatters'
import type { FunnelChartProps } from '../core/types'

export function FunnelChart({
  stages,
  showConversionRates = true,
  showDropoff         = true,
  height              = 320,
  bare,
  className,
  locale:             localeProp,
  direction:          directionProp,
  tenantPalette,
  reducedMotion:      reducedMotionProp,
  ariaLabel,
  ariaLabelAr,
}: FunnelChartProps) {
  const ctx       = useChartContext()
  const locale    = localeProp    ?? ctx.locale
  const palette   = tenantPalette ?? ctx.tenantPalette
  const isAr      = locale.startsWith('ar')

  const { chartState } = useChartState()

  if (!stages.length) return null

  const maxValue = Math.max(...stages.map(s => s.value))

  // SVG funnel geometry
  const SVG_W   = 400
  const SVG_H   = height - 60   // leave room for labels
  const BAR_H   = Math.floor((SVG_H - (stages.length - 1) * 6) / stages.length)
  const MAX_W   = SVG_W * 0.8
  const MIN_W   = SVG_W * 0.2

  const stageGeometry = stages.map((stage, i) => {
    const ratio    = maxValue > 0 ? stage.value / maxValue : 1
    const barW     = MIN_W + ratio * (MAX_W - MIN_W)
    const y        = i * (BAR_H + 6)
    const x        = (SVG_W - barW) / 2
    const nextStage= stages[i + 1]
    const conversion = nextStage && stage.value > 0
      ? nextStage.value / stage.value
      : null

    return { stage, barW, x, y, conversion, index: i }
  })

  return (
    <ChartContainer
      chartState={chartState}
      height={height}
      bare={bare}
      className={className}
      ariaLabel={ariaLabel ?? (isAr ? 'مسار التحويل' : 'Conversion funnel')}
    >
      <div
        className="w-full flex flex-col items-center"
        dir={isAr ? 'rtl' : 'ltr'}
        role="img"
        aria-label={isAr ? 'مسار التحويل' : 'Conversion funnel'}
      >
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          style={{ width: '100%', height: SVG_H }}
          aria-hidden="true"
        >
          {stageGeometry.map(({ stage, barW, x, y, conversion, index }) => {
            const color = stage.color ?? seriesColor(index, palette)
            const label = isAr && stage.labelAr ? stage.labelAr : stage.label
            const nextGeo = stageGeometry[index + 1]

            return (
              <g key={stage.id}>
                {/* Trapezoid */}
                {nextGeo ? (
                  <path
                    d={`
                      M ${x} ${y}
                      L ${x + barW} ${y}
                      L ${(SVG_W - nextGeo.barW) / 2 + nextGeo.barW} ${y + BAR_H + 3}
                      L ${(SVG_W - nextGeo.barW) / 2} ${y + BAR_H + 3}
                      Z
                    `}
                    fill={color}
                    fillOpacity={0.85}
                  />
                ) : (
                  <rect x={x} y={y} width={barW} height={BAR_H} rx={4} fill={color} fillOpacity={0.85} />
                )}

                {/* Stage label */}
                <text
                  x={SVG_W / 2}
                  y={y + BAR_H / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={CHART_TYPOGRAPHY.tickFontSize}
                  fontFamily={isAr ? CHART_TYPOGRAPHY.labelFontFamilyAr : CHART_TYPOGRAPHY.labelFontFamily}
                  fill="white"
                  fontWeight={600}
                >
                  {label}
                </text>

                {/* Value label (right side) */}
                <text
                  x={x + barW + 8}
                  y={y + BAR_H / 2}
                  dominantBaseline="middle"
                  fontSize={10}
                  fontFamily={CHART_TYPOGRAPHY.tickFontFamily}
                  fill={chartCssVars.tick}
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatNumber(stage.value, locale, 0)}
                </text>

                {/* Conversion rate between stages */}
                {showConversionRates && conversion != null && (
                  <text
                    x={SVG_W - 4}
                    y={y + BAR_H + 3}
                    dominantBaseline="middle"
                    textAnchor="end"
                    fontSize={9}
                    fontFamily={CHART_TYPOGRAPHY.tickFontFamily}
                    fill={chartCssVars.negative}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatPercent(conversion, locale, 1)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>

        {/* SR table */}
        <table className="sr-only">
          <caption>{isAr ? 'بيانات مسار التحويل' : 'Funnel data'}</caption>
          <thead><tr><th>{isAr ? 'المرحلة' : 'Stage'}</th><th>{isAr ? 'القيمة' : 'Value'}</th><th>{isAr ? 'نسبة التحويل' : 'Conversion'}</th></tr></thead>
          <tbody>
            {stages.map((s, i) => (
              <tr key={s.id}>
                <td>{isAr && s.labelAr ? s.labelAr : s.label}</td>
                <td>{formatNumber(s.value, locale, 0)}</td>
                <td>{stageGeometry[i]?.conversion != null ? formatPercent(stageGeometry[i].conversion!, locale, 1) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartContainer>
  )
}
