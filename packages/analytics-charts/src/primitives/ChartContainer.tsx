'use client'

/**
 * ChartContainer — base wrapper for all chart components.
 *
 * Responsibilities:
 *  1. Renders the card shell (border, background, padding)
 *  2. Applies direction policy CSS class to wrapper
 *  3. Provides aria-label for the chart region
 *  4. Renders chart state overlays (skeleton, error, empty, stale, etc.)
 *  5. Renders AI summary bar when aiSummary is present
 *  6. Applies reduced-motion class
 */

import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useChartContext } from '../core/context'
import type { BaseChartProps, ChartDataState } from '../core/types'
import { ChartStateBanner, ChartSkeletonOverlay } from './ChartStateOverlays'

export interface ChartContainerProps extends Pick<BaseChartProps,
  'className' | 'bare' | 'ariaLabel' | 'ariaLabelAr' | 'aiSummary' | 'onInsightClick'
> {
  children:   ReactNode
  chartState: ChartDataState
  error?:     string
  height:     number
  onRetry?:   () => void
  onResetFilters?: () => void
  title?:     string
  titleAr?:   string
  subtitle?:  string
  subtitleAr?:string
  actions?:   ReactNode
}

export function ChartContainer({
  children,
  chartState,
  error,
  height,
  bare,
  className,
  ariaLabel,
  ariaLabelAr,
  aiSummary,
  onInsightClick,
  onRetry,
  title,
  titleAr,
  subtitle,
  subtitleAr,
  actions,
}: ChartContainerProps) {
  const { locale, direction, reducedMotion } = useChartContext()
  const isAr = locale.startsWith('ar')

  const displayTitle    = isAr && titleAr    ? titleAr    : title
  const displaySubtitle = isAr && subtitleAr ? subtitleAr : subtitle
  const displayAriaLabel= isAr && ariaLabelAr ? ariaLabelAr : ariaLabel

  const isBlocked = chartState === 'loading' || chartState === 'skeleton' ||
                    chartState === 'error'   || chartState === 'empty'    ||
                    chartState === 'offline' || chartState === 'permission-denied'

  return (
    <section
      dir={direction}
      aria-label={displayAriaLabel ?? displayTitle}
      role="figure"
      className={cn(
        !bare && 'border border-border-default rounded-lg bg-bg-default overflow-hidden',
        reducedMotion && 'motion-reduce',
        className,
      )}
    >
      {/* Header */}
      {(displayTitle || actions) && (
        <div className={cn(
          'flex items-start gap-2 px-4 pt-4 pb-2',
          isAr ? 'flex-row-reverse' : '',
        )}>
          {displayTitle && (
            <div className="flex-1 min-w-0">
              <h3 className={cn(
                'text-sm font-semibold text-text-primary truncate',
                isAr ? 'font-ui-ar' : 'font-ui-en',
              )}>
                {displayTitle}
              </h3>
              {displaySubtitle && (
                <p className={cn(
                  'text-xs text-text-tertiary mt-0.5 truncate',
                  isAr ? 'font-ui-ar' : 'font-ui-en',
                )}>
                  {displaySubtitle}
                </p>
              )}
            </div>
          )}
          {actions && <div className="flex items-center gap-1 flex-shrink-0">{actions}</div>}
        </div>
      )}

      {/* State banners (stale, partial, degraded) */}
      <ChartStateBanner state={chartState} locale={locale} />

      {/* AI insights banner */}
      {aiSummary && (
        <AISummaryBar summary={aiSummary} locale={locale} direction={direction} onInsightClick={onInsightClick} />
      )}

      {/* Chart area */}
      <div className="relative" style={{ height }}>
        {isBlocked && (
          <ChartSkeletonOverlay
            state={chartState}
            error={error}
            locale={locale}
            height={height}
            onRetry={onRetry}
          />
        )}
        {/* Always render children so Recharts can mount — overlay sits on top */}
        <div className={cn('w-full h-full', isBlocked && 'opacity-0 pointer-events-none')}>
          {children}
        </div>
      </div>
    </section>
  )
}

// ── AI Summary Bar ────────────────────────────────────────────────────────────

import type { ChartAISummary, ChartInsight } from '../core/types'
import type { SupportedLocale } from '@/lib/formatters'

function AISummaryBar({
  summary,
  locale,
  direction,
  onInsightClick,
}: {
  summary:         ChartAISummary
  locale:          SupportedLocale
  direction:       'ltr' | 'rtl'
  onInsightClick?: (i: ChartInsight) => void
}) {
  const isAr      = locale.startsWith('ar')
  const headline  = isAr && summary.headlineAr ? summary.headlineAr : summary.headline
  const criticals = summary.insights.filter(i => i.severity === 'critical').slice(0, 2)

  return (
    <div
      className={cn(
        'flex items-start gap-2 px-3 py-2 bg-bg-subtle border-b border-border-default',
        isAr ? 'flex-row-reverse' : '',
      )}
      dir={direction}
      aria-label={isAr ? 'ملخص الذكاء الاصطناعي' : 'AI Summary'}
    >
      <span className="text-xs flex-shrink-0" aria-hidden="true">✦</span>
      <div className="flex-1 min-w-0">
        <p className={cn('text-xs text-text-secondary', isAr ? 'font-ui-ar' : 'font-ui-en')}>
          {headline}
        </p>
        {criticals.length > 0 && (
          <div className={cn('flex gap-1 mt-1 flex-wrap', isAr && 'flex-row-reverse')}>
            {criticals.map(insight => (
              <button
                key={insight.id}
                onClick={() => onInsightClick?.(insight)}
                className={cn(
                  'text-2xs px-1.5 py-0.5 rounded font-semibold transition-opacity hover:opacity-80',
                  isAr ? 'font-ui-ar' : 'font-ui-en',
                  insight.severity === 'critical' ? 'bg-status-error text-status-error-text' :
                  insight.severity === 'warning'  ? 'bg-status-warning text-status-warning-text' :
                                                    'bg-status-info text-status-info-text',
                )}
              >
                {isAr && insight.textAr ? insight.textAr : insight.text}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
