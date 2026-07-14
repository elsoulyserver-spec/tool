/**
 * Easy Track — Root Layout (P0)
 *
 * Deliberately minimal and self-contained so the migrated /home route BUILDS
 * today. The full next/font + design-token pipeline in fonts.ts / globals.css
 * references assets that are not generated yet (public/fonts/*, packages/
 * design-tokens/generated/css/*) — those are wired back in during PR-2 once the
 * assets exist. P0 uses a system font stack (incl. Arabic) and inline base CSS.
 *
 * Arabic-first: lang="ar" dir="rtl" by default. Locale routing (next-intl)
 * arrives with the AppShell in PR-2.
 */

import type { Metadata, Viewport } from 'next';
import './p0.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: { default: 'Easy Track', template: '%s | Easy Track' },
  description: 'Server-side tracking for Saudi & GCC e-commerce',
  other: { 'format-detection': 'telephone=no' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
