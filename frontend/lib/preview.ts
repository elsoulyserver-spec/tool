// P0 launch preview gate — NOT a security control.
//
// The plan requires an admin/email-allowlisted preview before customers see the
// new UI, and forbids percentage rollout. This gate decides only who is SHOWN
// the new Home; it does not protect data. Real data access stays protected by
// server-side Firebase token verification on every /api/* request in server.js.
//
// Closed by default: an empty/unset allowlist means nobody is in the preview.
// Use `*` to explicitly open to all authenticated users once ready.

export function isPreviewAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = (process.env.NEXT_PUBLIC_PREVIEW_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return false;
  if (list.includes('*')) return true;
  return list.includes(email.toLowerCase());
}
