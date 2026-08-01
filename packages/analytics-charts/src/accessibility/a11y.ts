/**
 * PART 11 — Accessibility
 *
 * WCAG AA compliance matrix for all chart types.
 * Color blindness safe palette validation.
 * Keyboard navigation helpers.
 * Screen reader data table generator (hidden but accessible).
 *
 * Accessibility matrix:
 *
 * Chart type          | Keyboard | SR  | Color-blind | Reduced motion | High contrast
 * --------------------|----------|-----|-------------|----------------|---------------
 * line                | ✅ arrow  | ✅  | ✅ patterns | ✅ no anim      | ✅
 * area                | ✅ arrow  | ✅  | ✅ patterns | ✅ no anim      | ✅
 * bar                 | ✅ arrow  | ✅  | ✅ patterns | ✅ no anim      | ✅
 * pie/donut           | ✅ arrow  | ✅  | ✅ labels   | ✅ no anim      | ✅
 * funnel              | ✅ tab    | ✅  | ✅ labels   | ✅ no anim      | ✅
 * heatmap             | ✅ arrow  | ✅  | ⚠ requires AR labels | ✅ | ✅
 * sparkline           | n/a       | ✅  | n/a         | ✅             | ✅
 */

import type { ChartSeries, DataPoint } from '../core/types'
import type { SupportedLocale } from '@/lib/formatters'

// ── WCAG contrast validation ──────────────────────────────────────────────────

function hexToLuminance(hex: string): number {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255

  const linearize = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)

  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = hexToLuminance(hex1)
  const l2 = hexToLuminance(hex2)
  const lighter = Math.max(l1, l2)
  const darker  = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

export function meetsWCAGAA(hex1: string, hex2: string): boolean {
  return contrastRatio(hex1, hex2) >= 4.5
}

// ── Color blindness check ─────────────────────────────────────────────────────
// Simplified deuteranopia simulation for palette validation

export function simulateDeuteranopia(hex: string): string {
  const clean = hex.replace('#', '')
  let r = parseInt(clean.slice(0, 2), 16)
  let g = parseInt(clean.slice(2, 4), 16)
  let b = parseInt(clean.slice(4, 6), 16)

  // Approximate deuteranopia matrix
  const newR = Math.round(0.367 * r + 0.861 * g - 0.228 * b)
  const newG = Math.round(0.280 * r + 0.673 * g + 0.047 * b)
  const newB = Math.round(-0.012 * r + 0.043 * g + 0.969 * b)

  const clamp = (v: number) => Math.max(0, Math.min(255, v))
  const toHex = (v: number) => clamp(v).toString(16).padStart(2, '0')

  return `#${toHex(newR)}${toHex(newG)}${toHex(newB)}`
}

/** Check if two colors are distinguishable under deuteranopia */
export function isColorBlindSafe(hex1: string, hex2: string): boolean {
  const sim1 = simulateDeuteranopia(hex1)
  const sim2 = simulateDeuteranopia(hex2)
  return contrastRatio(sim1, sim2) >= 1.5
}

// ── Stroke dash patterns for color-blind safe charts ─────────────────────────
// Used as strokeDasharray for line chart series

export const A11Y_STROKE_PATTERNS = [
  undefined,       // series 1: solid
  '6 3',           // series 2: dashed
  '2 2',           // series 3: dotted
  '6 3 2 3',       // series 4: dash-dot
  '8 2',           // series 5: long dash
  '2 4',           // series 6: sparse dot
  '6 2 2 2 2 2',   // series 7: dash-dot-dot
  '4 2 4 2',       // series 8: double dash
] as const

// ── Keyboard navigation ───────────────────────────────────────────────────────

export interface ChartKeyboardConfig {
  onArrowLeft?:  () => void
  onArrowRight?: () => void
  onArrowUp?:    () => void
  onArrowDown?:  () => void
  onHome?:       () => void
  onEnd?:        () => void
  onEnter?:      () => void
  onEscape?:     () => void
}

/**
 * Returns keyboard event handler for chart containers.
 * Charts are focusable divs (tabIndex=0) that receive keyboard events.
 */
export function makeChartKeyboardHandler(config: ChartKeyboardConfig) {
  return (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); config.onArrowLeft?.();  break
      case 'ArrowRight': e.preventDefault(); config.onArrowRight?.(); break
      case 'ArrowUp':    e.preventDefault(); config.onArrowUp?.();    break
      case 'ArrowDown':  e.preventDefault(); config.onArrowDown?.();  break
      case 'Home':       e.preventDefault(); config.onHome?.();       break
      case 'End':        e.preventDefault(); config.onEnd?.();        break
      case 'Enter':      e.preventDefault(); config.onEnter?.();      break
      case 'Escape':     e.preventDefault(); config.onEscape?.();     break
    }
  }
}

// ── Screen reader data table ──────────────────────────────────────────────────
// Generates a visually hidden <table> with all chart data for screen readers.
// Inserted as a sibling of the <svg> — always present, never visible.

export interface SRTableConfig {
  series: ChartSeries[]
  locale: SupportedLocale
  caption?:   string
  captionAr?: string
}

export function buildSRTableHTML(config: SRTableConfig): string {
  const { series, locale, caption, captionAr } = config
  const isAr = locale.startsWith('ar')

  // Collect all unique x values across series
  const xValues = [...new Set(series.flatMap(s => s.data.map(d => String(d.x))))]

  const headerCells = series
    .map(s => `<th scope="col">${isAr && s.labelAr ? s.labelAr : s.label}</th>`)
    .join('')

  const rows = xValues.map(x => {
    const cells = series.map(s => {
      const point = s.data.find(d => String(d.x) === x)
      return `<td>${point?.y ?? '—'}</td>`
    }).join('')
    return `<tr><th scope="row">${x}</th>${cells}</tr>`
  }).join('')

  const captionText = isAr && captionAr ? captionAr : caption

  return `
    <table>
      ${captionText ? `<caption>${captionText}</caption>` : ''}
      <thead>
        <tr>
          <th scope="col"></th>
          ${headerCells}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `
}

// ── Reduced motion helpers ────────────────────────────────────────────────────

export function getAnimationDuration(reducedMotion: boolean, defaultMs: number): number {
  return reducedMotion ? 0 : defaultMs
}

export function getAnimationEasing(reducedMotion: boolean): string {
  return reducedMotion ? 'linear' : 'cubic-bezier(0.16, 1, 0.3, 1)'
}

// ── ARIA chart description generator ─────────────────────────────────────────
// Returns a natural language description of chart data for aria-description

export function generateChartDescription(
  series:    ChartSeries[],
  locale:    SupportedLocale,
  chartType: string,
): string {
  const isAr = locale.startsWith('ar')

  if (!series.length || !series[0]?.data.length) {
    return isAr ? 'لا توجد بيانات' : 'No data available'
  }

  const totalPoints = series.reduce((acc, s) => acc + s.data.length, 0)
  const seriesCount = series.length

  if (isAr) {
    return `${chartType} يحتوي على ${seriesCount} سلسلة بيانات و${totalPoints} نقطة`
  }
  return `${chartType} with ${seriesCount} data series and ${totalPoints} data points`
}
