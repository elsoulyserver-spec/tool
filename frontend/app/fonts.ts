/**
 * Easy Track — Font Loading Architecture
 *
 * Strategy:
 *  - Critical path  : IBM Plex Sans Arabic (400,500,600) + Inter variable → preloaded
 *  - Brand layer    : ThmanyahSans (400,500,700) → preloaded, swap
 *  - Deferred       : JetBrains Mono → loaded on demand
 *  - Lazy           : ThmanyahSerifDisplay, ThmanyahSerifText → PDF/report renderer only
 *
 * All local fonts live in public/fonts/<family>/
 * Google Fonts (IBM Plex Sans Arabic, Inter) served via next/font/google
 * to benefit from automatic subsetting, self-hosting, and preload injection.
 */

import { IBM_Plex_Sans_Arabic, Inter } from 'next/font/google'
import localFont from 'next/font/local'

// ---------------------------------------------------------------------------
// IBM Plex Sans Arabic — Enterprise analytics Arabic UI
// Weights shipped: 300 (light labels), 400 (body), 500 (medium), 600 (semibold)
// Subset: arabic + latin (for mixed strings)
// ---------------------------------------------------------------------------
export const ibmPlexSansArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-ui-ar',
  display: 'swap',
  preload: true,
  fallback: [
    'Noto Sans Arabic',
    'system-ui',
    'Arial',
  ],
  adjustFontFallback: false, // manual fallback metrics below
})

// ---------------------------------------------------------------------------
// Inter — English UI + all numeric values
// Variable font: single file covers all weights (100–900)
// ---------------------------------------------------------------------------
export const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-ui-en',
  display: 'swap',
  preload: true,
  fallback: [
    '-apple-system',
    'BlinkMacSystemFont',
    'Segoe UI',
    'system-ui',
    'sans-serif',
  ],
  adjustFontFallback: true,
})

// ---------------------------------------------------------------------------
// ThmanyahSans — Brand Arabic UI (headings, marketing, brand moments)
// Self-hosted: WOFF2 only, 3 weights (Regular 400 / Medium 500 / Bold 700)
// Subset strategy: Arabic + Latin punctuation only (run pyftsubset at build time)
// Target per-file size after subset: ≤ 32KB
// ---------------------------------------------------------------------------
export const thmanyahSans = localFont({
  src: [
    {
      path: '../../public/fonts/thmanyahsans/thmanyahsans-Regular.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../../public/fonts/thmanyahsans/thmanyahsans-Medium.woff2',
      weight: '500',
      style: 'normal',
    },
    {
      path: '../../public/fonts/thmanyahsans/thmanyahsans-Bold.woff2',
      weight: '700',
      style: 'normal',
    },
  ],
  variable: '--font-brand-ar',
  display: 'swap',
  preload: true, // preloads first entry (Regular) only
  fallback: [
    'IBM Plex Sans Arabic', // same IBM design language, seamless fallback
    'Noto Sans Arabic',
    'system-ui',
  ],
  declarations: [
    // Prevent layout shift: match IBM Plex Sans Arabic metrics
    { prop: 'ascent-override',   value: '90%'  },
    { prop: 'descent-override',  value: '22%'  },
    { prop: 'line-gap-override', value: '0%'   },
  ],
})

// ---------------------------------------------------------------------------
// JetBrains Mono — Code, technical IDs, GTM container IDs, URLs
// Loaded on demand (not preloaded) — only appears in technical contexts
// Variable font covers all weights
// ---------------------------------------------------------------------------
export const jetbrainsMono = localFont({
  src: [
    {
      path: '../../public/fonts/jetbrainsmono/JetBrainsMono-variable.woff2',
      weight: '100 800',
      style: 'normal',
    },
  ],
  variable: '--font-code',
  display: 'swap',
  preload: false, // deferred — loaded only when code/ID context is rendered
  fallback: [
    'Fira Code',
    'Cascadia Code',
    'Consolas',
    'ui-monospace',
    'monospace',
  ],
})

// ---------------------------------------------------------------------------
// ThmanyahSerifDisplay — Arabic display headings (report covers, PDF headers)
// NOT included in main bundle. Dynamic import in PDF renderer only.
// ---------------------------------------------------------------------------
export const thmanyahSerifDisplay = localFont({
  src: [
    {
      path: '../../public/fonts/thmanyahserifdisplay/thmanyahserifdisplay-Regular.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../../public/fonts/thmanyahserifdisplay/thmanyahserifdisplay-Bold.woff2',
      weight: '700',
      style: 'normal',
    },
  ],
  variable: '--font-display-ar',
  display: 'block', // block swap acceptable for PDF render — no live FOUT
  preload: false,
  fallback: ['ThmanyahSans', 'IBM Plex Sans Arabic', 'serif'],
})

// ---------------------------------------------------------------------------
// ThmanyahSerifText — Arabic long-form body (report body text, PDF content)
// NOT included in main bundle. Dynamic import in PDF renderer only.
// ---------------------------------------------------------------------------
export const thmanyahSerifText = localFont({
  src: [
    {
      path: '../../public/fonts/thmanyahseriftext/thmanyahseriftext-Regular.woff2',
      weight: '400',
      style: 'normal',
    },
  ],
  variable: '--font-text-ar',
  display: 'block',
  preload: false,
  fallback: ['ThmanyahSans', 'IBM Plex Sans Arabic', 'Georgia', 'serif'],
})

// ---------------------------------------------------------------------------
// Convenience export — all critical-path fonts for app/layout.tsx className
// ---------------------------------------------------------------------------
export const criticalFontVariables = [
  ibmPlexSansArabic.variable,
  inter.variable,
  thmanyahSans.variable,
  jetbrainsMono.variable,
].join(' ')

// ---------------------------------------------------------------------------
// Type declarations
// ---------------------------------------------------------------------------
export type FontVariant =
  | 'brand-ar'     // ThmanyahSans — brand/marketing Arabic
  | 'ui-ar'        // IBM Plex Sans Arabic — analytics data Arabic
  | 'ui-en'        // Inter — English UI
  | 'number'       // Inter + tabular-nums (applied via CSS)
  | 'code'         // JetBrains Mono
  | 'display-ar'   // ThmanyahSerifDisplay — lazy, PDF only
  | 'text-ar'      // ThmanyahSerifText — lazy, PDF only
