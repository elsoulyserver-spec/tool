/**
 * PART 3 — Chart Token System
 *
 * Three layers:
 *   primitive  → immutable color values (never used directly in charts)
 *   semantic   → CSS variable references from Token Architecture V3
 *   chart      → chart-specific derived tokens (series, axis, grid, tooltip)
 *
 * Chart components ONLY consume `chartTokens` — never raw hex or primitive vars.
 * White-label tenants override `--brand-*` vars; chart series auto-adjust.
 */

// ── CSS variable references ───────────────────────────────────────────────────
// These mirror packages/design-tokens/generated/css/themes/light.css

export const chartCssVars = {
  // Series palette — 8 slots; tenant can override via --brand-chart-series-N
  series1:   'var(--semantic-color-chart-series-1)',
  series2:   'var(--semantic-color-chart-series-2)',
  series3:   'var(--semantic-color-chart-series-3)',
  series4:   'var(--semantic-color-chart-series-4)',
  series5:   'var(--semantic-color-chart-series-5)',
  series6:   'var(--semantic-color-chart-series-6)',
  series7:   'var(--semantic-color-chart-series-7)',
  series8:   'var(--semantic-color-chart-series-8)',

  // Functional
  positive:  'var(--semantic-color-analytics-positive)',
  negative:  'var(--semantic-color-analytics-negative)',
  neutral:   'var(--semantic-color-analytics-neutral)',
  warning:   'var(--semantic-color-analytics-stale)',
  stale:     'var(--semantic-color-analytics-stale)',
  loading:   'var(--semantic-color-analytics-loading)',

  // Structural
  axis:      'var(--semantic-color-border-default)',
  grid:      'var(--semantic-color-border-subtle)',
  gridMinor: 'var(--semantic-color-border-subtle)',
  tick:      'var(--semantic-color-text-tertiary)',
  label:     'var(--semantic-color-text-secondary)',
  title:     'var(--semantic-color-text-primary)',

  // Tooltip
  tooltipBg:      'var(--semantic-color-bg-surface-overlay)',
  tooltipBorder:  'var(--semantic-color-border-default)',
  tooltipShadow:  'var(--semantic-shadow-lg)',
  tooltipText:    'var(--semantic-color-text-primary)',
  tooltipSubtext: 'var(--semantic-color-text-secondary)',

  // Selection + crosshair
  crosshair:  'var(--semantic-color-border-focus)',
  selection:  'var(--semantic-color-action-selected)',
  brush:      'var(--semantic-color-action-primary)',

  // Annotation
  annotationMarker:  'var(--semantic-color-status-info-icon)',
  annotationRegion:  'var(--semantic-color-status-info)',
  annotationAi:      'var(--semantic-color-chart-series-6)',
  annotationAlert:   'var(--semantic-color-analytics-negative)',

  // Backgrounds
  chartBg:     'transparent',
  legendBg:    'transparent',
} as const

export type ChartCssVar = keyof typeof chartCssVars

// ── Series palette array ──────────────────────────────────────────────────────
// Ordered for maximum contrast between adjacent series.
// Used by Recharts as `stroke` / `fill` values.

export const SERIES_PALETTE: string[] = [
  chartCssVars.series1,
  chartCssVars.series2,
  chartCssVars.series3,
  chartCssVars.series4,
  chartCssVars.series5,
  chartCssVars.series6,
  chartCssVars.series7,
  chartCssVars.series8,
]

/** Returns the CSS var for series index (wraps around) */
export function seriesColor(index: number, tenantPalette?: string[]): string {
  const palette = tenantPalette?.length ? tenantPalette : SERIES_PALETTE
  return palette[index % palette.length]
}

// ── State colors ──────────────────────────────────────────────────────────────

export const STATE_COLORS = {
  positive:        chartCssVars.positive,
  negative:        chartCssVars.negative,
  warning:         chartCssVars.warning,
  stale:           chartCssVars.stale,
  partial:         chartCssVars.loading,
  disabled:        chartCssVars.loading,
  degraded:        chartCssVars.warning,
} as const

