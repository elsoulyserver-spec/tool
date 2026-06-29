'use client'

/**
 * EventName
 *
 * Renders a platform event name (GA4 Purchase, Meta ViewContent, etc.)
 *
 * Rules:
 *  - Always Inter — event names are technical identifiers, never translated
 *  - Always LTR — even on RTL pages
 *  - unicode-bidi: isolate — safe inside Arabic prose
 *  - Truncates with ellipsis + title tooltip for long names
 *
 * @example
 * // Inside an Arabic RTL table:
 * <EventName name="GA4 Purchase" platform="ga4" />
 * // → renders "GA4 Purchase" in Inter LTR, isolated from Arabic bidi context
 */

import { type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type Platform =
  | 'ga4'
  | 'meta'
  | 'tiktok'
  | 'snapchat'
  | 'twitter'
  | 'google-ads'
  | 'linkedin'
  | 'sgtm'
  | 'custom'

interface EventNameProps extends HTMLAttributes<HTMLSpanElement> {
  name:        string
  platform?:   Platform
  /** Show platform badge prefix */
  showBadge?:  boolean
  /** Truncate to N characters (default: no truncation) */
  maxLength?:  number
  size?:       'xs' | 'sm' | 'base'
  weight?:     'regular' | 'medium' | 'semibold'
}

const platformLabels: Record<Platform, string> = {
  'ga4':        'GA4',
  'meta':       'Meta',
  'tiktok':     'TikTok',
  'snapchat':   'Snap',
  'twitter':    'X',
  'google-ads': 'Ads',
  'linkedin':   'LI',
  'sgtm':       'sGTM',
  'custom':     'Custom',
}

const platformColors: Record<Platform, string> = {
  'ga4':        'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  'meta':       'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  'tiktok':     'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  'snapchat':   'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  'twitter':    'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  'google-ads': 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  'linkedin':   'bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-200',
  'sgtm':       'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  'custom':     'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
}

const sizeClasses = {
  'xs':   'text-xs',
  'sm':   'text-sm',
  'base': 'text-base',
} as const

const weightClasses = {
  regular:  'font-regular',
  medium:   'font-medium',
  semibold: 'font-semibold',
} as const

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return `${str.slice(0, max - 1)}…`
}

export function EventName({
  name,
  platform,
  showBadge = false,
  maxLength,
  size      = 'sm',
  weight    = 'medium',
  className,
  ...props
}: EventNameProps) {
  const displayName = maxLength ? truncate(name, maxLength) : name
  const isTruncated = maxLength ? name.length > maxLength : false

  return (
    <span
      // Critical: always LTR Inter, isolated from surrounding bidi context
      dir="ltr"
      className={cn(
        'inline-flex items-center gap-1.5',
        'font-ui-en dir-ltr bidi-isolate',
        'whitespace-nowrap',
        sizeClasses[size],
        weightClasses[weight],
        className,
      )}
      title={isTruncated ? name : undefined}
      {...props}
    >
      {showBadge && platform && (
        <span
          className={cn(
            'inline-flex items-center px-1 py-0.5 rounded text-2xs font-semibold font-ui-en',
            platformColors[platform],
          )}
          aria-label={platformLabels[platform]}
        >
          {platformLabels[platform]}
        </span>
      )}
      <span>{displayName}</span>
    </span>
  )
}
