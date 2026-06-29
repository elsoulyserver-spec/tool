/**
 * Easy Track — Root Layout
 *
 * Font loading strategy:
 *  - IBM Plex Sans Arabic + Inter: served via next/font/google (CDN, auto-subset, preload)
 *  - ThmanyahSans: served via next/font/local (self-hosted WOFF2, preload Regular only)
 *  - JetBrains Mono: local, NOT preloaded (deferred — technical contexts only)
 *  - Serif families: NOT in this layout — loaded only in PDF renderer via dynamic import
 *
 * CLS prevention: fallback @font-face metrics in typography.css match primary fonts.
 */

import type { Metadata, Viewport } from 'next'
import {
  ibmPlexSansArabic,
  inter,
  thmanyahSans,
  jetbrainsMono,
  criticalFontVariables,
} from './fonts'
import '../styles/typography.css'

export const metadata: Metadata = {
  title:       { default: 'Easy Track', template: '%s | Easy Track' },
  description: 'Enterprise analytics platform for Saudi Arabia and GCC markets',
  // Prevents mobile browsers from inflating font sizes
  other: { 'format-detection': 'telephone=no' },
}

export const viewport: Viewport = {
  width:        'device-width',
  initialScale: 1,
  // Prevent iOS from adjusting font sizes in landscape
  userScalable: false,
}

interface RootLayoutProps {
  children:           React.ReactNode
  params: {
    locale: string    // injected by next-intl middleware
  }
}

export default function RootLayout({ children, params: { locale } }: RootLayoutProps) {
  const dir = locale === 'ar' ? 'rtl' : 'ltr'

  return (
    <html
      lang={locale}
      dir={dir}
      // All four next/font CSS variable names are injected here.
      // Components reference var(--font-*) — never raw font names.
      className={criticalFontVariables}
      // Prevent iOS from auto-adjusting font sizes
      style={{ WebkitTextSizeAdjust: '100%' }}
      suppressHydrationWarning
    >
      <head>
        {/*
          Preconnect to Google Fonts for IBM Plex Sans Arabic + Inter.
          next/font/google self-hosts by default in production — these hints
          only matter in development. Keep them here for safety.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body
        className={[
          // Base typography via CSS var(--font-sans) which switches per dir
          'font-sans antialiased',
          // Prevent invisible text during font load (font-display: swap handles this)
          'text-base',
        ].join(' ')}
      >
        {children}
      </body>
    </html>
  )
}
