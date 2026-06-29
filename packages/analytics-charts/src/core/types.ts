/**
 * Easy Track Analytics Charts — Core Type System
 *
 * PART 1 + PART 4: All chart interfaces in a single importable source.
 * No barrel re-exports inside this file — types only.
 */

import type { SupportedLocale } from '@/lib/formatters'

// ── Chart direction policy ────────────────────────────────────────────────────

export type ChartDirectionMode =
  | 'rtl-aware'   // axes + labels mirror; data flow L→R preserved
  | 'preserve'    // chart never mirrors (sankey, funnel, attribution)
  | 'hybrid'      // mixed Arabic labels + LTR numeric flow

// ── Data primitives ───────────────────────────────────────────────────────────

/** Minimum shape for any chart data point */
export interface DataPoint {
  /** X-axis key — timestamp ISO string, label string, or number */
  x:     string | number
  /** Primary Y value */
  y:     number
  /** Optional label override (localized) */
  label?: string
  /** Metadata passed through to tooltip / drill-down */
  meta?: Record<string, unknown>
}

/** Multi-series data point — keys map to series IDs */
export type MultiSeriesPoint = {
  x: string | number
  label?: string
  meta?: Record<string, unknown>
} & Record<string, number | null>

export interface ChartSeries {
  id:       string
  label:    string
  labelAr?: string
  data:     DataPoint[]
  color?:   string
  /** Override CSS variable, e.g. `var(--semantic-color-chart-series-3)` */
  colorVar?: string
  hidden?:  boolean
  /** Dash pattern for line/area: e.g. "5 3" */
  strokeDasharray?: string
  yAxisId?: 'left' | 'right'
}

// ── Chart state machine ───────────────────────────────────────────────────────

export type ChartDataState =
  | 'idle'
  | 'loading'
  | 'skeleton'
  | 'loaded'
  | 'empty'
  | 'stale'
  | 'partial'
  | 'degraded'
  | 'error'
  | 'offline'
  | 'permission-denied'
  | 'retrying'

export interface ChartStateContext {
  state:      ChartDataState
  error?:     string
  staleSince?:number   // timestamp ms
  retryCount: number
  maxRetries: number
}

// ── Chart config ──────────────────────────────────────────────────────────────

export type ChartType =
  | 'line' | 'area' | 'bar' | 'stacked-bar' | 'pie' | 'donut'
  | 'funnel' | 'cohort' | 'attribution' | 'revenue' | 'conversion'
  | 'event-timeline' | 'health-score' | 'waterfall' | 'sankey'
  | 'heatmap' | 'retention' | 'sparkline' | 'time-series' | 'anomaly'

export type AggregationPeriod = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year'

export type CurrencyCode = 'SAR' | 'AED' | 'KWD' | 'QAR' | 'BHD' | 'OMR' | 'USD' | 'EUR' | 'GBP'

// ── Tooltip ───────────────────────────────────────────────────────────────────

export interface TooltipSeries {
  id:     string
  label:  string
  value:  number | string
  color:  string
  format?: 'currency' | 'number' | 'percent' | 'roas' | 'raw'
}

export interface ChartTooltipData {
  x:       string | number
  xLabel:  string
  series:  TooltipSeries[]
  /** Comparison period value (if compare mode active) */
  compare?:TooltipSeries[]
  locale:  SupportedLocale
}

// ── Legend ────────────────────────────────────────────────────────────────────

export interface LegendItem {
  id:       string
  label:    string
  labelAr?: string
  color:    string
  hidden:   boolean
  value?:   number
  format?:  string
}

// ── Annotations ───────────────────────────────────────────────────────────────

export type AnnotationType = 'marker' | 'region' | 'reference-line' | 'label'

export interface ChartAnnotation {
  id:       string
  type:     AnnotationType
  x?:       string | number
  xEnd?:    string | number
  y?:       number
  label?:   string
  labelAr?: string
  color?:   string
  /** AI-generated annotations have source=ai */
  source?:  'manual' | 'ai' | 'alert'
  aiContext?: string
}

// ── AI interface (Part 14) ────────────────────────────────────────────────────

export interface ChartAISummary {
  /** One-sentence plain-language summary of the chart */
  headline:  string
  headlineAr?:string
  /** Key observations ordered by significance */
  insights:  ChartInsight[]
  /** AI-generated annotations to overlay */
  annotations: ChartAnnotation[]
  generatedAt: number
}

export interface ChartInsight {
  id:       string
  type:    'anomaly' | 'trend' | 'comparison' | 'recommendation' | 'alert'
  severity:'info' | 'warning' | 'critical'
  text:     string
  textAr?:  string
  affectedSeries?: string[]
  affectedRange?:  [string | number, string | number]
  confidence?:     number   // 0–1
  action?:         ChartInsightAction
}

export interface ChartInsightAction {
  label:    string
  labelAr?: string
  href?:    string
  onClick?: () => void
}

// ── Attribution types (Part 5) ────────────────────────────────────────────────

export type AttributionModel =
  | 'first-click' | 'last-click' | 'linear'
  | 'time-decay' | 'position-based' | 'data-driven'

export interface AttributionDataPoint {
  channel:     string
  channelAr?:  string
  model:       AttributionModel
  conversions: number
  revenue:     number
  weight:      number  // 0–1
  roas?:       number
}

