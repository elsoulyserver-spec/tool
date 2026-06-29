import type { Config } from 'tailwindcss'
import plugin from 'tailwindcss/plugin'

const config: Config = {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './styles/**/*.css',
  ],

  theme: {
    extend: {

      // ── Font families ──────────────────────────────────────────────────
      // All values reference CSS custom properties injected by next/font.
      // Never hardcode font names in components — use these Tailwind keys.
      fontFamily: {
        // Brand Arabic — ThmanyahSans (headings, brand, marketing)
        'brand-ar': ['var(--font-brand-ar)', 'IBM Plex Sans Arabic', 'Noto Sans Arabic', 'sans-serif'],

        // Analytics Arabic — IBM Plex Sans Arabic (data, tables, labels)
        'ui-ar':    ['var(--font-ui-ar)', 'Noto Sans Arabic', 'sans-serif'],

        // English UI — Inter (all LTR text, platform names, nav)
        'ui-en':    ['var(--font-ui-en)', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],

        // Numbers — Inter + tabular-nums (applied separately via plugin)
        'number':   ['var(--font-number)', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],

        // Code / IDs / technical strings — JetBrains Mono
        'code':     ['var(--font-code)', 'Fira Code', 'Consolas', 'ui-monospace', 'monospace'],

        // Arabic display (lazy — PDF render only)
        'display-ar': ['var(--font-display-ar)', 'var(--font-brand-ar)', 'serif'],

        // Arabic long-form text (lazy — PDF render only)
        'text-ar':  ['var(--font-text-ar)', 'var(--font-brand-ar)', 'Georgia', 'serif'],

        // Direction-aware default: switches between ui-ar / ui-en via CSS
        'sans':     ['var(--font-sans)', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },

      // ── Type scale ─────────────────────────────────────────────────────
      // Mirrors --text-* tokens in typography.css
      fontSize: {
        '2xs':  ['10px', { lineHeight: '14px' }],
        'xs':   ['11px', { lineHeight: '16px' }],
        'sm':   ['12px', { lineHeight: '18px' }],
        'base': ['13px', { lineHeight: '20px' }],   // Arabic minimum
        'md':   ['14px', { lineHeight: '20px' }],
        'lg':   ['15px', { lineHeight: '22px' }],
        'xl':   ['16px', { lineHeight: '24px' }],
        '2xl':  ['18px', { lineHeight: '28px' }],
        '3xl':  ['20px', { lineHeight: '28px' }],
        '4xl':  ['24px', { lineHeight: '32px' }],
        '5xl':  ['30px', { lineHeight: '36px' }],
        '6xl':  ['36px', { lineHeight: '44px' }],
      },

      // ── Line heights ────────────────────────────────────────────────────
      lineHeight: {
        'table':      '1',      // required for virtual scroll fixed rows
        'tight':      '1.25',
        'snug':       '1.375',
        'normal':     '1.5',
        'relaxed':    '1.625',
        'loose':      '1.75',
        // Arabic — always use these for Arabic text
        'ar-tight':   '1.5',
        'ar-snug':    '1.65',
        'ar-normal':  '1.75',
        'ar-relaxed': '1.85',
        'ar-loose':   '2.0',
      },

      // ── Font weights ────────────────────────────────────────────────────
      fontWeight: {
        light:    '300',
        regular:  '400',
        medium:   '500',
        semibold: '600',
        bold:     '700',
      },

      // ── Letter spacing ──────────────────────────────────────────────────
      letterSpacing: {
        tighter: '-0.05em',
        tight:   '-0.025em',
        normal:   '0em',
        wide:     '0.025em',
        wider:    '0.05em',
        widest:   '0.1em',
      },

    },
  },

  plugins: [
    // ── Numeric variant utilities ────────────────────────────────────────
    // Adds: font-tabular, font-proportional, font-oldstyle, font-lining
    plugin(({ addUtilities }) => {
      addUtilities({
        // Tabular numerals — fixed-width digits for column alignment
        '.font-tabular': {
          'font-variant-numeric': 'tabular-nums',
          'font-feature-settings': '"tnum" 1, "lnum" 1',
        },
        // Proportional numerals — variable-width (for prose)
        '.font-proportional': {
          'font-variant-numeric': 'proportional-nums',
          'font-feature-settings': '"pnum" 1',
        },
        // Old-style numerals — lowercase descending figures (unused in analytics)
        '.font-oldstyle': {
          'font-variant-numeric': 'oldstyle-nums',
          'font-feature-settings': '"onum" 1',
        },
        // Lining numerals — uppercase height figures
        '.font-lining': {
          'font-variant-numeric': 'lining-nums',
          'font-feature-settings': '"lnum" 1',
        },
        // Slash zero — 0̸ for disambiguation in IDs and code
        '.font-slashed-zero': {
          'font-feature-settings': '"zero" 1',
        },
        // Combined: analytics default — tabular + lining + slashed zero
        '.font-analytics': {
          'font-family':           'var(--font-number)',
          'font-variant-numeric':  'tabular-nums lining-nums',
          'font-feature-settings': '"tnum" 1, "lnum" 1, "zero" 1',
          'direction':             'ltr',
          'unicode-bidi':          'isolate',
        },
      })
    }),

    // ── Bidi isolation utilities ─────────────────────────────────────────
    plugin(({ addUtilities }) => {
      addUtilities({
        '.bidi-isolate': {
          'unicode-bidi': 'isolate',
        },
        '.bidi-embed': {
          'unicode-bidi': 'embed',
        },
        '.bidi-override': {
          'unicode-bidi': 'bidi-override',
        },
        '.bidi-isolate-override': {
          'unicode-bidi': 'isolate-override',
        },
        // Force LTR within any parent direction — for numbers, IDs, URLs
        '.dir-ltr': {
          direction:       'ltr',
          'unicode-bidi':  'isolate',
        },
        // Force RTL within any parent direction
        '.dir-rtl': {
          direction:       'rtl',
          'unicode-bidi':  'isolate',
        },
      })
    }),

    // ── Analytics typography composites ──────────────────────────────────
    // Single-class shorthands for the most common analytics patterns
    plugin(({ addComponents }) => {
      addComponents({
        // KPI metric number: large, bold, tabular, always LTR
        '.type-metric': {
          fontFamily:         'var(--font-number)',
          fontVariantNumeric: 'tabular-nums lining-nums',
          fontFeatureSettings:'"tnum" 1, "lnum" 1, "zero" 1',
          fontWeight:         '700',
          direction:          'ltr',
          unicodeBidi:        'isolate',
          whiteSpace:         'nowrap',
          letterSpacing:      '-0.025em',
        },
        // Currency: medium weight, tabular, always LTR
        '.type-currency': {
          fontFamily:         'var(--font-number)',
          fontVariantNumeric: 'tabular-nums lining-nums',
          fontFeatureSettings:'"tnum" 1, "lnum" 1',
          fontWeight:         '500',
          direction:          'ltr',
          unicodeBidi:        'isolate',
          whiteSpace:         'nowrap',
        },
        // Percentage: semibold, tabular, always LTR
        '.type-percentage': {
          fontFamily:         'var(--font-number)',
          fontVariantNumeric: 'tabular-nums',
          fontFeatureSettings:'"tnum" 1',
          fontWeight:         '600',
          direction:          'ltr',
          unicodeBidi:        'isolate',
          whiteSpace:         'nowrap',
        },
        // Event name: Inter, medium, always LTR
        '.type-event': {
          fontFamily:  'var(--font-ui-en)',
          fontWeight:  '500',
          fontSize:    '12px',
          direction:   'ltr',
          unicodeBidi: 'isolate',
          whiteSpace:  'nowrap',
          overflow:    'hidden',
          textOverflow:'ellipsis',
        },
        // Technical ID: monospace, always LTR
        '.type-id': {
          fontFamily:    'var(--font-code)',
          fontSize:      '11px',
          fontWeight:    '400',
          direction:     'ltr',
          unicodeBidi:   'isolate',
          letterSpacing: '0.02em',
          whiteSpace:    'nowrap',
          overflow:      'hidden',
          textOverflow:  'ellipsis',
        },
        // Table cell: analytics data in Arabic UI
        '.type-table-ar': {
          fontFamily:  'var(--font-ui-ar)',
          fontSize:    '13px',          // minimum for Arabic
          fontWeight:  '400',
          lineHeight:  '1',             // fixed — required for virtual scroll
          direction:   'rtl',
          unicodeBidi: 'isolate',
          whiteSpace:  'nowrap',
          overflow:    'hidden',
          textOverflow:'ellipsis',
        },
        // Table cell: analytics data in English UI
        '.type-table-en': {
          fontFamily:  'var(--font-ui-en)',
          fontSize:    '12px',
          fontWeight:  '400',
          lineHeight:  '1',
          direction:   'ltr',
          unicodeBidi: 'isolate',
          whiteSpace:  'nowrap',
          overflow:    'hidden',
          textOverflow:'ellipsis',
        },
      })
    }),
  ],
}

export default config
