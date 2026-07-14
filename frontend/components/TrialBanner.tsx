'use client';

// Display-only trial banner (launch scope). Reads createdAt + paidAt from the
// EXISTING profile endpoint; computes the label with the pure helper. Renders
// nothing for paid customers or when the trial is unavailable (fail-open).
// No enforcement, no writes.

import { useEffect, useState } from 'react';
import { useAuth, authHeader } from '@/lib/auth';
import { computeTrialDisplay } from '@/lib/trial-display';

interface ProfileLite {
  createdAt?: string | null;
  paidAt?: string | null;
}

export function TrialBanner() {
  const { user, loading } = useAuth();
  const [profile, setProfile] = useState<ProfileLite | null>(null);

  useEffect(() => {
    let alive = true;
    if (!user) {
      setProfile(null);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/v1/clients/${encodeURIComponent(user.uid)}/profile`, {
          headers: await authHeader(),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (alive) setProfile((data && data.profile) || null);
      } catch {
        /* display-only: never block the UI on a fetch failure */
      }
    })();
    return () => {
      alive = false;
    };
  }, [user]);

  if (loading || !user || !profile) return null;

  const d = computeTrialDisplay(
    { createdAt: profile.createdAt, paidAt: profile.paidAt },
    process.env.NEXT_PUBLIC_TRIAL_LAUNCH_AT,
    Date.now(),
  );

  // Paid + unavailable → no trial/expired messaging.
  if (d.state === 'paid' || d.state === 'unavailable') return null;

  const expired = d.state === 'expired';
  return (
    <div
      role="status"
      style={{
        margin: '0 0 16px',
        padding: '12px 16px',
        borderRadius: 12,
        border: `1px solid ${expired ? 'var(--crit)' : 'var(--acc)'}`,
        background: expired ? 'rgba(245,86,110,.10)' : 'rgba(59,123,255,.10)',
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontSize: 14, color: 'var(--text)' }}>
        {expired ? 'Trial expired — Upgrade to continue managing your tracking.' : d.label}
      </span>
      <a
        href="/dashboard"
        style={{
          fontWeight: 700,
          color: expired ? 'var(--crit)' : 'var(--acc)',
          textDecoration: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        Upgrade →
      </a>
    </div>
  );
}
