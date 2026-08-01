'use client'

import { cn } from '@/lib/utils'
import type { TableDataState } from '../core/types'
import type { SupportedLocale } from '@/lib/formatters'

// ── Translations ──────────────────────────────────────────────────────────────

const LABELS: Record<string, { en: string; ar: string }> = {
  loading:       { en: 'Loading data…',                  ar: 'جارٍ تحميل البيانات…' },
  loadingMore:   { en: 'Loading more rows…',             ar: 'جارٍ تحميل المزيد…' },
  error:         { en: 'Failed to load data',            ar: 'فشل تحميل البيانات' },
  errorSub:      { en: 'Please try again or contact support.', ar: 'يرجى المحاولة مرة أخرى أو التواصل مع الدعم.' },
  empty:         { en: 'No data found',                  ar: 'لا توجد بيانات' },
  emptySub:      { en: 'Try adjusting your filters.',    ar: 'جرّب تعديل الفلاتر.' },
  stale:         { en: 'Data may be outdated',           ar: 'قد تكون البيانات غير محدّثة' },
  staleSub:      { en: 'Last updated more than 15 minutes ago.', ar: 'آخر تحديث منذ أكثر من ١٥ دقيقة.' },
  partial:       { en: 'Partial data',                   ar: 'بيانات جزئية' },
  partialSub:    { en: 'Some rows could not be loaded.', ar: 'تعذّر تحميل بعض الصفوف.' },
  offline:       { en: 'No connection',                  ar: 'لا يوجد اتصال' },
  offlineSub:    { en: 'Check your internet connection.', ar: 'تحقق من اتصالك بالإنترنت.' },
  retry:         { en: 'Retry',                          ar: 'إعادة المحاولة' },
}

function t(key: string, locale: SupportedLocale): string {
  return locale.startsWith('ar') ? LABELS[key]?.ar : LABELS[key]?.en
}

// ── Shared UI primitives ──────────────────────────────────────────────────────

function StateContainer({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-16 px-6 w-full', className)}>
      {children}
    </div>
  )
}

function StateTitle({ children, locale }: { children: React.ReactNode; locale: SupportedLocale }) {
  return (
    <p
      className={cn(
        'text-text-primary font-semibold text-sm mt-3',
        locale.startsWith('ar') ? 'font-ui-ar' : 'font-ui-en',
      )}
      dir={locale.startsWith('ar') ? 'rtl' : 'ltr'}
    >
      {children}
    </p>
  )
}

function StateSubtitle({ children, locale }: { children: React.ReactNode; locale: SupportedLocale }) {
  return (
    <p
      className={cn(
        'text-text-tertiary text-xs mt-1',
        locale.startsWith('ar') ? 'font-ui-ar' : 'font-ui-en',
      )}
      dir={locale.startsWith('ar') ? 'rtl' : 'ltr'}
    >
      {children}
    </p>
  )
}

// ── Skeleton rows ─────────────────────────────────────────────────────────────

function SkeletonRow({ columns }: { columns: number }) {
  return (
    <div className="flex gap-3 px-4 py-2 border-b border-border-default">
      {Array.from({ length: columns }).map((_, i) => (
        <div
          key={i}
          className="h-4 rounded animate-skeleton"
          style={{ width: `${60 + (i % 3) * 20}px`, backgroundColor: 'var(--semantic-color-bg-subtle)' }}
        />
      ))}
    </div>
  )
}

// ── Individual state components ───────────────────────────────────────────────

export function LoadingState({ locale, columns = 5 }: { locale: SupportedLocale; columns?: number }) {
  return (
    <div className="w-full" role="status" aria-label={t('loading', locale)}>
      {Array.from({ length: 8 }).map((_, i) => (
        <SkeletonRow key={i} columns={columns} />
      ))}
      <span className="sr-only">{t('loading', locale)}</span>
    </div>
  )
}

export function LoadingMoreState({ locale }: { locale: SupportedLocale }) {
  return (
    <div
      className="flex items-center justify-center py-3 border-t border-border-default"
      role="status"
      aria-label={t('loadingMore', locale)}
    >
      <span className="text-text-tertiary text-xs font-ui-en">{t('loadingMore', locale)}</span>
    </div>
  )
}

