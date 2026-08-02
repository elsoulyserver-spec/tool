# Events Explorer / Event Details — Cold-Start Integration Brief

**Status:** Sections 1-12 below are research only (no application code changed as part of that research). **Phase A is approved and in execution** — see the standalone execution spec immediately below. Phases B-E remain research/proposal only; none of that work is approved, scheduled, or started.
**Scope:** what it would take to bring the approved `Events Explorer` and `Event Details` screens (design handoff: [`EasyTrac Tracking Command Center/design_handoff_easytrac_design_system`](<../../EasyTrac Tracking Command Center/design_handoff_easytrac_design_system>), pattern reference [`patterns/EventDetails.js`](<../../EasyTrac Tracking Command Center/design_handoff_easytrac_design_system/patterns/EventDetails.js>)) into the live product.
**Method:** direct inspection of `tool.html`, `server.js`, `firestore-service.js`, `lib/*.js`, and `tests/*.test.js` in this repository. All claims below are grounded in file:line citations against the current working tree.

---

## Phase A — Approved Execution Spec (independent of the Events feature)

**Read this section on its own.** Phase A is approved and scoped to stand completely apart from the Events Explorer / Event Details feature described in the rest of this document, and separately from the Event Observability V1 product/backend decision (`docs/product/event-observability-v1.md`) — Phase A has no functional dependency on either. Phase A is: *make the already-approved design-system bundle loadable and importable inside the live frontend, with theming, RTL/LTR, and density support wired through.* Nothing user-visible renders differently when Phase A ships — it adds dormant capability, not a visible feature.

**Git baseline:** HEAD at the start of Phase A implementation is `35652057dbc06cdea5393906fd0d4713621e39a2`. This is the rollback point.

### What Phase A is
Load the existing, already-built, already-reviewed vanilla-JS/CSS design-system bundle ([`EasyTrac Tracking Command Center/design_handoff_easytrac_design_system`](<../../EasyTrac Tracking Command Center/design_handoff_easytrac_design_system>)) into `tool.html` so its CSS token layer (including dark/light theme and density modes), layout primitives, and shared operational components are loadable and importable — via a token bridge and native ESM `<script type="module">`, per §7's recommendation below. That's the entire scope.

### What Phase A explicitly is NOT
- No Events navigation entry, no Events route/view, no Event Details drawer.
- No telemetry ingestion, no new Firestore collections, no new Firestore indexes, no TTL policies, no event APIs — none of `docs/product/event-observability-v1.md` is implemented here.
- No mock, placeholder, or sample production-shaped data rendered anywhere in the live app.
- No inline-style or inline-script transcription of the design bundle into `tool.html` — the bundle stays self-contained, imported by reference, and remains the visual source of truth (per §7).
- No change to any existing view's markup, behavior, routing, or auth flow.
- No backend changes **except** the one narrowly-scoped exception below — everything else in `server.js`, all of `firestore-service.js`, all of `lib/**`, and `firestore.indexes.json` are untouched.

### Verified before transfer (repo-grounded, not assumed)

- **CSP compatibility confirmed.** `server.js`'s `CSP_DIRECTIVES` (`server.js:1059-` ) includes `'self'` in both `script-src` and `style-src`, and `securityHeaders({html:true})` is applied whenever an HTML response is served (`server.js:4909`, `entry.isHtml`). Same-origin `<link rel="stylesheet">` and `<script type="module">` additions are not blocked by the existing CSP — no CSP change is needed or permitted.
- **Static-file allowlist gap found and the fix scoped.** `server.js`'s static file server (`server.js:4863-4916`) gates every response through `STATIC_ALLOW_EXT` (`server.js:1610-1615`), which currently contains `.html, .css, .png, .jpg, .jpeg, .gif, .webp, .svg, .ico, .woff, .woff2, .ttf, .otf, .txt, .map` — **no `.js`**. Every `.js` file in the design-system bundle (and any new bootstrap module) would 404/403 under this allowlist as-is. The `mime` map and `_COMPRESSIBLE` set elsewhere in `server.js` already list `.js`, so this is a one-line gap, not a missing subsystem. **Approved fix, explicitly scoped:** add `'.js'` to the `STATIC_ALLOW_EXT` set at `server.js:1610-1615` — this one line, and nothing else in `server.js`, is in scope for Phase A. This was raised to and approved by the user specifically because it is the only way to load the bundle's actual multi-file ESM graph via real imports rather than forking its source into `tool.html`.
- **Design-system bundle confirmed independent of the monolithic `.dc.html` handoff file.** Grepped every `.js`/`.css` file under `EasyTrac Tracking Command Center/design_handoff_easytrac_design_system/**` for references to `.dc.html` or the `dc-runtime`/`support.js` preview engine — the only matches are prose mentions inside `README.md` (documentation, not executable code). No component, pattern, token file, or `index.js` imports, fetches, or otherwise depends on any `.dc.html` file at runtime. The bundle is genuinely self-contained vanilla JS/CSS, safe to import directly.
- **Density mode confirmed trivial to wire.** `tokens/density.css` is a single, self-contained file: four `[data-density="low"|"medium"|"high"|"veryhigh"]` blocks setting a handful of `--d-*` custom properties (row height, padding, gap, font size, icon size). Loading it is part of the standard CSS load order already specified below; Phase A additionally sets `data-density="medium"` as a sane default on the token-bridge scope wrapper (not on `<html>`, so it cannot affect any existing markup that doesn't opt into the bundle's scope).

### Files Phase A adds
| File | Purpose |
|---|---|
| `assets/design-system-token-bridge.css` (new) | One-directional CSS custom-property aliases mapping `tool.html`'s existing token vocabulary (`--bg`, `--sur`/`--sur2`/`--sur3`, `--acc`, `--wht`/`--wht2`, `--mut`/`--mut2`, `--grn`/`--red`/`--blu`/`--amber`, `--bdr`/`--bdr2`) onto the design bundle's token vocabulary (`--surface-canvas`/`-1`/`-2`/`-3`, `--text-primary`/`-secondary`/`-tertiary`, `--status-*-fg`/`-bg`/`-border`, `--brand`, `--border-subtle`/`-default`/`-strong`, ...), scoped under one wrapper class so it never leaks into `tool.html`'s existing cascade. Also sets `data-density="medium"` as the default on that same scope wrapper. |
| `assets/design-system-bootstrap.js` (new) | An ESM module that imports the layout primitives and shared operational components tool.html will need in a later phase (`createAppShell`, `createPage`, `createPanel`, `createSection`, `createStatusChip`, `createEventTrace`, `createBreadcrumbs`, `createButton`, ...) from the bundle's `index.js`/individual files, and exposes them for later phases to consume. It does not mount anything into the live DOM. |

