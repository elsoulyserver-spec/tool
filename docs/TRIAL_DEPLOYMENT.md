# Trial, Container Deletion & Admin Auth — Deployment / Launch Checklist

This document covers the production rollout of the 7-day trial, the admin
container-deletion controls, and the secure admin login. Read it before flipping
any of the environment flags below.

Related code:
- `lib/trial-service.js` — pure trial derivation (`computeTrial`)
- `firestore-service.js` — `ensureTrialFields`, `updateClient`, container-teardown helpers
- `lib/profile-service.js` — exposes the read-only `trial` block on the customer profile
- `lib/container-deletion-service.js` — `previewCleanup` (dry run) + `deleteClientContainer`
- `lib/admin-session.js` + `lib/admin-session-store.js` — admin session layer
- `server.js` — admin endpoints (`/api/admin/login|logout|session`, `/api/admin/client/:uid/check-cleanup|delete-container|retry-cleanup`)

---

## 1. Trial

The trial is **derived on the server** and never trusted from the frontend. The
client `clients/{uid}` document is created client-side at signup with a
server-stamped `created_at`; there is no backend creation hook, so the trial is
computed from trusted server timestamps on every read.

### `TRIAL_LAUNCH_AT`
- ISO-8601 timestamp (e.g. `2026-08-01T00:00:00Z`). Optional.
- It **clamps the trial start forward** so accounts that predate the launch are
  not retroactively expired.

Effective trial start = `max(anchor, TRIAL_LAUNCH_AT)` where `anchor` is the
trusted server timestamp (see below). Trial end = start + **7 days**.

- **Existing client created BEFORE `TRIAL_LAUNCH_AT`** → trial starts at
  `TRIAL_LAUNCH_AT` (everyone gets a fresh 7 days from launch, not a retroactive
  expiry). `created_at` is preserved untouched.
- **New client created ON/AFTER `TRIAL_LAUNCH_AT`** → trial starts at the
  server `created_at`.
- If `TRIAL_LAUNCH_AT` is unset, the trial simply anchors to `created_at`.

> Rollout tip: set `TRIAL_LAUNCH_AT` to the go-live instant **before** exposing
> the trial UI, so the entire existing customer base begins its 7-day window at
> launch rather than being computed as already-expired.

### `trialAnchoredAt`
For legacy/malformed docs that have **no** `created_at`, `ensureTrialFields`
(called on the first authenticated profile read) stamps a **server**
`trialAnchoredAt` timestamp **once**. `computeTrial` then anchors to that value.
Until a trusted anchor exists, the trial status is reported as **`unknown`** —
never an unbounded "active" trial.

### Why client-written trial dates are ignored
`computeTrial` anchors **only** on trusted, server-owned timestamps
(`created_at`, or the server-stamped `trialAnchoredAt`). A `trialStartedAt` /
`trialEndsAt` value present on the document is treated as a **display cache
only** and is never used as an anchor — so a customer who writes those fields
directly (e.g. via a permissive Firestore rule) **cannot extend their trial**.
`trialEndsAt` is always derived (`start + 7d`), never read back for logic.

### Trial states (read-only, on the customer profile)
`paymentStatus` = `unpaid | paid`; `trialStatus` = `active | expired | converted | unknown`.
- unpaid & before end → `active` (+ `trialDaysRemaining`)
- paid (`paidAt` set, admin-marked) → `converted`
- unpaid & after end → `expired`
- no trusted anchor yet → `unknown`

The customer cannot mutate `paidAt`, `paymentStatus`, `trialStartedAt`,
`trialEndsAt`, `trialStatus`, `trialAnchoredAt`, or `containerStatus` — the
self-service profile update allow-list excludes them, and payment state is
written only by the admin `updateClient` path.

---

## 2. Container deletion

### `CONTAINER_DELETION_ENABLED` (default `false`)
Global fail-safe kill-switch for the destructive teardown (`delete-container`
and `retry-cleanup`). While `false`, **both endpoints reject with `503`
(`deletion_disabled`)** for everyone — even an authenticated admin — and the
check runs **before** any client resource is loaded or modified.

