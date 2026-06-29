'use client'

/**
 * SparklineChart — ultra-compact SVG sparkline
 *
 * No Recharts dependency — pure SVG path for minimum bundle impact.
 * Used inline in tables, metric cards, KPI widgets.
 *
 * direction policy: preserve (no directional meaning)
 */

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { chartCssVars } from '../themes/chart-tokens'
import type { SparklineProps } from '../core/types'

export function SparklineChart({
  data,
  color,
  trend,
  height    = 32,
  width     = 80,
  className,
  showDot   = true,
  animated  = false,
}: SparklineProps) {
  const pathData = useMemo(() => {
    if (!data.length) return { d: '', lastX: 0, lastY: 0, areaD: '' }

    const PAD  = 2
    const W    = width  - PAD * 2
    const H    = height - PAD * 2
    const min  = Math.min(...data)
    const max  = Math.max(...data)
    const range= max - min || 1

    const points = data.map((v, i) => ({
      x: PAD + (i / (data.length - 1)) * W,
      y: H + PAD - ((v - min) / range) * H,
    }))

    const d = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
      .join(' ')

    const areaD = `${d} L ${(points.at(-1)!.x).toFixed(2)} ${H + PAD} L ${PAD} ${H + PAD} Z`

    return { d, lastX: points.at(-1)!.x, lastY: points.at(-1)!.y, areaD }
  }, [data, width, height])

  if (!data.length) return null

  const strokeColor = color
    ?? (trend === 'up'   ? chartCssVars.positive
    :  trend === 'down'  ? chartCssVars.negative
    :                      chartCssVars.series1)

  const gradId = `spark-grad-${Math.random().toString(36).slice(2, 8)}`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className={cn('overflow-visible', className)}
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={strokeColor} stopOpacity={0.25} />
          <stop offset="100%" stopColor={strokeColor} stopOpacity={0}    />
        </linearGradient>
      </defs>

      {/* Area fill */}
      <path d={pathData.areaD} fill={`url(#${gradId})`} />

      {/* Line */}
      <path
        d={pathData.d}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        style={animated ? { animation: 'sparkline-draw 0.6s ease forwards' } : undefined}
      />

      {/* Last point dot */}
      {showDot && (
        <circle
          cx={pathData.lastX}
          cy={pathData.lastY}
          r={3}
          fill={strokeColor}
          stroke="var(--semantic-color-bg-default)"
          strokeWidth={1.5}
        />
      )}
    </svg>
  )
}
