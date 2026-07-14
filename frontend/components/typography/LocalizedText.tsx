'use client'

/**
 * LocalizedText
 *
 * Direction-aware text wrapper. Selects Arabic or English font automatically
 * based on locale. Applies unicode-bidi: isolate to prevent bidi collisions
 * with surrounding content.
 *
 * This is the base primitive — use it for arbitrary localised prose.
 * For data values (numbers, currency, etc.) use the specialised components.
 */

import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import type { SupportedLocale } from '@/lib/formatters'

type TextVariant = 'brand-ar' | 'ui-ar' | 'ui-en' | 'inherit'
type TextSize    = '2xs' | 'xs' | 'sm' | 'base' | 'md' | 'lg' | 'xl' | '2xl'

interface LocalizedTextProps extends HTMLAttributes<HTMLSpanElement> {
  locale:    SupportedLocale
  variant?:  TextVariant
  size?:     TextSize
  weight?:   'light' | 'regular' | 'medium' | 'semibold' | 'bold'
  as?:       'span' | 'p' | 'div' | 'label' | 'h1' | 'h2' | 'h3' | 'h4' | 'li'
  /** Truncate with ellipsis and title tooltip */
  truncate?: boolean
}

const isArabicLocale = (locale: SupportedLocale): boolean =>
  locale.startsWith('ar')

const variantClasses: Record<TextVariant, string> = {
  'brand-ar': 'font-brand-ar dir-rtl bidi-isolate leading-ar-normal',
  'ui-ar':    'font-ui-ar dir-rtl bidi-isolate leading-ar-normal',
  'ui-en':    'font-ui-en dir-ltr bidi-isolate leading-normal',
  'inherit':  '',
}

const sizeClasses: Record<TextSize, string> = {
  '2xs':  'text-2xs',
  'xs':   'text-xs',
  'sm':   'text-sm',
  'base': 'text-base',
  'md':   'text-md',
  'lg':   'text-lg',
  'xl':   'text-xl',
  '2xl':  'text-2xl',
}

const weightClasses: Record<NonNullable<LocalizedTextProps['weight']>, string> = {
  light:    'font-light',
  regular:  'font-regular',
  medium:   'font-medium',
  semibold: 'font-semibold',
  bold:     'font-bold',
}

export const LocalizedText = forwardRef<HTMLSpanElement, LocalizedTextProps>(
  (
    {
      locale,
      variant,
      size     = 'base',
      weight   = 'regular',
      as: Tag  = 'span',
      truncate = false,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    // Auto-detect variant from locale if not specified
    const resolvedVariant: TextVariant =
      variant ?? (isArabicLocale(locale) ? 'ui-ar' : 'ui-en')

    const resolvedDir = resolvedVariant === 'ui-en' ? 'ltr'
                      : resolvedVariant === 'inherit' ? undefined
                      : 'rtl'

    return (
      // @ts-expect-error — polymorphic `as` pattern
      <Tag
        ref={ref}
        dir={resolvedDir}
        lang={locale}
        title={truncate && typeof children === 'string' ? children : undefined}
        className={cn(
          variantClasses[resolvedVariant],
          sizeClasses[size],
          weightClasses[weight],
          truncate && 'truncate max-w-full',
          className,
        )}
        {...props}
      >
        {children}
      </Tag>
    )
  },
)

LocalizedText.displayName = 'LocalizedText'

// ── Convenience variants ───────────────────────────────────────────────────────

/** Arabic UI text (IBM Plex Sans Arabic) — for analytics data labels */
export const ArText = forwardRef<HTMLSpanElement, Omit<LocalizedTextProps, 'locale' | 'variant'>>(
  (props, ref) => (
    <LocalizedText ref={ref} locale="ar-SA" variant="ui-ar" {...props} />
  ),
)
ArText.displayName = 'ArText'

/** Arabic brand text (ThmanyahSans) — for headings and brand moments */
export const BrandArText = forwardRef<HTMLSpanElement, Omit<LocalizedTextProps, 'locale' | 'variant'>>(
  (props, ref) => (
    <LocalizedText ref={ref} locale="ar-SA" variant="brand-ar" {...props} />
  ),
)
BrandArText.displayName = 'BrandArText'

/** English UI text (Inter) */
export const EnText = forwardRef<HTMLSpanElement, Omit<LocalizedTextProps, 'locale' | 'variant'>>(
  (props, ref) => (
    <LocalizedText ref={ref} locale="en-SA" variant="ui-en" {...props} />
  ),
)
EnText.displayName = 'EnText'