**Keep this `false` during launch.** Only set it to `true` when:
1. `TRIAL_LAUNCH_AT` has been set and verified, so no existing client is
   spuriously `expired`.
2. You have confirmed (e.g. via the dry-run preview) which clients are genuinely
   expired + unpaid.
3. You are performing a deliberate, supervised teardown.

Turn it back to `false` immediately afterward.

### What deletion touches
Managed sGTM infra **only**, per client: the Cloud Run tagging service
(`managed_servers.taggingServiceName`), the edge `managed_route`, and the
`managed_containers` docs (marked `status:'deleted'`). It does **not** delete the
GTM container via the GTM API, and it **never** deletes the customer account or
the `clients/{uid}` document.

### Eligibility (enforced by the backend, independently of the UI)
Deletion is allowed only when **all** hold:
- trial `expired`, **and**
- `paymentStatus === 'unpaid'`, **and**
- container not already `deleted`.

### Dry-run preview
`GET /api/admin/client/:uid/check-cleanup` is a **read-only** dry run: it returns
`{ eligible, reason, paymentStatus, trialStatus, containerStatus, resources[] }`
and performs no writes / no infra calls. It is **not** gated by
`CONTAINER_DELETION_ENABLED` (previewing is always safe). The admin UI calls it
first and shows exactly which resources will be removed before asking the admin
to type `DELETE`. The real delete endpoint re-validates eligibility on the
backend — the preview is never trusted for authorization.

### Honest partial failure
If any single resource fails to delete, the result is `partial_failure`: the
client is **not** marked fully deleted, and failing resources are reported
individually. Use `POST /api/admin/client/:uid/retry-cleanup` to re-attempt.

---

## 3. Admin authentication

### `ADMIN_SECRET_KEY`
The admin dashboard requires this secret at `POST /api/admin/login`. A successful
login returns an **HttpOnly** session cookie (`et_admin_session`) plus a readable
`et_admin_csrf` cookie for double-submit CSRF. The raw secret is never returned
in a response, never logged, and never stored in `localStorage`/`sessionStorage`.

**Production fails closed:** when `NODE_ENV=production` and `ADMIN_SECRET_KEY` is
missing/empty, admin login is disabled and `POST /api/admin/login` returns `503`.
Set the real value only in the server environment (leave it empty in
`.env.example`). The legacy `ADMIN_TOKEN` Bearer path remains accepted for
server-to-server callers.

Generate a key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

State-changing admin requests require a valid session cookie **and** a matching
`X-CSRF-Token` header **and** a same-origin `Origin`/`Referer`. Login is
rate-limited per IP with a lockout after repeated failures.

### Session store (swappable)
Sessions currently live in an **in-memory** store (`lib/admin-session-store.js`,
`createInMemoryStore()`), suitable for the single-instance deploy. They reset on
restart and are not shared across instances — admins simply re-login. The store
is accessed only through a small async interface (`get/set/delete/list/clear`)
via `adminSession.setStore(...)`, so a **Redis or Firestore** backend can be
introduced later **without changing the authentication flow**.

---

## 4. Rollback (config-only, no redeploy of code)

All three subsystems can be neutralized purely by environment configuration:

| To disable | Set | Effect |
|---|---|---|
| Container deletion | `CONTAINER_DELETION_ENABLED=false` (default) | `delete-container` + `retry-cleanup` return `503`; no teardown possible |
| Trial launch clamp | unset `TRIAL_LAUNCH_AT` | trial derives from `created_at` only (revert the launch-window behavior) |
| Admin dashboard access | unset `ADMIN_SECRET_KEY` (prod) | cookie login disabled (`503`); dashboard inaccessible via the secret-key path |
| New Next.js UI | `NEXT_UI_ENABLED=false` (default) | app UI unchanged (unrelated to trial/admin, kept off) |

The trial is display/derivation only and drives no automated action on its own —
the only destructive path (container deletion) is independently gated by
`CONTAINER_DELETION_ENABLED`. Flipping that flag off is the fastest, safest
rollback for the deletion feature.

After any config change, restart the service so the new environment is read.
