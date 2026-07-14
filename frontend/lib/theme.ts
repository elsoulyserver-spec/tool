/**
 * Easy Track — Theme Architecture
 *
 * Theme switching strategy:
 *  - Primitives:   always in :root (immutable, never themed)
 *  - Semantic:     in [data-theme="light|dark|..."] — switched client-side
 *  - Brand:        in [data-tenant="<id>"] — injected server-side per tenant
 *  - Component:    derived from semantic + brand — no separate scope needed
 *
 * Anti-flash strategy:
 *  1. Server reads theme cookie in middleware → sets data-theme on <html> SSR
 *  2. No client-side flash because initial HTML already has correct data-theme
 *  3. Theme changes client-side update cookie + data-theme attribute atomically
 *
 * White-label:
 *  1. Tenant ID from JWT/session → looked up in TenantThemeStore
 *  2. Tenant CSS overrides injected as <style> in server-rendered <head>
 *  3. Overrides only target --brand-* vars — never --primitive-* or --semantic-*
 */

export type ThemeName = 'light' | 'dark' | 'high-contrast' | 'enterprise'

export interface TenantTheme {
  tenantId:    string
  displayName: string

  // Brand colors — only these are overridable
  primaryColor?:      string   // hex or hsl — must pass WCAG AA against white + black
  primaryHoverColor?: string
  primaryLightColor?: string
  primaryTextColor?:  string   // text on primary bg — must pass WCAG AA against primaryColor
  accentColor?:       string

  // Brand assets
  logoUrl?:     string
  logoDarkUrl?: string
  faviconUrl?:  string

  // Brand radius — tenants can choose sharp/rounded/pill style
  // Values: '0px' (sharp) | '4px' (mild) | '6px' (default) | '9999px' (pill)
  radiusBase?:  string

  // Brand typography — Google Fonts family name only (no arbitrary URLs)
  googleFontAr?: string   // e.g. 'Noto Sans Arabic'
  googleFontEn?: string   // e.g. 'Rubik'
}

// ── Server: inject tenant CSS ─────────────────────────────────────────────────
// Called in layout.tsx to generate the <style> block for the tenant's overrides.
// Only --brand-* vars are emitted — semantic and primitive vars are immutable.

export function buildTenantCSS(theme: TenantTheme): string {
  const vars: string[] = []

  if (theme.primaryColor)      vars.push(`  --brand-color-primary: ${theme.primaryColor};`)
  if (theme.primaryHoverColor) vars.push(`  --brand-color-primary-hover: ${theme.primaryHoverColor};`)
  if (theme.primaryLightColor) vars.push(`  --brand-color-primary-light: ${theme.primaryLightColor};`)
  if (theme.primaryTextColor)  vars.push(`  --brand-color-primary-text: ${theme.primaryTextColor};`)
  if (theme.accentColor)       vars.push(`  --brand-color-accent: ${theme.accentColor};`)
  if (theme.radiusBase)        vars.push(`  --brand-radius-base: ${theme.radiusBase};`)

  if (vars.length === 0) return ''

  return [
    `/* Tenant: ${theme.tenantId} */`,
    `[data-tenant="${theme.tenantId}"] {`,
    ...vars,
    `}`,
  ].join('\n')
}

// ── Client: theme switcher ────────────────────────────────────────────────────

const THEME_COOKIE  = 'et-theme'
const THEME_DEFAULT: ThemeName = 'light'

export function getTheme(): ThemeName {
  if (typeof document === 'undefined') return THEME_DEFAULT
  const attr = document.documentElement.getAttribute('data-theme') as ThemeName | null
  return attr ?? THEME_DEFAULT
}

export function setTheme(theme: ThemeName): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
  // Persist to cookie so server can SSR the correct theme on next request
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`
}

export function toggleTheme(): void {
  const current = getTheme()
  setTheme(current === 'light' ? 'dark' : 'light')
}

// ── Server: read theme from cookie for SSR ────────────────────────────────────
// Call this in Next.js middleware or server component to read the persisted theme.

export function getThemeFromCookie(cookieHeader: string | null): ThemeName {
  if (!cookieHeader) return THEME_DEFAULT
  const match = cookieHeader.match(new RegExp(`${THEME_COOKIE}=([^;]+)`))
  const value  = match?.[1] as ThemeName | undefined
  const valid: ThemeName[] = ['light', 'dark', 'high-contrast', 'enterprise']
  return valid.includes(value as ThemeName) ? (value as ThemeName) : THEME_DEFAULT
}

// ── WCAG contrast validation for tenant colors ────────────────────────────────
// Validate that tenant-provided primary color meets WCAG AA before applying.
// Call this in the tenant theme API endpoint, not client-side.

function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.replace('#', '')
  if (clean.length !== 6) return null
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return [r, g, b]
}

function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map(c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}

function contrastRatio(hex1: string, hex2: string): number {
  const rgb1 = hexToRgb(hex1)
  const rgb2 = hexToRgb(hex2)
  if (!rgb1 || !rgb2) return 0

  const l1 = relativeLuminance(...rgb1)
  const l2 = relativeLuminance(...rgb2)
  const lighter = Math.max(l1, l2)
  const darker  = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

export type ContrastResult = {
  passes: boolean
  ratio:  number
  level:  'AAA' | 'AA' | 'AA Large' | 'Fail'
}

export function validateTenantColor(primaryHex: string, textOnPrimary: string = '#ffffff'): ContrastResult {
  const ratio = contrastRatio(primaryHex, textOnPrimary)
  const passes = ratio >= 4.5
  const level = ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA Large' : 'Fail'
  return { passes, ratio: Math.round(ratio * 100) / 100, level }
}

// ── Tenant theme store (in-memory; swap for Redis/DB in production) ───────────

const TENANT_THEMES = new Map<string, TenantTheme>()

export function registerTenantTheme(theme: TenantTheme): void {
  TENANT_THEMES.set(theme.tenantId, theme)
}

export function getTenantTheme(tenantId: string): TenantTheme | null {
  return TENANT_THEMES.get(tenantId) ?? null
}

// ── Type exports ──────────────────────────────────────────────────────────────

export type { TenantTheme as TenantThemeConfig }