### Files Phase A modifies
| File | Change |
|---|---|
| `tool.html` | Additive only, confined to `<head>`: `<link>` tags loading the design bundle's CSS in its documented order (`tokens/primitives.css` → `tokens/semantic.dark.css` [+ `tokens/semantic.light.css`] → `tokens/density.css` → `tokens/component-tokens.css` → `tokens/motion.css` → `layout/layout.css` → `components/components.css` → `operational/operational.css`), plus the new token-bridge stylesheet, plus one `<script type="module" src="assets/design-system-bootstrap.js">`. **No other line in `tool.html` changes** — `APP_VIEWS`, `#et-sidebar`, every `.app-view` block, every `switchAppView`/`loadXView` function, and every existing inline style are untouched. |
| `server.js` | **Exactly one line**, at `STATIC_ALLOW_EXT` (`server.js:1610-1615`): add `'.js'` to the Set. No other line in `server.js` changes — no new route, no new endpoint, no change to any auth function (`_requireAdmin`, `ssAuthAndRate`, `verifyIdToken` call sites), no change to `CSP_DIRECTIVES`, no change to any `/api/*` handler. This is the only backend change Phase A is authorized to make. |

### Files Phase A must NOT touch
- `firestore-service.js`, any file under `lib/**`, `firestore.indexes.json` — zero changes, no exceptions.
- Any line in `server.js` other than the single `STATIC_ALLOW_EXT` addition above.
- `admin.html`, `index.html`, `frontend/**` — out of scope.
- The design-handoff bundle itself (`EasyTrac Tracking Command Center/design_handoff_easytrac_design_system/**`) — consumed read-only, as the already-approved visual source of truth. Not edited, not forked, not partially copied.
- Any existing test file under `tests/*.test.js`.
- `docs/product/event-observability-v1.md` and everything it describes (no telemetry, no ingestion, no new collections/indexes/TTL/APIs).

### Acceptance criteria

**Build integrity**
- `tool.html` loads with zero new console errors/warnings on first paint, across every existing view.
- The new `<script type="module">` does not block or delay first paint of the existing UI (native `type="module"` is deferred by spec; confirm no synchronous side effect was added).
- No existing `<script>` tag or inline handler in `tool.html` is reordered, removed, wrapped, or re-indented beyond the new additions.
- The app's Node process starts cleanly after the `STATIC_ALLOW_EXT` edit (syntax-valid, no startup error).

**No route regressions**
- `APP_VIEWS` (`tool.html:7455`) is byte-for-byte unchanged; all 9 existing view keys still resolve to the same DOM ids.
- `switchAppView` (`tool.html:7498`) behavior — view show/hide, sidebar active-state, every per-view side-effect loader (`loadOpsOverviewCards`, `loadVersionsView`, `loadDeploymentsView`, `loadHealthView`, `loadAuditView`, `msLoadServer`, `_loadProjectsIntoView`, GTM-view rendering) — is unchanged for every existing view key.
- No new `.app-view` block or `.sb-link` sidebar button exists in the DOM.

**No authentication regressions**
- `firebase.auth()` initialization, `onAuthStateChanged` (`tool.html:15767`), `currentUser` population (`tool.html:16672`), and `_opsFetch`'s bearer-token attachment (`tool.html:7595-7600`) are byte-for-byte unchanged.
- Both existing server-side authorization tiers (`_requireAdmin()` admin routes, per-owner `decoded.uid` routes, `ssAuthAndRate()`) are unchanged — confirmed via diff (only the one `STATIC_ALLOW_EXT` line differs in `server.js`), not just runtime testing.

**Generator, provisioning, admin, and billing behavior unchanged**
- GTM/sGTM container generation (`lib/gtm-config-builder.js`), provisioning job handling, the admin panel (`admin.html`), and billing/trial logic (`lib/trial-service.js`, `docs/TRIAL-FEATURE-STATUS.md` behavior) are untouched by construction — no file in any of those paths appears in the diff.
- Existing `tests/*.test.js` (including `pii-hashing.test.js` and `capi-json-safety.test.js`) pass unmodified.

**Dark/light theme**
- `data-t="dark"` and `data-t="light"` both continue to render every existing view correctly (no visual regression against current behavior).
- The design bundle's own theme contract (`[data-theme="dark"|"light"]` per its tokens/semantic.*.css) is resolved entirely through the token-bridge against `tool.html`'s existing `data-t` attribute — confirm there is no second, competing theme attribute introduced, and no requirement for `tool.html` to also set `data-theme`.

