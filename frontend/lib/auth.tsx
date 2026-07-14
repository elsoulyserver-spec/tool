'use client';

// Auth context that reads the EXISTING Firebase session (see lib/firebase.ts).
// No new login flow — onAuthStateChanged resolves whoever tool.html already
// signed in on this origin. authHeader() reproduces exactly what server.js's
// /api/* handlers expect: `Authorization: Bearer <Firebase ID token>`.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { firebaseAuth } from './firebase';

export interface AuthState {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ user: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });

  useEffect(() => {
    const unsub = onAuthStateChanged(
      firebaseAuth,
      (user) => setState({ user, loading: false }),
      () => setState({ user: null, loading: false }), // error → treat as signed out
    );
    return () => unsub();
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

// Attach the current user's Firebase ID token to an outbound API request.
// Returns {} when signed out so callers can decide how to handle it.
export async function authHeader(): Promise<Record<string, string>> {
  const u = firebaseAuth.currentUser;
  if (!u) return {};
  const token = await u.getIdToken(false);
  return { Authorization: `Bearer ${token}` };
}
