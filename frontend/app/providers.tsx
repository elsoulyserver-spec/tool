'use client';

import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';

// Client provider tree. P0 = auth only; React Query + theme + i18n providers
// join here in PR-2/PR-4.
export function Providers({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