export function ErrorState({
  locale,
  onRetry,
  message,
}: {
  locale:   SupportedLocale
  onRetry?: () => void
  message?: string
}) {
  const isAr = locale.startsWith('ar')
  return (
    <StateContainer>
      <div className="w-10 h-10 rounded-full bg-status-error flex items-center justify-center" aria-hidden="true">
        <span className="text-status-error-text text-lg font-bold">!</span>
      </div>
      <StateTitle locale={locale}>{message ?? t('error', locale)}</StateTitle>
      <StateSubtitle locale={locale}>{t('errorSub', locale)}</StateSubtitle>
      {onRetry && (
        <button
          onClick={onRetry}
          className={cn(
            'mt-4 px-3 py-1.5 rounded text-xs font-semibold bg-action-primary text-action-primary-text',
            'hover:bg-action-primary-hover transition-colors',
            isAr ? 'font-ui-ar' : 'font-ui-en',
          )}
        >
          {t('retry', locale)}
        </button>
      )}
    </StateContainer>
  )
}

export function EmptyState({ locale, onClearFilters }: { locale: SupportedLocale; onClearFilters?: () => void }) {
  const isAr = locale.startsWith('ar')
  return (
    <StateContainer>
      <div className="w-10 h-10 rounded-full bg-bg-subtle flex items-center justify-center" aria-hidden="true">
        <span className="text-text-tertiary text-lg">○</span>
      </div>
      <StateTitle locale={locale}>{t('empty', locale)}</StateTitle>
      <StateSubtitle locale={locale}>{t('emptySub', locale)}</StateSubtitle>
      {onClearFilters && (
        <button
          onClick={onClearFilters}
          className={cn(
            'mt-4 px-3 py-1.5 rounded text-xs font-semibold border border-border-default text-text-secondary',
            'hover:bg-bg-subtle transition-colors',
            isAr ? 'font-ui-ar' : 'font-ui-en',
          )}
        >
          {isAr ? 'مسح الفلاتر' : 'Clear filters'}
        </button>
      )}
    </StateContainer>
  )
}

export function StaleDataBanner({ locale }: { locale: SupportedLocale }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 bg-status-warning text-status-warning-text text-xs border-b border-border-default',
        locale.startsWith('ar') ? 'flex-row-reverse font-ui-ar' : 'font-ui-en',
      )}
      role="alert"
    >
      <span aria-hidden="true">⚠</span>
      <span>{t('stale', locale)} — {t('staleSub', locale)}</span>
    </div>
  )
}

export function OfflineState({ locale }: { locale: SupportedLocale }) {
  return (
    <StateContainer>
      <div className="w-10 h-10 rounded-full bg-bg-subtle flex items-center justify-center" aria-hidden="true">
        <span className="text-text-tertiary text-lg">⊘</span>
      </div>
      <StateTitle locale={locale}>{t('offline', locale)}</StateTitle>
      <StateSubtitle locale={locale}>{t('offlineSub', locale)}</StateSubtitle>
    </StateContainer>
  )
}

export function PartialDataBanner({ locale }: { locale: SupportedLocale }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 bg-status-info text-status-info-text text-xs border-b border-border-default',
        locale.startsWith('ar') ? 'flex-row-reverse font-ui-ar' : 'font-ui-en',
      )}
      role="status"
    >
      <span aria-hidden="true">ℹ</span>
      <span>{t('partial', locale)} — {t('partialSub', locale)}</span>
    </div>
  )
}

// ── Master state renderer ─────────────────────────────────────────────────────

export function TableDataStateRenderer({
  dataState,
  locale,
  columns,
  onRetry,
  onClearFilters,
  error,
  children,
}: {
  dataState:      TableDataState
  locale:         SupportedLocale
  columns?:       number
  onRetry?:       () => void
  onClearFilters?:() => void
  error?:         string
  children:       React.ReactNode
}) {
  if (dataState === 'loading') return <LoadingState locale={locale} columns={columns} />
  if (dataState === 'error')   return <ErrorState locale={locale} onRetry={onRetry} message={error} />
  if (dataState === 'empty')   return <EmptyState locale={locale} onClearFilters={onClearFilters} />
  if (dataState === 'offline') return <OfflineState locale={locale} />

  return (
    <>
      {dataState === 'stale'   && <StaleDataBanner locale={locale} />}
      {dataState === 'partial' && <PartialDataBanner locale={locale} />}
      {children}
      {dataState === 'loading-more' && <LoadingMoreState locale={locale} />}
    </>
  )
}