**RTL/LTR**
- `dir="rtl"` (`tool.html`'s default) continues to render every existing view correctly.
- The design bundle's RTL-aware components (documented per-component in their own header blocks — e.g. Sidebar/EventTrace/Breadcrumbs mirror under `[dir="rtl"]`) are verified to also respect `dir="rtl"` when instantiated in an isolated, throwaway verification harness (same approach used during the earlier design-pattern review) — not by adding a permanent demo view to `tool.html`.

**Density modes**
- `tokens/density.css` loads and all four `[data-density]` variants resolve their `--d-*` custom properties without error.
- The `data-density="medium"` default lives only on the token-bridge scope wrapper, not on `<html>` or any existing element — confirmed no existing view's layout metrics change.

**Token loading**
- Every CSS custom property referenced by the imported layout primitives/operational components resolves to a real value under both `data-t="dark"` and `data-t="light"` — no `var(--x)` silently falls through to a browser default or renders unset.
- The token-bridge file only ever *aliases* existing `tool.html` tokens or defines net-new bundle-only tokens; it never redefines a token `tool.html`'s existing CSS (`tool.html:26-60`) already defines — no cascade collisions.

**Component imports**
- The bootstrap module successfully imports and instantiates, in an isolated non-shipped verification harness, at least one layout primitive (e.g. `createAppShell`) and one operational component (e.g. `createStatusChip`) with zero runtime errors.
- Every imported `.js` file resolves with HTTP 200 and `Content-Type: application/javascript` once the `STATIC_ALLOW_EXT` fix is in place — verified by direct request, not just "no console error."
- No component from the bundle is copy-pasted or re-implemented inline in `tool.html` — every component used is imported from the bundle's own files, per §7's "do not copy inline styles" constraint and the confirmed `.dc.html` independence above.

**CSP and ESM loading**
- No `Content-Security-Policy` directive is added, removed, or loosened — `script-src`/`style-src` already permit same-origin (`'self'`) loads, which is all Phase A needs.
- The new `<script type="module">` and all of its transitive `import`s load successfully under the existing CSP with zero CSP violation reports in the console.

**No secret exposure**
- The diff contains no API keys, tokens, admin secrets, or `.env`-sourced values — grep the diff for `ADMIN_TOKEN`, `BEACON_SECRET`, `INTERNAL_WORKER_SECRET`, `FIREBASE_SA_KEY_JSON`, `ADMIN_EMAILS`, `ADMIN_SECRET_KEY` and confirm zero matches.
- No new file introduces a hardcoded credential of any kind.

**Backend changes bounded to the one approved exception**
- `git diff 35652057dbc06cdea5393906fd0d4713621e39a2 -- server.js` shows exactly one changed line (the `STATIC_ALLOW_EXT` addition) and nothing else.
- Zero lines changed in `firestore-service.js`, any `lib/**` file, or `firestore.indexes.json`.

### Rollback instructions
Phase A is additive by construction, so rollback is a plain revert, not a migration:
1. `git diff 35652057dbc06cdea5393906fd0d4713621e39a2` to confirm the full change set is exactly: the two new `assets/*` files, the additive `<head>` block in `tool.html`, and the single `STATIC_ALLOW_EXT` line in `server.js`.
2. To roll back: `git checkout 35652057dbc06cdea5393906fd0d4713621e39a2 -- server.js tool.html` and delete the two new `assets/*` files (or `git clean` them if untracked). No data was written anywhere (no Firestore writes, no config changes), so there is nothing to migrate back.
3. The current UI is never removed or hidden by Phase A — it remains the only reachable UI throughout, since nothing new is mounted or linked from any view. Rollback is therefore zero-risk to users even mid-rollout: reverting the diff returns the app to byte-for-byte its current state.

---

## 1. Current live frontend architecture

The real product is **not** the design-handoff bundle and is **not** the `frontend/` Next.js app (that's a separate, unwired strangler-fig prototype — see project memory `ux-redesign-approved-direction`). The live dashboard is `tool.html`: a single ~1MB vanilla-JS file, no framework, no bundler, no client-side router.

### tool.html structure
- Root: `<html lang="ar-SA" dir="rtl" data-t="dark">` — Arabic-first, RTL by default. `data-t` toggles `dark`/`light` (a light-mode selector exists at `tool.html:3522`, `html[data-t="light"] .sb-soon{...}`), so theming is a data-attribute switch, not a separate build.
- `admin.html` is a **separate** vanilla-JS file for the internal admin panel (not the same document as `tool.html`).
- `index.html` is the public marketing landing page only — unrelated to the app.

### App-view routing
- `APP_VIEWS` (`tool.html:7455`) is a flat object mapping a view key to a DOM id:
  ```
  { overview: 'view-overview', pixels: 'view-pixels', gtmview: 'view-gtmview',
    managedserver: 'view-managedserver', projects: 'view-projects',
    versions: 'view-versions', deployments: 'view-deployments',
    health: 'view-health', audit: 'view-audit' }
  ```
- `switchAppView(viewKey, btnEl)` (`tool.html:7498-7553`) hides every view (`Object.values(APP_VIEWS).forEach(...classList.remove('active'))`) and shows the target by adding `.active`. It also updates the sidebar's active button, and runs a per-view side effect inline (`if (viewKey === 'health') loadHealthView();` etc., `tool.html:7519-7552`).
- There is **no URL/history sync** — switching views does not change the address bar, and there is no deep-link into a specific record (a "click a row → open a detail view" always happens via an in-memory drawer, never a route).
- `managedserver` is the only view with a hard functional gate (`SS_TRACKING_LOCKED` → shows a "coming soon" modal instead of switching, `tool.html:7499-7503`). Every other view, including the four "Operations Console" views below, switches unconditionally.

### Sidebar / navigation
- `<aside id="et-sidebar">` (`tool.html:4448`) → `<nav class="sb-nav">` containing `.sb-link` buttons, each `onclick="switchAppView('key', this)"` (`tool.html:4462-4510`).
- A `<div class="sb-nav-section">Operations</div>` (`tool.html:4485`) visually groups Versions / Deployments / Health / Audit under an "Operations" heading.
- **Important finding:** the `<span class="sb-soon">Soon</span>` badge on Versions/Deployments/Health/Audit (`tool.html:4489,4494,4499,4504`) is **purely cosmetic CSS** (`tool.html:2970`) — it does not gate the click handler. These four views are fully wired and reachable by any logged-in user today; they just render an empty/failed state for non-admins (see §1 Authentication below and §2).
- Exact markup for one nav item (template to copy for a future "Events" entry):
  ```html
  <button class="sb-link" id="sbHealth" type="button" onclick="switchAppView('health',this)">
    <span class="material-symbols-outlined" style="font-size:18px;">monitor_heart</span>
    <span>Health</span>
    <span class="sb-soon">Soon</span>
  </button>
  ```

### Detail / drawer pattern
The closest existing analog to "Event Details" is the row → drawer pattern used by the three Operations Console tables:
- `showDeploymentDetails(r)` (`tool.html:7973-8000`) — builds a small HTML timeline string client-side (stage pills: building → importing → publishing → published, or a failed state) plus a `<pre>` dump of the full row JSON, then sets `drawer.style.display = 'flex'`.
- `showAuditDetail(e)` (`tool.html:8152-8158`) and `showVersionDetails(v)` (`tool.html:7852-7860`) — even simpler: `content.textContent = JSON.stringify(row, null, 2)`, then show the drawer.
- **Data source for the drawer is always the row object already in memory** (passed inline as `onclick="showX(${JSON.stringify(row)})"` — see `tool.html:7834,7958,8122`), never a fresh fetch on open. No focus trap, no Escape-to-close, no history entry observed in any of the three.
- This is the pattern an "Event Details" experience should follow if it stays inside `tool.html`: no separate route, a drawer populated from data already fetched for the Explorer's table row.

### State management
No central store. Ad hoc module-level `var`s hold each view's last-fetched data and paging cursors: `currentUser` (`tool.html:15618`, set at `tool.html:16672` inside `onAuthStateChanged`), `_versionsData`, `_deploymentsData`, `_auditData` / `_auditBefore` / `_auditPage` (`tool.html:7886,8071-8073`), `_cachedGtmStr` for the GTM view. Every view re-fetches from scratch each time `switchAppView` selects it — there is no shared cache or invalidation logic beyond these globals.

### Data-fetching conventions
All four Operations Console views funnel through one helper:
```js
async function _opsFetch(url) {
  var tok = await firebase.auth().currentUser.getIdToken();
  var r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
```
(`tool.html:7595-7600`). Mutations (e.g. `opsRollback`, `tool.html:7862-7880`) build the same bearer-token fetch manually. Loading/empty/error states are handled per-view: a `#xLoading` element toggles visibility, and a caught error writes `'Failed to load: ' + e.message` into the empty-state element's last `<span>`. There is no polling — data is fetched once per view-open, on demand.

### Authentication handling
- Client: Firebase Auth JS SDK. `auth.onAuthStateChanged(...)` (`tool.html:15767`) populates `currentUser` (`tool.html:16672`). Every authenticated call gets a **fresh** ID token via `firebase.auth().currentUser.getIdToken()` — no manual refresh/caching logic in `tool.html`.
- Server: **two distinct authorization tiers exist**, and they matter a great deal for this feature (see §2 and §6):
  1. **Per-owner tier** (`/api/ss/*` and similar) — verifies the Firebase ID token server-side (`firestoreService.verifyIdToken`, wraps `firebase-admin.auth().verifyIdToken()`) and uses `decoded.uid` as the canonical `clientId` (`server.js:3408-3454`). One Firebase user = one store; no team/agency multi-user model exists anywhere in the codebase.
  2. **Admin-only tier** (`_requireAdmin()`, `server.js:2470-2527`) — accepts *any one* of: an HttpOnly admin session cookie (`et_admin_session`, secret-key login), a legacy `ADMIN_TOKEN` bearer secret (constant-time compared), or a Firebase ID token whose decoded claims satisfy `decoded.admin === true || decoded.role === 'admin'` or whose email is in the `ADMIN_EMAILS` env allowlist.
  3. **The four Operations Console endpoints — `/api/versions/:clientId`, `/api/deployments/:clientId`, `/api/audit/:clientId`, `/api/health/:clientId` — are all gated by `_requireAdmin()`, not the per-owner tier** (`server.js:2739,3065,3148,3220`). A regular logged-in store owner calling `_opsFetch` from their own session gets `401 Unauthorized` unless their account is also an admin. This is why these views are labeled "Soon" — the sidebar entries and JS are live, but the data layer behind them is effectively an internal admin panel bolted onto the customer-facing shell, not a customer-usable feature yet.

### Existing "Health" view (closest analog to tracking-health/event data)
`loadHealthView()` (`tool.html:8006-8065`) calls `_opsFetch('/api/health/' + cid)` and renders, per comments in the code itself:
- `trackingHealthScore` (0-100) → banded label Healthy (≥80) / Degraded (≥50) / Critical, colored accordingly.
- Four boolean platform flags (`ga4`, `meta`, `googleAds`, `tiktok`) → "✓ Active" / "Not configured" text only — no per-platform metrics.
- `lastEventReceived` → rendered only as a relative "time ago" string (`_opsTimeAgo`). **`hcLastEventName` is hardcoded to `'—'`** (`tool.html:8042`) because the API has no event-name field to put there — this is explicit, present-tense proof that no event identity reaches this view today.
- `driftDetected`, `alerts[]`, `stuckDeployments` count.
This confirms the Health view is a **single aggregate document per store**, not an event-level table.

---

## 2. Current backend capabilities

### Endpoint inventory (event/health/deployment/container/destination-relevant)

| Method & path | Auth | Backing collection(s) | Notes |
|---|---|---|---|
| `GET /api/versions/:clientId` | `_requireAdmin()` | `container_versions` | `server.js:2706-2764`. Hardcoded ≤50 records, no pagination. |
| `POST /api/versions/rollback` | `_requireAdmin()` | `container_versions`, `deployment_logs` | `server.js:2766-2861+`. Full state machine (lock → pre-flight → drift check → build → import → publish → audit). |
| `GET /api/deployments/:clientId` | `_requireAdmin()` | `deployment_logs` + `container_versions` (joined client-side) | `server.js:3004-3112`. |
| `GET /api/audit/:clientId` | `_requireAdmin()` | `audit_logs` | `server.js:3114-3177`. Cursor pagination via `?before=<ISO>&limit=` (max 200). IP purged after 90 days at read time. |
| `GET /api/health/:clientId` | `_requireAdmin()` | `diagnostic_results` + `client_health_cache` + `container_versions` + `platform_health` + active-deployment count | `server.js:3179-3290`. Fully documented response shape in the source comment — reproduced below. |
| `GET /api/v1/internal/beacon` | HMAC (`BEACON_SECRET`) or per-client API key | writes `event_type_last_seen` | `server.js:4262-4361`. "Presence ping" only — see below. |
| `POST /api/v1/internal/dlq` | HMAC (`BEACON_SECRET`) or `INTERNAL_WORKER_SECRET` | writes `dlq_events` | `server.js:4168-4260`. Richest per-event shape that exists anywhere — see below. **No corresponding GET route exists.** |
| `GET /api/v1/clients/:id/profile` (via `lib/profile-service.js getBundle`) | per-owner (`decoded.uid`) | `clients`, `ss_configs`, `managed_containers`, `client_health_cache`, `platform_health` | `lib/profile-service.js:9-99`. `tracking.containers[].platforms[]` / `.events[]` is the closest thing to a per-store "destination catalog" — configuration, not delivery telemetry. |

`GET /api/health/:clientId` exact response shape (from the source's own doc-comment, `server.js:3184-3217`):
```json
{
  "ok": true, "clientId": "uid_abc123",
  "trackingHealthScore": 75,
  "ga4": true, "meta": false, "googleAds": true, "tiktok": false,
  "lastEventReceived": "2026-06-30T10:00:00.000Z",
  "lastPublish": "2026-06-30T10:00:00.000Z", "lastVersion": 12,
  "driftDetected": false, "activeDeployment": false, "stuckDeployments": 0,
  "lastRecovery": null, "platformHealth": {},
  "alerts": [{ "message": "1 deployment(s) currently active", "severity": "info" }],
  "computedAt": null
}
```

### Firestore collections actually used in this repo (grepped, not inferred)
`managed_containers`, `clients`, `ss_configs`, `provisioning_jobs`, `provision_audit`, `audit_logs`, `activity_timeline`, `client_health_cache`, `platform_health`, `event_type_last_seen`, `diagnostic_results`, `health_job_lock`, `dlq_events`, `deployment_locks`, `deployment_logs`, `version_counters`, `container_versions`, `managed_servers`, `managed_deployments`, `managed_routes`, `api_keys`.

Note two separately-maintained audit collections exist: `provision_audit` (`AUDIT_COLLECTION`, `firestore-service.js:570`, provisioning-specific, never pruned) and `audit_logs` (used by `GET /api/audit/:clientId`, general admin actions, IP purged at 90 days). They are not the same collection — worth resolving/consolidating before building a third "reveal audit" trail on top.

### `lib/timeline-service.js` (full file read)
Exports one function, `record({clientId, eventType, actorType, actorId, summary, meta, isMilestone, dedupeKey})`, which writes to `activity_timeline` with a 1-hour dedupe window keyed on `(clientId, eventType, dedupeKey)`. This is a **milestone/activity log** (e.g. "deployment succeeded"), not a tracked-pixel event trace. It has no concept of destination, payload, or delivery response code.

### `event_type_last_seen` — the closest thing to "event tracking" that exists
- Doc ID: `` `${clientId}_${eventName}` ``. Written exclusively by `GET /api/v1/internal/beacon` (`firestore-service.js:836-849`, `server.js:4358`).
- Only 8 hardcoded event names are recognized (`BEACON_EVENTS`, `firestore-service.js:874-877`): `page_view, view_item, add_to_cart, begin_checkout, purchase, generate_lead, sign_up, search`.
- Document shape: `{ clientId, eventName, lastSeenAt }` — **no payload, no destination, no delivery status, no per-instance id.** It is a debounced (one write per 5-minute bucket per event type, `server.js:4346-4355`) presence flag, nothing more.

### `dlq_events` — the only near-miss on a real per-event record, and its gaps
- Written by `POST /api/v1/internal/dlq`, called by the sGTM server-container template's `_fireDLQ()` **only when a CAPI send fails** (`server.js:4168-4258`). Document shape actually written (`server.js:4235-4251`):
  ```js
  { eventId, eventName, eventChecksum, platform /* = destination */, destination_url,
    payload_snapshot, headers_snapshot, customerId /* shopper id, not store id */,
    sessionId, anonymousId, errorCode, errorMessage, payloadSize, schemaVersion,
    status: 'pending', retryCount: 0, nextRetryAt, createdAt, updatedAt,
    expiresAt /* now + 72h, firestore-service.js:952-971 */ }
  ```
- **This is the only place in the entire backend where a payload snapshot and a destination response/error code are ever persisted for an individual event** — but only for failures, only for 72 hours, and:
  - **There is no `clientId`/store field in this schema.** `customerId`/`sessionId`/`anonymousId` are shopper-side identifiers for CAPI match quality, not tenant attribution. As written today, a `dlq_events` document cannot be attributed to a specific EasyTrac store without an additional correlation step.
  - **There is no read endpoint.** `listPendingDlqEvents()` is consumed only by the internal retry worker (`lib/dlq-worker.js`, referenced `server.js:160-170,5050-5056`); the only externally-visible signal is `getDlqStats()` → `{ depth, oldestAgeMs }`, an aggregate queue-depth metric exposed through a Prometheus-style metrics route (`server.js:4134-4160`), not individual records.
  - Successful sends produce **no record at all** — this is intentional (avoids storing payload/PII-adjacent data at rest for the common case).

### Does Event Details data exist anywhere today?
**No.** There is no collection, service, or endpoint that stores a persistent, store-attributed, per-event record with a trace of steps, a destination response code, and a payload — for either successful or failed events. The nearest asset (`dlq_events`) is failure-only, 72-hour TTL, write-only, and missing the store-attribution field a per-store UI would need.

### Where real events actually happen
Per project memory (`architecture-node-is-provisioner`), this Node app is a **provisioner**, not an event processor — actual event firing, evaluation, and delivery happen inside the **deployed sGTM (server-side Google Tag Manager) containers on Cloud Run**, generated by `lib/gtm-config-builder.js`. This Node backend/Firestore layer only receives what those containers deliberately choose to report back (the beacon ping and the DLQ failure report). Any richer Event Details data must originate from new instrumentation inside the generated container template, not from data this backend already has lying around.

---

## 3. Required data contract — Events Explorer

Per the approved screen specification, minimum fields and this app's vocabulary mapping:

| Field | Definition in EasyTrac's data model |
|---|---|
| event id | Unique id per fired event instance (sGTM `event_id`, seen today only inside `dlq_events.eventId`). |
| event name | e.g. `purchase`, `add_to_cart` — matches the `event_type_last_seen`/`BEACON_EVENTS` vocabulary and `containers[].events[]` config. |
| store id | `clientId` (Firebase `uid`) — the existing tenant key used everywhere else in the codebase. |
| destination | Platform an event was sent to: `ga4` / `meta` / `googleAds` / `tiktok` (matches `containers[].platforms[]` and `dlq_events.platform`). |
| state | Delivery outcome for one event→destination pair (e.g. Healthy/Error per the design system's 5-class `statusMap`). |
| received timestamp | When the sGTM container accepted the event. |
| processed timestamp | When the container finished tag evaluation/mapping. |
| delivered timestamp | When (if) the destination API accepted the request. |
| validation result | Whether required fields (e.g. hashed email for Meta CAPI) were present — the `errorCode`/`errorMessage` pair in `dlq_events` is the only existing analog, and only for failures. |
| volume | Count of instances of this event/destination pair in a time window — requires aggregation over per-event records that don't exist yet. |
| expected volume | A baseline/forecast to compare volume against — does not exist anywhere; would be a new derived metric. |
| last seen | Directly available today: `event_type_last_seen.lastSeenAt`, but only for the 8 hardcoded `BEACON_EVENTS` and without a destination dimension. |
| quality flags | e.g. missing-field warnings, drift, auth errors — closest existing signal is `diagnostic_results.alerts`/`issues` (store-level, not per-event). |

---

## 4. Required data contract — Event Details

| Field | Definition / existing analog |
|---|---|
| breadcrumb context | store → Events → event name — purely presentational, no new data needed once store/event identity is known. |
| event status | Same 5-class state as Explorer, for one specific event instance. |
| EventTrace steps | An ordered sequence (received → processed → sent → destination response) with a status per step — **does not exist as a stored structure anywhere**; would need to be assembled from new instrumentation (see §8). |
| timestamps | received/processed/delivered per step, as above. |
| destination response code | Only ever captured today for **failures**, in `dlq_events.errorCode`/`errorMessage`. No response code is captured for successful deliveries anywhere. |
| normalized payload fields | Field-by-field breakdown of what was sent (order_id, value, currency, etc.) — only ever captured for failures, in `dlq_events.payload_snapshot` (an unstructured string, not normalized). |
| masked sensitive values | See §6 — **there is no raw or hashed PII value stored server-side to mask/reveal.** Hashing happens client-side in the generated GTM web-container JS (`lib/gtm-config-builder.js`) at pixel-fire time and is never transmitted to or stored by this backend (proven by `tests/pii-hashing.test.js`). |
| related events | Other events in the same order/session — would require a `sessionId`/order correlation query over a per-event store that doesn't exist yet. `dlq_events.sessionId`/`anonymousId` show the correlation *fields* exist in spirit, but only for failures. |
| retention availability | Whether the underlying record is still queryable (vs. expired) — directly modeled today only by `dlq_events.expiresAt` (72h TTL); no other collection in this area has event-level retention semantics to reuse as-is. |

---

## 5. Source-of-truth analysis

**Legend:** ✅ already available · 🟡 derivable from existing data (with caveats) · 🔧 requires backend implementation · ⛔ unavailable / blocked

### Events Explorer
| Field | Status | Note |
|---|---|---|
| event id | ⛔ | Only exists transiently inside `dlq_events` (failures, 72h). |
| event name | 🟡 | `event_type_last_seen`/container config give the *name*, not per-instance rows. |
| store id | ✅ | `clientId`/`decoded.uid` — foundational to the whole app. |
| destination | 🟡 | `containers[].platforms[]` gives the *configured* set, not per-event delivery. |
| state | ⛔ | No per-event/destination delivery outcome is stored for successes. |
| received timestamp | ⛔ | Not captured except implicitly inside a `dlq_events` failure doc. |
| processed timestamp | ⛔ | Not captured anywhere. |
| delivered timestamp | ⛔ | Not captured anywhere. |
| validation result | ⛔ | Only `errorCode`/`errorMessage` on failures. |
| volume | 🔧 | Needs an aggregation layer over per-event records that don't exist yet. |
| expected volume | 🔧 | Net-new derived/forecast metric; no existing baseline. |
| last seen | ✅ | `event_type_last_seen.lastSeenAt`, but only 8 hardcoded event names, no destination dimension. |
| quality flags | 🟡 | `diagnostic_results.alerts`/`issues` exist at store granularity, not per-event. |

### Event Details
| Field | Status | Note |
|---|---|---|
| breadcrumb context | ✅ | Presentational only. |
| event status | ⛔ | See Explorer's `state`. |
| EventTrace steps | ⛔ | No stored step sequence anywhere. |
| timestamps | ⛔ | See above. |
| destination response code | 🟡/⛔ | 🟡 for failures via `dlq_events.errorCode`; ⛔ for successes. |
| normalized payload fields | 🟡/⛔ | 🟡 unstructured `payload_snapshot` on failures only; ⛔ structured fields, ⛔ for successes. |
| masked sensitive values | ⛔ | No raw/hashed PII is stored server-side at all — see §6. |
| related events | 🔧 | Correlation fields exist in spirit (`sessionId`) but only inside failure records. |
| retention availability | 🟡 | Only `dlq_events.expiresAt` models this today, and only for failures. |

**Bottom line:** essentially every field that makes Events Explorer/Event Details actually useful (state, timestlines, response codes, payload, volume) is 🔧 or ⛔ today. The one exception with real signal — `dlq_events` — is scoped to failures only, has no store-attribution field, and has no read API.

---

## 6. Privacy and security constraints

- **PII hashing is client-side and pre-transmission, by design.** `lib/gtm-config-builder.js` generates a web-container JS variable (`pii_hashed`) that SHA-256-hashes email/phone/name/address fields **in the shopper's browser**, before anything reaches sGTM or this backend. `tests/pii-hashing.test.js` (338 lines) is a full regression suite proving no plaintext PII reaches any CAPI tag or pixel snippet, for every supported storefront platform (Salla pre-hashed passthrough, Zid/generic hash-on-the-fly, double-hash prevention, Unicode normalization, etc.).
- **Direct consequence for "masked sensitive values" / reveal UI:** there is no raw PII, and no stored hash, anywhere in this backend to mask or reveal. The mockup's "Reveal" interaction assumes a masked value sitting server-side — that assumption does not hold in this codebase's actual data flow. Building a real reveal feature would mean **introducing PII storage that does not exist today**, which cuts directly against the app's current zero-PII-at-rest posture and would need an explicit, deliberate product/compliance decision — not just a UI feature.
- **`tests/capi-json-safety.test.js`** guards a different but adjacent concern: JSON-injection safety in the native HTTP Request CAPI tag bodies (a hostile product-name value could previously break/inject sibling JSON keys). It confirms the team already treats "what gets serialized and sent" as a tested contract — any new payload-snapshot-to-UI path should get the same discipline.
- **Secret exclusion:** `dlq_events.headers_snapshot`/`payload_snapshot` are raw, unredacted strings captured by the sGTM template at failure time. Nothing today redacts CAPI tokens or other secrets that could appear in headers — because nothing today reads this collection outside the internal retry worker. Any future read path (UI or API) needs an explicit allowlist/redaction pass before these fields are ever rendered.
- **Role-based reveal permissions:** no team/agency/multi-user role model exists anywhere in the codebase. The only two tiers are per-owner (`decoded.uid === clientId`, `server.js:3408-3454`) and admin (`_requireAdmin()`, four separate credential paths, `server.js:2470-2527`). A "reveal" permission has nowhere to attach except one of these two existing tiers, or requires designing a new tier from scratch.
- **Audit logging for sensitive-field reveal:** two audit collections already exist — `provision_audit` (provisioning-specific, never pruned) and `audit_logs` (general admin actions, diff-only, HMAC-hashed actor, IP purged after 90 days, `firestore-service.js:706-747`). The `audit_logs` schema (`{occurredAt, actorType, actorId, action, entityType, entityId, diff, ipAddress}`) is structurally reusable for a `event.payload_field.revealed` action — but nothing writes that action today, and the dual-collection naming should be reconciled before adding a third audit surface on top.
- **Retention:** `dlq_events` has an explicit 72-hour TTL (`expiresAt` field, `firestore-service.js:956,968`) — the only precedent for event-level retention in this codebase. `audit_logs` keeps the record forever but purges only the `ipAddress` field after 90 days. No collection models "keep raw event data for N days then delete" at the volume an Events Explorer would need — this has to be designed, not reused.

---

## 7. Recommended frontend integration architecture

*(Design-only — no sidebar/route changes are being made now, per explicit instruction. This section describes what "later" should look like.)*

- **Route structure:** `tool.html` has no client-side router and no other view establishes deep-linking — do not invent one for Events. Follow the existing model: a new `APP_VIEWS.events → 'view-events'` entry for the Explorer, and an **in-memory drawer** (matching `showDeploymentDetails`/`showAuditDetail`) for Event Details rather than a second full view. This matches every existing "list → detail" pattern in the app and avoids introducing history/URL behavior nothing else in `tool.html` has.
- **View registration:** add one entry to the `APP_VIEWS` map (`tool.html:7455`) and one `.app-view#view-events` block, following the exact structure every other Operations Console view already uses.
- **Navigation changes:** a single new `.sb-link` button under the existing `<div class="sb-nav-section">Operations</div>` group, identical markup to the Health/Audit buttons already there. (Not being added in this pass, per instruction — this is the eventual two-line change.)
- **Adapter layer (needed, non-trivial):** `tool.html`'s own CSS tokens (`--bg`, `--sur`/`--sur2`/`--sur3`, `--acc`, `--wht`/`--wht2`, `--mut`/`--mut2`, `--grn`/`--red`/`--blu`/`--amber`, `--bdr`/`--bdr2`, defined `tool.html:26-60`) are a **completely different vocabulary** from the design bundle's tokens (`--surface-canvas/1/2/3`, `--text-primary/secondary/tertiary`, `--status-*-fg/bg/border`, etc.). They do not overlap by name and are not interchangeable by accident. Recommend a small, one-directional **token-bridge stylesheet** (e.g. `--surface-canvas: var(--bg); --text-primary: var(--wht); --status-critical-fg: var(--red); ...`) scoped under a wrapper class (e.g. `.et-design-system-scope`) so the bundle's existing component CSS resolves correctly against `tool.html`'s palette without hand-retranspiling every inline style in the bundle.
- **Component import strategy:** the design bundle is plain ESM (`export function createX(...)`, see [`index.js`](<../../EasyTrac Tracking Command Center/design_handoff_easytrac_design_system/index.js>)) and needs no bundler — its own README documents loading it via `<script type="module">`. Import only what's needed (`createEventDetails`, `createStatusChip`, `createBreadcrumbs`, `createEventTrace`) directly from the pattern/component files, and mount into a plain container `<div>` inside the new view/drawer — the same "build a DOM subtree programmatically" style `tool.html` already uses elsewhere (e.g. `renderGtmSidebarView`).
- **Do not copy the bundle's inline styles into `tool.html`.** The bundle is deliberately self-contained (component code + component-scoped CSS + tokens, three-layer architecture documented in its own README) specifically so it can be swapped/updated as a unit. Transcribing its inline styles into `tool.html`'s stylesheet would silently fork the two and defeat that design.

---

## 8. Recommended backend architecture

*(Required — no event-level data exists today per §2/§5.)*

- **Ingestion/storage boundary.** Real events are only observable **inside the deployed sGTM Cloud Run container** — this Node app never sees them directly (see §2, "Where real events actually happen"). Two realistic sources:
  1. **Extend the container template** (`lib/gtm-config-builder.js`) with a new logging tag that fires on every processed event (success and failure), posting a compact record to a new internal endpoint — this directly mirrors the already-shipped, already-tested `_fireDLQ()` → `POST /api/v1/internal/dlq` pattern (same HMAC/internal-secret trust boundary, same team-familiar shape).
  2. **Tail Cloud Run / Google Tag Manager's own request logs** via Cloud Logging exports — avoids touching the shipped container template, but loses response-code/validation semantics that only the container itself can observe at evaluation time, and adds a new infra dependency (log sink, export job).
  **Recommend option 1** — it reuses a pattern this team has already designed, built, and load-tested (the DLQ path), and is the only source with response codes and validation detail.
- **Proposed service layer.** New `lib/event-log-service.js`, mirroring the existing `lib/timeline-service.js` / `lib/dlq-worker.js` conventions (thin wrapper functions over `firestore-service.js`, dedupe-aware writes).
- **Proposed storage.** A new Firestore collection (working name `event_log`) whose schema **must include `clientId` from day one** — the exact field `dlq_events` is missing today, which is precisely why that collection can't back a per-store UI as-is. Minimum fields: `clientId, eventId, eventName, destination, state, receivedAt, processedAt, deliveredAt, validationResult, responseCode, payloadSnapshot(redacted)`.
- **Proposed endpoints:** `GET /api/events/:clientId` (list, filtered/paginated) and `GET /api/events/:clientId/:eventId` (single record + trace) — reuse the existing `_opsFetch`-compatible bearer-token convention. **Auth tier must be decided explicitly, not defaulted:** the four existing Operations Console endpoints this feature sits next to are all admin-gated (§1/§2), but a customer-facing Events Explorer implies the per-owner tier. These are two different security postures already in the codebase — pick one deliberately rather than copy-pasting `_requireAdmin()` out of habit.
- **Pagination:** cursor-based on `receivedAt`, matching the existing `GET /api/audit/:clientId?before=<ISO>&limit=` convention already proven in this codebase (`server.js:3146-3177`) — consistency over novelty.
- **Filtering / time-range queries:** each filter combination the Explorer's UI needs (destination, state, eventName, time range) is a **new Firestore composite index** (repo already manages these via `firestore.indexes.json` at the repo root — confirmed present). Composite indexes aren't free: each one takes build time to provision and adds to index-count overhead. Scope the initial filter surface deliberately (e.g. `(clientId, receivedAt)`, `(clientId, destination, receivedAt)`, `(clientId, state, receivedAt)`) rather than "every column sortable/filterable."
- **Retention.** Recommend a short hot window (7-14 days) with a Firestore TTL policy, following the `dlq_events.expiresAt` precedent (`firestore-service.js:956,968`) — not indefinite storage. If longer retention is a real product requirement, treat it as a BigQuery/export decision, not a Firestore one.
- **Estimated operational cost and risk — the load-bearing open question for this whole feature:** every design decision the codebase has made so far in this area actively **avoids** per-event writes: `event_type_last_seen` debounces to one write per 5-minute bucket per event type (`server.js:4346-4355`), and `dlq_events` only writes on failure. A naive "log every event" design inverts that cost model entirely — for a store with meaningful traffic (thousands of events/day across multiple destinations), Firestore per-document write costs scale directly with that traffic. **This needs an explicit product decision before backend work starts:** log everything (cost/volume risk), log failures + a bounded sample of successes (matches existing DLQ precedent), or keep it aggregate-with-drill-down (cheapest, weakest fidelity). This is not resolvable by engineering choice alone.
- **Risk to existing systems.** Any change to `lib/gtm-config-builder.js` touches the exact GTM-generation system the project's constraints require to keep working unmodified for existing customers. A new logging tag must be strictly additive/opt-in, and — given this codebase's own precedent (`tests/pii-hashing.test.js`, `tests/capi-json-safety.test.js`) — should ship with an equivalent regression suite proving it doesn't leak PII or break CAPI body serialization, before it reaches any real container.

---

## 9. Phased implementation plan

**Phase A — Shared design-system integration.** ✅ Approved, independent of Events. Full execution spec (exact files, acceptance criteria) lives in the standalone "Phase A — Approved Execution Spec" section at the top of this document — read that section, not this summary, before implementing. In short: wire the design-handoff bundle into `tool.html` as a loadable, ESM asset with a token-bridge stylesheet. No new views, no new data, no dependency on Phases B-E or on §8's backend work ever happening. Purely plumbing — verifiable by rendering an isolated demo mount point with static/sample data, discarded before merge (as already done during design-pattern review).

**Phase B — Events Explorer using real supported data.**
Per §5, a *literal* Events Explorer (row-per-instance, volume/expected-volume/quality-flags) is blocked until Phase-8-equivalent backend work exists. What **can** ship now, honestly, is a narrower view built only from ✅/🟡 fields: configured event-name × destination catalog (`containers[].events[]`/`platforms[]`) cross-referenced with `event_type_last_seen.lastSeenAt` and store-level `diagnostic_results`/`client_health_cache` alerts. This is closer to "tracking coverage" than "Events Explorer" as specified, and should be presented to the user as such rather than silently under-delivering the approved spec.

**Phase C — Event Details using real event records.**
Blocked entirely until backend ingestion (§8) ships. No per-event record with a trace, response code, and payload exists today outside the 72-hour, store-unattributed `dlq_events` failure window.

**Phase D — Sensitive-field reveal and audit.**
Needs re-scoping per §6: there is no raw or hashed PII stored server-side to reveal. Recommend narrowing this phase to "payload field visibility" for genuinely non-PII fields (order_id, value, currency, event name) rather than a PII-reveal feature, unless a deliberate, separately-approved decision is made to start storing PII-adjacent data (which contradicts the app's current design posture).

**Phase E — QA and rollout.**
Standard: regression tests alongside the existing `tests/*.test.js` suite, staged rollout behind the existing admin-allowlist/preview mechanisms already used elsewhere in the codebase (e.g. `isPreviewAllowed` per project memory), existing UI (no Events entry) remains the default until verified.

---

## 10. Exact files expected to change per phase

| Phase | Files |
|---|---|
| A | See the standalone "Phase A — Approved Execution Spec" section at the top of this document for the authoritative file list. Summary: adds `assets/design-system-token-bridge.css` + `assets/design-system-bootstrap.js`; modifies only `tool.html`'s `<head>` (new `<link>`/`<script type="module">` tags, no view/sidebar changes); zero `server.js`/`firestore-service.js`/`lib/**` changes. |
| B (available-data subset) | `tool.html` (new `#view-events` block, `APP_VIEWS` entry, sidebar button — **explicitly deferred, not part of this brief's actions**). Possibly `server.js` (new lightweight GET aggregation route if existing `/api/health` + container config need reshaping) + `firestore-service.js` (new query fn) — scope TBD pending product sign-off on Phase B's narrowed data set. |
| C | New: `lib/event-log-service.js`. Changed: `lib/gtm-config-builder.js` (new logging tag, additive/opt-in), `firestore-service.js` (new `event_log` CRUD + query fns), `server.js` (new ingest endpoint mirroring `/api/v1/internal/dlq`, new read endpoints), `firestore.indexes.json` (new composite indexes), `tool.html` (Event Details drawer wiring). New test file(s) under `tests/` mirroring `pii-hashing.test.js`/`capi-json-safety.test.js` discipline for the new logging tag. |
| D | `firestore-service.js` (new audit-write helper for reveal actions, or reuse `audit_logs` writer), `server.js` (permission check + audit write wherever a sensitive field would be exposed), a written policy decision (not code) on whether PII-adjacent storage is acceptable at all. |
| E | New/updated files under `tests/`, a staged-rollout status doc following the existing `docs/TRIAL-FEATURE-STATUS.md` convention. No deploy config changes required beyond what each phase already lists. |

---

## 11. Acceptance criteria per phase

**Phase A**
Full acceptance criteria (build integrity, no route regressions, no auth regressions, dark/light theme, RTL/LTR, token loading, component imports, no secret exposure, no backend changes) are defined in the standalone "Phase A — Approved Execution Spec" section at the top of this document — that section is authoritative. Summary: design bundle loads in `tool.html` via `<script type="module">` with zero console errors; token-bridge resolves every referenced token under both themes; no existing view's layout/styling/behavior changes; no new sidebar entry, no new route, no `server.js` changes.

**Phase B**
- The shipped view is explicitly scoped and labeled to match what §5 marks ✅/🟡 only — no fabricated volume/expected-volume/quality-flag values anywhere in the UI.
- Every value rendered traces to a real API response field (spot-checked against the endpoint's documented shape in this brief).
- Admin-vs-owner auth tier decision from §8 is made and enforced consistently (no endpoint accidentally admin-gated while the UI assumes owner access, or vice versa).

**Phase C**
- Event Details renders only for events that have a real backing record from the new `event_log` collection — no client-side synthesis of missing trace steps.
- New ingestion path has an automated regression test proving no PII leak and no JSON-injection risk in the logged payload snapshot, matching the rigor of `tests/pii-hashing.test.js`/`tests/capi-json-safety.test.js`.
- New Firestore indexes are present in `firestore.indexes.json` and deployed before the read endpoints go live.
- Retention/TTL is active on `event_log` from day one (not added after the fact).

**Phase D**
- No field is ever revealed without a corresponding audit-log write recording who revealed what, when.
- Reveal permission is enforced server-side (not merely hidden client-side).
- Product/compliance sign-off exists in writing before any PII-adjacent field is persisted, if that path is chosen at all.

**Phase E**
- Existing UI remains the default entry point; the new Events flow is reachable only via the same preview/allowlist mechanism already used for other in-progress features.
- Full existing test suite (`tests/*.test.js`) still passes unmodified.

---

## 12. Rollback plan

- **Phase A** is purely additive to `tool.html`'s `<head>` plus new standalone files — rollback is reverting that diff / deleting the new files. No data, no migrations, nothing to unwind.
- **Phase B (available-data subset)** — if a lightweight aggregation endpoint is added, rollback is deleting the route handler and the sidebar/view addition; no destructive Firestore changes are proposed at this phase.
- **Phase C** — the new `event_log` collection is additive and TTL-bound (§8), so worst case is disabling the new ingestion tag in the sGTM container template (re-publish, using the existing, already-built `/api/versions/rollback` machinery to fall back to the prior container version) and leaving the collection to self-expire via TTL — no manual data cleanup required. Read endpoints and the drawer UI can be removed independently of the ingestion tag.
- **Phase D** — disable the reveal UI/permission check; the audit trail it wrote remains (audit logs are intentionally append-only/non-destructive) and simply stops growing.
- **General:** per the stated constraints, none of this work touches or risks existing authentication, GTM generation, provisioning, admin, billing, or deployment behavior — every proposed change is additive (new files, new collections, new routes) rather than a modification of an existing code path, which is what makes each phase independently revertible.

---

## Summary

**What already exists:** a fully-built, coherent Operations Console pattern in `tool.html` (routing, sidebar, drawer, admin-gated fetch helper) that an Events feature can slot into structurally; an aggregate per-store health signal (`/api/health`); a debounced per-event-**type** last-seen timestamp (`event_type_last_seen`); a genuinely useful but narrow failure-only per-event record with a payload snapshot and response code (`dlq_events`, no store attribution, no read API, 72h TTL); a mature, tested PII-hashing and CAPI-safety discipline (`tests/pii-hashing.test.js`, `tests/capi-json-safety.test.js`) that any new event-payload surface must match; and now a complete, framework-agnostic implementation of the approved Event Details screen sitting in the design-handoff bundle, ready to be wired in once real data exists.

**What is missing:** any persistent, store-attributed, per-event-instance record for successful events — which is most of what both approved screens actually need (state, timestamps, response codes, payload, volume, related events). The one close call (`dlq_events`) is failure-only and missing the tenant key. There is no raw or hashed PII stored server-side anywhere to back a "reveal" interaction. There is no customer-facing (non-admin) precedent for this class of endpoint — the four Operations Console routes it most resembles are all admin-only today.

**Can frontend implementation begin safely?** Yes, but only Phase A (design-system plumbing) and a narrowed, honestly-labeled Phase B (tracking-coverage view built from fields that are already ✅/🟡) — not the full Events Explorer/Event Details screens as specified, without misrepresenting fabricated data as real.

**Is backend work required first?** Yes, for Phase C (Event Details) entirely, and for any Phase B field beyond the narrowed subset above. The critical open item is not a coding task but a product decision: what volume of real event data this system is willing to persist and pay for (§8's cost/risk note) — that decision gates the backend design, not the other way around.