// ── Typography in charts ──────────────────────────────────────────────────────

export const CHART_TYPOGRAPHY = {
  // Axis tick labels — always Inter for numbers, IBM Plex Sans Arabic for Arabic
  tickFontFamily:    'var(--font-number)',
  tickFontSize:      11,
  tickFontWeight:    400,
  tickFill:          chartCssVars.tick,

  // Axis labels
  labelFontFamily:   'var(--font-ui-en)',
  labelFontSize:     12,
  labelFontWeight:   500,
  labelFill:         chartCssVars.label,

  // Arabic axis labels
  labelFontFamilyAr: 'var(--font-ui-ar)',
  labelFontSizeAr:   13,   // 13px minimum for Arabic

  // Tooltip
  tooltipFontFamily: 'var(--font-ui-en)',
  tooltipFontSize:   12,
  tooltipValueFont:  'var(--font-number)',

  // Legend
  legendFontFamily:  'var(--font-ui-en)',
  legendFontSize:    12,
} as const

// ── Geometry constants ────────────────────────────────────────────────────────

export const CHART_GEOMETRY = {
  // Margins inside the SVG (Recharts margin prop)
  marginDefault:    { top: 8, right: 24, bottom: 32, left: 48 },
  marginTight:      { top: 4, right: 8,  bottom: 24, left: 36 },
  marginRtl:        { top: 8, right: 48, bottom: 32, left: 24 },

  // Stroke widths
  lineStrokeWidth:  2,
  areaStrokeWidth:  2,
  gridStrokeWidth:  1,
  axisStrokeWidth:  1,
  crosshairWidth:   1,

  // Dot/point radii
  dotRadius:        3,
  dotRadiusActive:  5,
  dotRadiusHover:   6,

  // Bar
  barRadius:        [4, 4, 0, 0] as [number, number, number, number],
  barRadiusHoriz:   [0, 4, 4, 0] as [number, number, number, number],
  barCategoryGap:   '20%',
  barGap:           2,

  // Animation
  animationDuration:    400,
  animationEasing:      'cubic-bezier(0.16, 1, 0.3, 1)',
  animationDurationFast:200,
} as const

// ── Style Dictionary token shape (for build pipeline) ────────────────────────
// This type mirrors what packages/design-tokens/style-dictionary.config.js generates.
// Used when building chart-specific tokens as a separate SD build.

export interface ChartTokenTree {
  color: {
    chart: {
      series:     Record<string, { value: string; type: 'color' }>
      axis:       { value: string; type: 'color' }
      grid:       { value: string; type: 'color' }
      tooltip:    { bg: { value: string }; border: { value: string } }
      selection:  { value: string; type: 'color' }
      annotation: { value: string; type: 'color' }
    }
    state: {
      positive: { value: string; type: 'color' }
      negative: { value: string; type: 'color' }
      warning:  { value: string; type: 'color' }
      stale:    { value: string; type: 'color' }
      disabled: { value: string; type: 'color' }
    }
  }
}

// ── Tailwind integration ──────────────────────────────────────────────────────
// These are consumed by tailwind.config.ts extend.colors

export const chartTailwindColors = {
  'chart-series-1': chartCssVars.series1,
  'chart-series-2': chartCssVars.series2,
  'chart-series-3': chartCssVars.series3,
  'chart-series-4': chartCssVars.series4,
  'chart-series-5': chartCssVars.series5,
  'chart-series-6': chartCssVars.series6,
  'chart-series-7': chartCssVars.series7,
  'chart-series-8': chartCssVars.series8,
  'chart-positive': chartCssVars.positive,
  'chart-negative': chartCssVars.negative,
  'chart-warning':  chartCssVars.warning,
  'chart-axis':     chartCssVars.axis,
  'chart-grid':     chartCssVars.grid,
  'chart-tick':     chartCssVars.tick,
} as const
