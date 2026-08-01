# Free-Trial Feature — Status: INCOMPLETE (do not enable in production)

**Frozen for launch.** This document records exactly what exists, what is missing,
and why the trial UI must stay off until a clean post-launch follow-up.

## ⛔ Do not enable in production
The trial UI is **not wired end-to-end**. Enabling it now would show trial/expired
messaging without a reliable paid signal on the customer path. Keep it off.

## What is committed (2 commits, local only — NOT pushed, NOT deployed)

| Commit | Scope | State |
|---|---|---|
| `65d9d2d` `feat(billing): add manual paid marker and trial metadata support` | `firestore-service.js`, `.env.example` | ✅ committed |
| `780a253` `feat(frontend): add display-only free trial banner` | `frontend/lib/trial-display.js`, `frontend/components/TrialBanner.tsx`, `frontend/app/home/page.tsx`, `frontend/.env.local.example`, `tests/trial-display.test.js` | ✅ committed |

## Completeness checklist

1. ✅ **Backend can store the manual payment marker.** `firestore-service.updateClient`
   accepts an admin-only `paymentStatus` (`'paid'|'unpaid'`); the server owns `paidAt`
   (`paid` → `serverTimestamp()`, `unpaid` → `null`). Client-supplied `paidAt` is never
   trusted. `paymentStatus` is **only a manual admin marker — not a payment system.**
   `exportAll` exposes `trialLaunchAt` from `TRIAL_LAUNCH_AT`.
2. ✅ **The (inactive) Next.js frontend contains the display helper and banner.**
   `trial-display.js` (pure, fail-open) + `TrialBanner.tsx`. Frontend is **not deployed**
   and gated behind `NEXT_UI_ENABLED=false`.
3. ❌ **The admin control is NOT committed.** The "Mark as paid" control, the derived
   trial chip, and the "Trial Expired · Not Paid" admin notice were implemented in the
   working tree but **deferred** — `admin.html` carries ~871 lines of interleaved
   pre-existing production WIP that must be reviewed/committed separately first.
4. ❌ **The profile endpoint does NOT yet expose `paidAt`.** The change to
   `lib/profile-service.js` (`paidAt`, `paymentStatus`, and a `createdAt` robustness fix)
   is **uncommitted** — that file is untracked pre-existing Phase-2 WIP, so the 3 lines
   were not committed in isolation. Until this lands, `TrialBanner` cannot read a paid
   signal and would fail-open (show nothing / neutral).
5. ⛔ **Therefore the trial UI must NOT be enabled in production.** Missing #3 (no admin
   way to mark paid via a committed UI) and #4 (banner can't see `paidAt`) mean the
   customer-facing trial is not trustworthy yet.

## Freeze constraints (in effect)
- Do **not** push or deploy `65d9d2d` / `780a253`.
- Keep `NEXT_UI_ENABLED=false`; do **not** enable the Next.js `/home` route.
- No new workaround, endpoint, duplicate profile implementation, or temporary
  paid-status source.
- Do **not** modify `admin.html`, `lib/profile-service.js`, `tool.html`, or `server.js`.
- All pre-existing WIP stays untouched and unstaged.

## Uncommitted (intentionally left in the working tree)
- `admin.html` — my trial admin-UI edits sit alongside the pre-existing production WIP
  (interleaved; not separable cleanly right now).
- `lib/profile-service.js` — my 3 trial lines sit alongside its Phase-2 WIP.

## Post-launch follow-up (planned order)
1. **Isolate & commit the existing `admin.html` production WIP** (escapeHtml hardening,
   button restyle, etc.) on its own.
2. **Isolate & commit `lib/profile-service.js`** Phase-2 WIP, including the `paidAt` /
   `paymentStatus` exposure + `createdAt` robustness.
3. **Complete the trial UI in a clean follow-up commit**: the admin "Mark as paid"
   control + trial chip + admin notice, now on a clean `admin.html` baseline.
4. Only then consider enabling the trial UI (with `TRIAL_LAUNCH_AT` set and the frontend
   route enabled).
