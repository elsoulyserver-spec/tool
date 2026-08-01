'use client';

// PR-1 proof route (/home). This is NOT the real Home yet — PR-2/PR-4 build the
// tracking-first dashboard here. Its only job is to prove the migration harness:
//   1. Next.js renders at /home (proxied same-origin by server.js).
//   2. The EXISTING Firebase session is recognized with no re-login.
//   3. The admin/email preview gate works.
//   4. Signed-out users are sent to the legacy sign-in.
// All CTAs link to existing legacy production flows (constraint: don't rebuild).

import { useAuth } from '@/lib/auth';
import { isPreviewAllowed } from '@/lib/preview';
import { TrialBanner } from '@/components/TrialBanner';

const card: React.CSSProperties = {
  maxWidth: 520,
  margin: '12vh auto',
  padding: '32px',
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 16,
};
const eyebrow: React.CSSProperties = {
  font: '600 11px ui-monospace, monospace',
  letterSpacing: 2,
  textTransform: 'uppercase',
  color: 'var(--acc)',
};
const btn: React.CSSProperties = {
  display: 'inline-block',
  marginTop: 18,
  padding: '10px 18px',
  borderRadius: 10,
  background: 'var(--acc)',
  color: '#fff',
  fontWeight: 700,
  textDecoration: 'none',
};
const ghost: React.CSSProperties = { ...btn, background: 'transparent', border: '1px solid var(--line)', color: 'var(--muted)' };

function Pill({ tone, children }: { tone: 'good' | 'warn' | 'crit'; children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 100, fontSize: 12, fontWeight: 700, color: `var(--${tone})`, background: 'color-mix(in srgb, var(--' + tone + ') 15%, transparent)' }}>
      {children}
    </span>
  );
}

export default function HomeProof() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <main style={card} aria-busy="true">
        <div style={eyebrow}>EasyTrac · new UI</div>
        <h1 style={{ fontSize: 22 }}>Checking your session…</h1>
        <p style={{ color: 'var(--muted)' }}>Reading your existing Firebase login.</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main style={card}>
        <div style={eyebrow}>EasyTrac · new UI</div>
        <h1 style={{ fontSize: 22 }}>You&apos;re signed out</h1>
        <p style={{ color: 'var(--muted)' }}>Sign in to continue — you&apos;ll come right back here.</p>
        <a href="/sign-in" style={btn}>Go to sign in →</a>
      </main>
    );
  }

  const allowed = isPreviewAllowed(user.email);

  if (!allowed) {
    return (
      <main style={card}>
        <div style={eyebrow}>EasyTrac · new UI</div>
        <h1 style={{ fontSize: 22 }}>Signed in as {user.email} <Pill tone="warn">preview only</Pill></h1>
        <p style={{ color: 'var(--muted)' }}>
          The new experience is in a limited preview. Your session was recognized correctly — you just
          aren&apos;t on the allowlist yet. Continue in the current app.
        </p>
        <a href="/dashboard" style={btn}>Open EasyTrac →</a>
      </main>
    );
  }

  return (
    <main style={card}>
      <TrialBanner />
      <div style={eyebrow}>EasyTrac · new UI</div>
      <h1 style={{ fontSize: 22 }}>Shared session verified <Pill tone="good">✓ live</Pill></h1>
      <p style={{ color: 'var(--muted)' }}>
        Signed in as <strong style={{ color: 'var(--text)' }}>{user.email}</strong> — recognized from your
        existing login, no re-authentication. The tracking-first Home dashboard lands here in PR-2.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <a href="/dashboard" style={btn}>Continue to app →</a>
        <a href="/tool" style={ghost}>Legacy tool</a>
      </div>
    </main>
  );
}
