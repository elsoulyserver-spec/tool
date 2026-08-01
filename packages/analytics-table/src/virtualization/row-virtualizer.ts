/**
 * Easy Track Analytics Table — Row Virtualization Engine
 *
 * Strategy:
 *  - < 500 rows:   no virtualization (CSS scroll, full DOM)
 *  - 500–100K rows: TanStack Virtual, fixed row height per density
 *  - 100K–1M rows:  TanStack Virtual + windowed data, cursor pagination
 *  - 1M–10M rows:  server-side cursor + streaming, only current window in memory
 *
 * Fixed row heights are REQUIRED for virtualization correctness.
 * Dynamic heights are supported but disabled for row counts > PERF_THRESHOLDS.VIRT_REQUIRED.
 *
 * Memory model:
 *  - 100K rows × 36px height × ~500 bytes/row metadata ≈ 50MB
 *  - 1M rows: only visible window (overscan 10) + pagination chunk kept in memory
 *  - Never hold 1M row objects in a JS array — use streaming + sparse model
 */

import { useVirtualizer, type VirtualizerOptions } from '@tanstack/react-virtual'
import { useRef, useCallback, type RefObject } from 'react'
import { DENSITY_CONFIG, PERF_THRESHOLDS, type TableDensity } from '../core/types'

// ── Virtualizer config ────────────────────────────────────────────────────────

export interface RowVirtualizerConfig {
  rowCount:     number
  density:      TableDensity
  overscan?:    number
  /** If true, overscan is reduced for fast-scroll optimization */
  fastScroll?:  boolean
  /** Dynamic heights — only use when rowCount < VIRT_REQUIRED */
  dynamicHeights?: boolean
  /** Custom height estimator — called for each row index */
  estimateSize?: (index: number) => number
}

export interface UseRowVirtualizerResult {
  /** Ref to attach to the scrolling container div */
  scrollRef:           RefObject<HTMLDivElement>
  virtualItems:        Array<{ index: number; start: number; size: number; key: string | number }>
  totalSize:           number
  /** Whether virtualization is active — false means full DOM render */
  isVirtualized:       boolean
  scrollToRow:         (index: number, behavior?: ScrollBehavior) => void
  scrollToTop:         () => void
  measureElement:      ((element: Element | null) => void) | undefined
}

export function useRowVirtualizer(config: RowVirtualizerConfig): UseRowVirtualizerResult {
  const { rowCount, density, fastScroll, dynamicHeights } = config
  const scrollRef = useRef<HTMLDivElement>(null)

  const isVirtualized = rowCount >= PERF_THRESHOLDS.VIRT_REQUIRED

  const rowHeight = DENSITY_CONFIG[density].rowHeight

  const overscan = config.overscan
    ?? (fastScroll ? PERF_THRESHOLDS.OVERSCAN_FAST : PERF_THRESHOLDS.OVERSCAN_DEFAULT)

  // Dynamic heights only permitted below VIRT_REQUIRED threshold
  const useDynamic = dynamicHeights && rowCount < PERF_THRESHOLDS.VIRT_REQUIRED

  const estimateSize = useCallback(
    (index: number): number => {
      if (config.estimateSize) return config.estimateSize(index)
      return rowHeight
    },
    [rowHeight, config.estimateSize],
  )

  const virtualizer = useVirtualizer({
    count:        rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan,
    // Enable dynamic measurement only when count is small enough
    // and caller explicitly opts in
    measureElement: useDynamic ? (el) => el?.getBoundingClientRect().height ?? rowHeight : undefined,
    // Scrolling performance: use fixed size when possible (avoids layout thrash)
    ...(!useDynamic && { getItemKey: (index) => index }),
  } satisfies Omit<VirtualizerOptions<HTMLDivElement, Element>, 'getScrollElement'> & {
    getScrollElement: () => HTMLDivElement | null
  })

  const scrollToRow = useCallback(
    (index: number, behavior: ScrollBehavior = 'auto') => {
      virtualizer.scrollToIndex(index, { behavior })
    },
    [virtualizer],
  )

  const scrollToTop = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [])

  if (!isVirtualized) {
    // Non-virtualized: return empty virtual items — table renders all rows via map()
    return {
      scrollRef,
      virtualItems:  [],
      totalSize:     rowCount * rowHeight,
      isVirtualized: false,
      scrollToRow,
      scrollToTop,
      measureElement:undefined,
    }
  }

  return {
    scrollRef,
    virtualItems:   virtualizer.getVirtualItems(),
    totalSize:      virtualizer.getTotalSize(),
    isVirtualized:  true,
    scrollToRow,
    scrollToTop,
    measureElement: useDynamic ? virtualizer.measureElement : undefined,
  }
}

// ── Column virtualizer ────────────────────────────────────────────────────────

export interface ColVirtualizerConfig {
  columnWidths:  number[]    // ordered array of column widths in px
  containerWidth:number      // visible container width in px
  overscan?:     number
  enabled:       boolean     // horizontal virt only above threshold
}

export interface UseColVirtualizerResult {
  virtualColumns:   Array<{ index: number; start: number; size: number; key: string | number }>
  totalWidth:       number
  isVirtualized:    boolean
}

export function useColVirtualizer(
  scrollRef: RefObject<HTMLDivElement>,
  config:    ColVirtualizerConfig,
): UseColVirtualizerResult {
  const { columnWidths, containerWidth, overscan, enabled } = config

  const totalWidth = columnWidths.reduce((a, b) => a + b, 0)
  const isVirtualized = enabled && totalWidth > containerWidth * 1.5

  const virtualizer = useVirtualizer({
    horizontal:       true,
    count:            columnWidths.length,
    getScrollElement: () => scrollRef.current,
    estimateSize:     (i) => columnWidths[i] ?? 120,
    overscan:         overscan ?? PERF_THRESHOLDS.COL_OVERSCAN,
  })

  if (!isVirtualized) {
    return { virtualColumns: [], totalWidth, isVirtualized: false }
  }

  return {
    virtualColumns: virtualizer.getVirtualItems(),
    totalWidth:     virtualizer.getTotalSize(),
    isVirtualized:  true,
  }
}

// ── Sparse row model for 1M+ rows ─────────────────────────────────────────────
// When operating in server mode with cursor pagination, only the current
// window of rows is held in memory. This model maps virtualizer indices to
// the actual data chunk currently loaded.

export interface SparseRowWindow<TRow> {
  startIndex: number
  endIndex:   number
  rows:       TRow[]
}

export class SparseRowModel<TRow> {
  private window: SparseRowWindow<TRow> | null = null
  private totalCount: number

  constructor(totalCount: number) {
    this.totalCount = totalCount
  }

  setWindow(window: SparseRowWindow<TRow>): void {
    this.window = window
  }

  getRow(absoluteIndex: number): TRow | null {
    if (!this.window) return null
    const { startIndex, endIndex, rows } = this.window
    if (absoluteIndex < startIndex || absoluteIndex >= endIndex) return null
    return rows[absoluteIndex - startIndex] ?? null
  }

  isLoaded(absoluteIndex: number): boolean {
    if (!this.window) return false
    return absoluteIndex >= this.window.startIndex && absoluteIndex < this.window.endIndex
  }

  get count(): number {
    return this.totalCount
  }
}
