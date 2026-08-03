# Free-Trial Feature — Status: backend/admin complete, frontend still off

**Updated 2026-08-01** (release-QA pass on `feature/managed-hosting-phase2`). The previous
version of this document said the admin control and `lib/profile-service.js` changes were
uncommitted working-tree WIP. That is no longer true — `git log` and the code both show
them committed on this branch. This revision reflects what the branch actually contains.

## What is committed

| Area | File(s) | State |
|---|---|---|
| Server-owned trial derivation | `lib/trial-service.js` | ✅ committed, unit-tested (`tests/trial-service.test.js`, 12 tests) |
| Manual paid marker + `paidAt` ownership | `firestore-service.js` (`updateClient`) | ✅ committed |
| Admin audit of paid/unpaid transitions | `server.js` (`POST /api/admin/client/:uid`) | ✅ committed |
| Admin "mark as paid" control + trial chip | `admin.html` | ✅ committed |
| Profile endpoint exposes `paidAt` / `paymentStatus` | `lib/profile-service.js` | ✅ committed |
| Display-only Next.js trial banner | `frontend/lib/trial-display.js`, `frontend/components/TrialBanner.tsx`, `frontend/app/home/page.tsx` | ✅ committed, still **inactive** |

## Verified behaviour (release QA, synthetic data only)

- Trial is derived server-side from the server-stamped `created_at` — never from a
  client-supplied date. Confirmed: a client-written `trialStartedAt`/`trialEndsAt` is
  never trusted as an anchor, and a future `trialAnchoredAt` (only reachable via
  tampering) is rejected.
- `paidAt` is server-owned: `paymentStatus: 'paid'` → `serverTimestamp()`,
  `'unpaid'` → `null`. A client-supplied `paidAt` is never accepted.
- The profile endpoint exposes `paidAt` and `paymentStatus`, so a frontend banner has a
  real signal to fail open on if absent.
- Admin login → mark-paid flow exercised end-to-end against a local server instance with
  production credentials blanked (see the 2026-08-01 QA report); `POST
  /api/admin/client/:uid` with `paymentStatus: 'paid'|'unpaid'` writes the audit log
  (`client_marked_paid` / `client_marked_unpaid`).

## What is still NOT enabled

- ⛔ **The Next.js `/home` trial banner route is still off** (`NEXT_UI_ENABLED=false` in
  `frontend/.env.local.example`). Nothing in this QA/fix pass changed that flag or asked to.
- ⛔ **`TRIAL_LAUNCH_AT` is not set** in any deployed environment. Until it is, existing
  pre-trial-launch accounts should not be treated as having a bounded trial — that is the
  clamp `trial-service.js` implements, but it only activates once the env var is set.
- `admin.html`'s client-side `computeTrialLabel()` re-derives the trial from
  `created_at`/`paidAt` in the browser instead of trusting the server-computed
  `trialStatus` the profile endpoint already returns. This is a duplication, not a
  security issue (the server never trusts what the admin UI displays), but the two
  computations must be kept in sync by hand. Flagged as a P3 in the QA report; not fixed
  here — it is refactor scope, not one of the four authorized P1 fixes.

## Before enabling the customer-facing trial banner

1. Decide and set `TRIAL_LAUNCH_AT` for the actual launch date.
2. Flip `NEXT_UI_ENABLED=true` and deploy the Next.js `/home` route.
3. Re-verify the admin mark-paid → banner-hides flow against a real (non-synthetic)
   staging account before flipping the flag in production.

## Change history

- **2026-08-01** — rewritten during release QA. The prior version said the admin control
  and `lib/profile-service.js` were uncommitted WIP living only in a working tree; both
  are now committed on this branch and were verified working. The freeze constraints in
  that version ("do not modify `admin.html`") no longer apply now that the change is a
  committed, tested part of the branch.