// ── Revenue types (Part 5) ────────────────────────────────────────────────────

export interface RevenueDataPoint extends DataPoint {
  roas?:     number
  cac?:      number
  ltv?:      number
  margin?:   number
  spend?:    number
  currency:  CurrencyCode
}

// ── CAPI / Tracking types (Part 5) ───────────────────────────────────────────

export interface CAPIMetrics {
  eventMatchQuality: number   // 0–10
  eventDeliveryRate: number   // 0–1
  emqScore:          number   // 0–10
  deduplicationRate: number   // 0–1
}

export interface TrackingHealthPoint extends DataPoint {
  errors?:     number
  missing?:    number
  duplicates?: number
  mismatches?: number
}

// ── Performance ───────────────────────────────────────────────────────────────

export type RenderingBackend = 'svg' | 'canvas'

export interface PerformanceConfig {
  pointThreshold:     number  // switch to canvas above this
  samplingThreshold:  number  // LTTB sampling above this
  workerThreshold:    number  // offload to web worker above this
  maxCanvasPoints:    number  // hard limit
}

export const CHART_PERF: PerformanceConfig = {
  pointThreshold:    1_000,
  samplingThreshold: 5_000,
  workerThreshold:   50_000,
  maxCanvasPoints:   1_000_000,
}

// ── Common chart props ────────────────────────────────────────────────────────

export interface BaseChartProps {
  className?:    string
  locale?:       SupportedLocale
  direction?:    'ltr' | 'rtl'
  /** Chart height in px — required for virtualization */
  height?:       number
  width?:        number
  /** Hide chart border/card wrapper */
  bare?:         boolean
  /** Reduced motion (read from prefers-reduced-motion if not set) */
  reducedMotion?:boolean
  /** For accessibility: chart title read by screen readers */
  ariaLabel?:    string
  ariaLabelAr?:  string
  /** AI interface */
  aiSummary?:    ChartAISummary
  onInsightClick?:(insight: ChartInsight) => void
  /** Annotation overlay */
  annotations?:  ChartAnnotation[]
  /** Tenant color palette override (white-label) */
  tenantPalette?: string[]
}

export interface TimeSeriesChartProps extends BaseChartProps {
  series:            ChartSeries[]
  period?:           AggregationPeriod
  showArea?:         boolean
  compareMode?:      boolean
  compareSeries?:    ChartSeries[]
  /** Show anomaly bands */
  showAnomalyBands?: boolean
  anomalyData?:      Array<{ x: string; upper: number; lower: number }>
}

export interface BarChartProps extends BaseChartProps {
  data:       MultiSeriesPoint[]
  seriesKeys: string[]
  seriesLabels?: Record<string, string>
  seriesLabelsAr?: Record<string, string>
  stacked?:   boolean
  horizontal?:boolean
  showValues?:boolean
  /** Value format for bar labels */
  valueFormat?:'number' | 'currency' | 'percent'
  currency?:  CurrencyCode
}

export interface PieChartProps extends BaseChartProps {
  data:     Array<{ id: string; label: string; labelAr?: string; value: number; color?: string }>
  donut?:   boolean
  /** Inner radius % for donut — default 60 */
  innerRadius?: number
  centerLabel?: string
  centerValue?: string | number
  centerValueFormat?: 'currency' | 'number' | 'percent'
  showPercentages?: boolean
}

export interface FunnelChartProps extends BaseChartProps {
  stages: Array<{
    id:        string
    label:     string
    labelAr?:  string
    value:     number
    color?:    string
    dropoff?:  number
  }>
  showConversionRates?: boolean
  showDropoff?:         boolean
}

export interface SparklineProps {
  data:      number[]
  color?:    string
  trend?:    'up' | 'down' | 'flat'
  height?:   number
  width?:    number
  className?:string
  showDot?:  boolean
  animated?: boolean
}

export interface HeatmapChartProps extends BaseChartProps {
  data:    Array<{ x: string; y: string; value: number }>
  xLabels: string[]
  yLabels: string[]
  colorScale?: [string, string]  // [min color, max color]
  valueFormat?: 'number' | 'percent'
}

export interface WaterfallChartProps extends BaseChartProps {
  data: Array<{
    id:      string
    label:   string
    labelAr?:string
    value:   number
    type:    'positive' | 'negative' | 'total' | 'subtotal'
  }>
  currency?: CurrencyCode
}

export interface AttributionChartProps extends BaseChartProps {
  data:           AttributionDataPoint[]
  activeModel:    AttributionModel
  onModelChange?: (model: AttributionModel) => void
  compareModel?:  AttributionModel
  currency?:      CurrencyCode
}

export interface RetentionChartProps extends BaseChartProps {
  data: Array<{
    cohort:      string
    cohortLabel?: string
    periods:     number[]
  }>
  periodLabel?: string
}

// ── Axis types ────────────────────────────────────────────────────────────────

export interface AxisConfig {
  type?:      'category' | 'number' | 'time'
  label?:     string
  labelAr?:   string
  tickFormat?:(value: unknown, locale: SupportedLocale) => string
  domain?:    [number | 'auto', number | 'auto']
  hide?:      boolean
  grid?:      boolean
}
