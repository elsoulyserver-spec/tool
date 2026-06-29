/**
 * PART 6 — RTL Architecture: Chart Direction Policy
 *
 * Determines how each chart type behaves in RTL layouts.
 *
 * Three modes:
 *
 *  rtl-aware  → axes flip (Y-axis moves to right), legend mirrors,
 *               time flows right→left visually, tooltip anchor mirrors.
 *               Achieved by reversing Recharts margin and flipping axis positions.
 *
 *  preserve   → chart never mirrors regardless of page direction.
 *               Sankey, Funnel, Attribution flow top→bottom or left→right
 *               by definition; mirroring breaks meaning.
 *
 *  hybrid     → chart structure is LTR-preserved but text labels, tooltips,
 *               and legends render in RTL. Number values always LTR.
 */

import type { ChartDirectionMode, ChartType } from '../core/types'

export const chartDirectionPolicy: Record<ChartType, ChartDirectionMode> = {
  // Time-based: time still flows left→right, but axis is on right + legend mirrors
  'line':             'rtl-aware',
  'area':             'rtl-aware',
  'time-series':      'rtl-aware',
  'anomaly':          'rtl-aware',

  // Categorical comparisons: mirror fine
  'bar':              'rtl-aware',
  'stacked-bar':      'rtl-aware',
  'waterfall':        'rtl-aware',
  'cohort':           'rtl-aware',

  // Proportional: always preserve center-origin, no directional meaning
  'pie':              'preserve',
  'donut':            'preserve',

  // Flow charts: direction is part of the visual language — never mirror
  'funnel':           'preserve',
  'sankey':           'preserve',
  'attribution':      'preserve',

  // Grid-based: row/column labels mirror, cell values always LTR
  'heatmap':          'hybrid',
  'retention':        'hybrid',

  // Event timeline: time is LTR, labels RTL
  'event-timeline':   'hybrid',
  'conversion':       'hybrid',

  // Gauges / scores: no direction
  'health-score':     'preserve',

  // Revenue: numeric, same as time series
  'revenue':          'rtl-aware',

  // Micro
  'sparkline':        'preserve',
} as const

// ── RTL transform helpers ─────────────────────────────────────────────────────

/**
 * Given a chart's policy and the page direction, returns the effective
 * Recharts `layout` and margin adjustments.
 */
export function getChartRtlConfig(
  chartType: ChartType,
  pageDirection: 'ltr' | 'rtl',
): {
  mirrorAxes:    boolean
  flipLegend:    boolean
  reverseLabels: boolean
  /** CSS class applied to the chart wrapper SVG */
  wrapperClass:  string
} {
  if (pageDirection === 'ltr') {
    return { mirrorAxes: false, flipLegend: false, reverseLabels: false, wrapperClass: '' }
  }

  const policy = chartDirectionPolicy[chartType]

  if (policy === 'preserve') {
    return { mirrorAxes: false, flipLegend: false, reverseLabels: false, wrapperClass: '' }
  }

  if (policy === 'hybrid') {
    return {
      mirrorAxes:    false,
      flipLegend:    true,
      reverseLabels: true,
      wrapperClass:  'chart-hybrid-rtl',
    }
  }

  // rtl-aware: full mirror
  return {
    mirrorAxes:    true,
    flipLegend:    true,
    reverseLabels: true,
    wrapperClass:  'chart-rtl-aware',
  }
}

/**
 * Returns Recharts margin adjusted for RTL.
 * In RTL: swap left/right margin so the Y-axis (now on right) has padding.
 */
export function getRtlMargin(
  base: { top: number; right: number; bottom: number; left: number },
  mirrorAxes: boolean,
) {
  if (!mirrorAxes) return base
  return { top: base.top, right: base.left, bottom: base.bottom, left: base.right }
}

/**
 * Returns the Recharts `yAxisId` orientation adjusted for RTL.
 * Primary Y-axis: LTR='left', RTL='right'
 */
export function getYAxisOrientation(
  side: 'primary' | 'secondary',
  mirrorAxes: boolean,
): 'left' | 'right' {
  if (!mirrorAxes) return side === 'primary' ? 'left' : 'right'
  return side === 'primary' ? 'right' : 'left'
}

/**
 * Recharts tick formatter that enforces Latin numerals and
 * uses the correct font family for Arabic vs English labels.
 */
export function makeTickFormatter(
  locale: string,
  format?: (v: unknown) => string,
): (value: unknown) => string {
  return (value: unknown) => {
    const formatted = format ? format(value) : String(value ?? '')
    // Numbers: always append -u-nu-latn to prevent Eastern Arabic digits
    if (typeof value === 'number') {
      return Number(value).toLocaleString(`${locale}-u-nu-latn`)
    }
    return formatted
  }
}

/**
 * Returns the CSS `dir` attribute for a chart wrapper element.
 * Charts always render in ltr internally; RTL is handled at the data/config level.
 */
export function getChartWrapperDir(
  policy: ChartDirectionMode,
  _pageDir: 'ltr' | 'rtl',
): 'ltr' | 'rtl' {
  // SVG itself is always ltr — Recharts does not support dir="rtl" on <svg>
  // RTL is achieved through axis/margin config, not SVG direction
  if (policy === 'preserve') return 'ltr'
  return 'ltr'
}
