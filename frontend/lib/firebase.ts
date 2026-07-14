'use client';

// Mirror of tool.html's Firebase web config (project easytrack-137d4).
//
// Constraint: reuse the EXISTING Firebase configuration and auth behavior — no
// new auth system, token bridge, or session format. tool.html initializes the
// compat SDK with `firebase.initializeApp(FB_CONFIG)` using the SDK's DEFAULT
// persistence (indexedDB → localStorage). getAuth() below applies that same
// default, and because the Next app is served SAME-ORIGIN via server.js's proxy,
// it reads the identical persisted session — so a user logged in on tool.html is
// already logged in here, with no re-login.
//
// The web API key is a public client identifier (already shipped in tool.html),
// so the production values are safe defaults; NEXT_PUBLIC_* env can override per
// environment.

import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

const firebaseConfig = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY             ?? 'AIzaSyDcnFOWldXptsrbAUoPnZqW7w2qYVf_YnQ',
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN         ?? 'easytrack-137d4.firebaseapp.com',
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID          ?? 'easytrack-137d4',
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET      ?? 'easytrack-137d4.firebasestorage.app',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '976141198118',
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID              ?? '1:976141198118:web:763607661ae0cccb0e57e7',
};

export const firebaseApp: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

// getAuth() (not initializeAuth with an override) so persistence matches
// tool.html's default exactly — this is what makes the session shared.
export const firebaseAuth: Auth = getAuth(firebaseApp);
