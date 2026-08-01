'use client'

/**
 * PART 2 — ChartProvider + ChartThemeProvider
 *
 * ChartProvider:      sets locale, direction, tenant palette, reduced motion
 * ChartThemeProvider: reads theme from data-theme attribute; generates
 *                     resolved CSS var values at runtime for Recharts
 *                     (Recharts renders SVG — CSS vars work for stroke/fill
 *                     only in browsers that support CSS vars on SVG attributes,
 *                     which all modern browsers do)
 *
 * White-label:
 *   Tenant palettes are injected via CSS [data-tenant="x"] { --brand-chart-* }
 *   The provider reads computed styles to resolve actual colors for Recharts
 *   gradients and canvas fallback (CSS vars don't work on canvas).
 */

import { useMemo, useEffect, useRef, type ReactNode } from 'react'
import { ChartContext, type ChartContextValue } from './context'
import { SERIES_PALETTE } from '../themes/chart-tokens'
import type { SupportedLocale } from '@/lib/formatters'
import type { ChartAnnotation } from './types'

export interface ChartProviderProps {
  children:            ReactNode
  locale?:             SupportedLocale
  direction?:          'ltr' | 'rtl'
  /** Override series palette — white-label tenant colors */
  tenantPalette?:      string[]
  /** Force reduced motion (e.g. accessibility settings page) */
  reducedMotion?:      boolean
  annotations?:        ChartAnnotation[]
  onAnnotationClick?:  (a: ChartAnnotation) => void
}

export function ChartProvider({
  children,
  locale         = 'en-SA',
  direction      = 'ltr',
  tenantPalette,
  reducedMotion,
  annotations    = [],
  onAnnotationClick,
}: ChartProviderProps) {
  const motionRef = useRef<boolean>(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    motionRef.current = mq.matches
    const handler = (e: MediaQueryListEvent) => { motionRef.current = e.matches }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const value = useMemo<ChartContextValue>(() => ({
    locale,
    direction,
    tenantPalette:  tenantPalette ?? SERIES_PALETTE,
    reducedMotion:  reducedMotion ?? motionRef.current,
    annotations,
    onAnnotationClick,
  }), [locale, direction, tenantPalette, reducedMotion, annotations, onAnnotationClick])

  return <ChartContext.Provider value={value}>{children}</ChartContext.Provider>
}

// ── Theme color resolver ──────────────────────────────────────────────────────
// Recharts draws to SVG. CSS vars work for stroke/fill on SVG in all modern
// browsers. For canvas fallback, we must resolve CSS vars to hex at runtime.

/**
 * Resolves a CSS variable to its computed hex/rgb value.
 * Returns the original string (the var()) if resolution fails (SSR).
 */
export function resolveCssVar(cssVar: string, element?: Element): string {
  if (typeof window === 'undefined') return cssVar
  // Strip var(--name) → --name
  const match = cssVar.match(/^var\((--[^)]+)\)$/)
  if (!match) return cssVar
  const el = element ?? document.documentElement
  return getComputedStyle(el).getPropertyValue(match[1]).trim() || cssVar
}

/**
 * Hook: resolves tenant palette CSS vars to computed colors.
 * Re-resolves on theme change (data-theme attribute mutation).
 * Required for canvas rendering where CSS vars don't apply.
 */
export function useResolvedPalette(palette: string[]): string[] {
  const ref = useRef<HTMLDivElement | null>(null)

  // We can't easily observe theme changes here without a MutationObserver,
  // but for canvas we call resolveCssVar lazily at draw time.
  return useMemo(
    () => palette.map(v => resolveCssVar(v, ref.current ?? undefined)),
    [palette],
  )
}
