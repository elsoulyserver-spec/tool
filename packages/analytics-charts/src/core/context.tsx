'use client'

/**
 * PART 2 — ChartContext
 *
 * Provides locale, direction, tenant palette, and animation preferences
 * to all chart components without prop drilling.
 *
 * Consumed via useChartContext() — never import ChartContext directly.
 */

import { createContext, useContext } from 'react'
import type { SupportedLocale } from '@/lib/formatters'
import type { ChartAnnotation } from './types'

export interface ChartContextValue {
  locale:         SupportedLocale
  direction:      'ltr' | 'rtl'
  /** Resolved tenant series palette (CSS vars or hex). Fallback = SERIES_PALETTE */
  tenantPalette:  string[]
  reducedMotion:  boolean
  /** Global annotation layer — AI or manual */
  annotations:    ChartAnnotation[]
  onAnnotationClick?: (annotation: ChartAnnotation) => void
}

export const ChartContext = createContext<ChartContextValue>({
  locale:         'en-SA',
  direction:      'ltr',
  tenantPalette:  [],
  reducedMotion:  false,
  annotations:    [],
})

export function useChartContext(): ChartContextValue {
  return useContext(ChartContext)
}
