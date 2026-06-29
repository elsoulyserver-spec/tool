'use client'

import { cn } from '@/lib/utils'
import type { ChartDataState } from '../core/types'
import type { SupportedLocale } from '@/lib/formatters'

// ── Labels ────────────────────────────────────────────────────────────────────

const L: Record<string, { en: string; ar: string }> = {
  loading:    { en: 'Loading chart…',         ar: 'جارٍ تحميل المخطط…' },
  empty:      { en: 'No data to display',     ar: 'لا توجد بيانات للعرض' },
  emptySub:   { en: 'Try changing the date range or filters.', ar: 'جرّب تغيير نطاق التاريخ أو الفلاتر.' },
  error:      { en: 'Failed to load chart',   ar: 'فشل تحميل المخطط' },
  retry:      { en: 'Retry',                  ar: 'إعادة المحاولة' },
  offline:    { en: 'No internet connection', ar: 'لا يوجد اتصال بالإنترنت' },
  offlineSub: { en: 'Check your connection and try again.', ar: 'تحقق من اتصالك وحاول مجدداً.' },
  permission: { en: 'Access restricted',      ar: 'الوصول مقيّد' },
  permSub:    { en: 'You don\'t have permission to view this data.', ar: 'ليس لديك صلاحية لعرض هذه البيانات.' },
  stale:      { en: 'Data may be outdated',   ar: 'قد تكون البيانات قديمة' },
  partial:    { en: 'Partial data shown',     ar: 'تعرض بيانات جزئية' },
  degraded:   { en: 'Some metrics unavailable', ar: 'بعض المقاييس غير متاحة' },
}

function t(key: string, locale: SupportedLocale): string {
  return locale.startsWith('ar') ? L[key]?.ar : L[key]?.en
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function ChartSkeleton({ height }: { height: number }) {
  return (
    <div className="absolute inset-0 flex flex-col gap-2 p-4" aria-hidden="true">
      {/* Fake Y-axis */}
      <div className="flex gap-2 flex-1">
        <div className="flex flex-col justify-between py-1 w-8 gap-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-3 rounded animate-skeleton bg-bg-subtle" style={{ width: '100%' }} />
          ))}
        </div>
        {/* Fake chart area */}
        <div className="flex-1 flex flex-col justify-end gap-2">
          <div className="flex items-end gap-1 h-full">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="flex-1 rounded-t animate-skeleton bg-bg-subtle"
                style={{ height: `${30 + Math.sin(i * 0.9) * 25 + Math.cos(i * 1.3) * 20}%` }}
              />
            ))}
          </div>
        </div>
      </div>
      {/* Fake X-axis */}
      <div className="flex gap-1 ms-10">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex-1 h-3 rounded animate-skeleton bg-bg-subtle" />
        ))}
      </div>
    </div>
  )
}

// ── State overlays ────────────────────────────────────────────────────────────

export function ChartSkeletonOverlay({
  state,
  error,
  locale,
  height,
  onRetry,
}: {
  state:   ChartDataState
  error?:  string
  locale:  SupportedLocale
  height:  number
  onRetry?:() => void
}) {
  const isAr = locale.startsWith('ar')

  if (state === 'loading' || state === 'skeleton') {
    return (
      <div className="absolute inset-0 z-10" role="status" aria-label={t('loading', locale)}>
        <ChartSkeleton height={height} />
        <span className="sr-only">{t('loading', locale)}</span>
      </div>
    )
  }

  if (state === 'empty') {
    return (
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1">
        <span className="text-2xl text-text-tertiary" aria-hidden="true">○</span>
        <p className={cn('text-sm font-semibold text-text-primary', isAr ? 'font-ui-ar' : 'font-ui-en')}>
          {t('empty', locale)}
        </p>
        <p className={cn('text-xs text-text-tertiary', isAr ? 'font-ui-ar' : 'font-ui-en')}>
          {t('emptySub', locale)}
        </p>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2">
        <span className="text-xl text-analytics-negative" aria-hidden="true">⚠</span>
        <p className={cn('text-sm font-semibold text-text-primary', isAr ? 'font-ui-ar' : 'font-ui-en')}>
          {error ?? t('error', locale)}
        </p>
        {onRetry && (
          <button
            onClick={onRetry}
            className={cn(
              'px-3 py-1.5 rounded text-xs font-semibold bg-action-primary text-action-primary-text',
              'hover:bg-action-primary-hover transition-colors',
              isAr ? 'font-ui-ar' : 'font-ui-en',
            )}
          >
            {t('retry', locale)}
          </button>
        )}
      </div>
    )
  }

  if (state === 'offline') {
    return (
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1">
        <span className="text-xl text-text-tertiary" aria-hidden="true">⊘</span>
        <p className={cn('text-sm font-semibold text-text-primary', isAr ? 'font-ui-ar' : 'font-ui-en')}>
          {t('offline', locale)}
        </p>
        <p className={cn('text-xs text-text-tertiary', isAr ? 'font-ui-ar' : 'font-ui-en')}>
          {t('offlineSub', locale)}
        </p>
      </div>
    )
  }

  if (state === 'permission-denied') {
    return (
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1">
        <span className="text-xl text-text-tertiary" aria-hidden="true">⊕</span>
        <p className={cn('text-sm font-semibold text-text-primary', isAr ? 'font-ui-ar' : 'font-ui-en')}>
          {t('permission', locale)}
        </p>
        <p className={cn('text-xs text-text-tertiary', isAr ? 'font-ui-ar' : 'font-ui-en')}>
          {t('permSub', locale)}
        </p>
      </div>
    )
  }

  return null
}

// ── State banners (non-blocking — shown above chart) ──────────────────────────

export function ChartStateBanner({
  state,
  locale,
}: {
  state:  ChartDataState
  locale: SupportedLocale
}) {
  const isAr = locale.startsWith('ar')

  if (state === 'stale') {
    return (
      <div
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 bg-status-warning text-status-warning-text text-xs border-b border-border-default',
          isAr ? 'flex-row-reverse font-ui-ar' : 'font-ui-en',
        )}
        role="alert"
      >
        <span aria-hidden="true">⚠</span>
        {t('stale', locale)}
      </div>
    )
  }

  if (state === 'partial') {
    return (
      <div
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 bg-status-info text-status-info-text text-xs border-b border-border-default',
          isAr ? 'flex-row-reverse font-ui-ar' : 'font-ui-en',
        )}
        role="status"
      >
        <span aria-hidden="true">ℹ</span>
        {t('partial', locale)}
      </div>
    )
  }

  if (state === 'degraded') {
    return (
      <div
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 bg-status-warning text-status-warning-text text-xs border-b border-border-default',
          isAr ? 'flex-row-reverse font-ui-ar' : 'font-ui-en',
        )}
        role="status"
      >
        <span aria-hidden="true">▲</span>
        {t('degraded', locale)}
      </div>
    )
  }

  return null
}
