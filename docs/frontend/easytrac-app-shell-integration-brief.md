# EasyTrac App Shell Integration Brief — Phase B1

**Status:** **Approved**, with four additional acceptance requirements layered on top of the original 18 sections (§19 below). Implementation is now authorized against this document as amended.
**Baseline commit:** `fe21275cc540489611013330f032fb98359c72af` (Phase A + legacy asset-path fix, committed locally, unpushed).
**Method:** direct, line-by-line inspection of the live `tool.html` in its current state on top of the baseline commit. Every claim below cites a `tool.html:<line>` location against that state.
**Scope of this document:** the App Shell only — outer chrome (shell container, sidebar shell, main workspace, shared page container, toolbar/header region, store-switcher shell), responsive/RTL/theme/density behavior. It does not cover Dashboard content, Tracking Health content, Events (any of it), or any backend/auth/billing/provisioning/admin surface — all explicitly out of scope per the request that produced this brief.

---

## 19. Approved amendment: four additional acceptance requirements

**Read this section alongside §5-§8, §6, §15, and §17 — it makes those requirements stricter, not different.** These four requirements were added at approval time, on top of the original 18-section brief. Where a requirement below overlaps an earlier section, this section is the authoritative, more specific version.

### 19a. Zero CSS leakage
- **No broad selectors.** Every rule in `assets/app-shell-token-bridge.css` (and any further shell-chrome CSS Phase B1 adds) must be qualified under one single root selector — the mount point, e.g. `#appShellV2Root .some-class { … }` — never a bare element selector (`div`, `button`, `nav`, `aside`), never `*`, never an unqualified class that could exist elsewhere in `tool.html`'s ~20,000 lines.
- **No global overrides.** The new CSS must never redefine a selector `tool.html` already owns — `.main`, `.sb-link`, `.app-view`, `#et-sidebar`, `#userBar`, `.sb-nav-section`, etc. are off-limits for *new* rules, full stop, regardless of specificity or `!important`. This extends §6's collision analysis from "here's the risk" to "here's the hard rule that prevents it."
- **Only scoped AppShell styles.** The only permitted unscoped additions are new custom-property *declarations* on `:root` or `[data-t]` (i.e. new tokens, following the exact pattern Phase A's `assets/design-system-token-bridge.css` already established) — never new *rules* that select existing elements outside the mount point.
- **Verification method:** grep the new CSS file for any selector that does not start with the mount-point selector (or `:root`/`[data-t]` for token-only declarations) — zero matches required. Additionally, with the flag OFF, confirm via `getComputedStyle` spot-checks that no existing shell element's computed style differs from the pre-B1 baseline (this is the CSS-leakage equivalent of Phase A's "flag off must be provably inert" test).

### 19b. Idempotent runtime adapter
`assets/app-shell-bootstrap.js`'s init function must be safe to invoke more than once in the same page lifetime (e.g. a stray second `<script>` evaluation, a defensive re-invocation from a debug console, or a future refactor that accidentally calls init twice) without any of the following happening on the second call:
- **No duplicated DOM.** The very first action inside init, before any other DOM read/write, must be a guard check (e.g. `if (window.__etShellV2 && window.__etShellV2.initialized) return;`) — mirroring the flag-check-first pattern already established for the feature flag itself in §7. Reparenting must never clone `#et-sidebar`/`.main`'s children; a second init call must detect the nodes are already inside the new mount point and either no-op or safely re-run without creating siblings/duplicates.
- **No duplicated listeners.** Any *new* listener the bootstrap itself attaches (not the pre-existing `onclick` attributes on reparented nodes, which travel with the nodes unchanged and are never re-attached) must be added exactly once, guarded by the same sentinel — never via a pattern that re-adds on every init call.
- **No duplicated observers.** If responsive behavior requires a `ResizeObserver`/`MutationObserver`/`IntersectionObserver`, exactly one instance may exist for the lifetime of the page. A second init call must either detect and reuse the existing observer or explicitly `disconnect()` the prior one before creating a new one — never accumulate observers.
- **Verification method:** call the bootstrap's init function (or reload with the flag on twice, or invoke it a second time from the console) and confirm: DOM node count for the shell region is unchanged between one call and two; `getEventListeners()` (Chrome DevTools) or an equivalent listener-count check on the mount point shows no growth; no console warnings/errors on the second call.

### 19c. Runtime rollback
- **The feature-flag rollback path (§7-§8) must be verified, not just designed.** "Verified" means: with the flag on and the new shell mounted, remove the flag and confirm the *original* shell is restored — with the exact same DOM node identities for `#et-sidebar` and every `#view-X`, not visually-similar replacements.
- **Reload is required and that is the documented, approved rollback path — no live/no-reload in-session rollback is being built in this phase.** Attempting to write a reverse-reparenting function that undoes the DOM move live, in-session, without a reload, is explicitly **not required** and should not be attempted unless it comes with its own equivalent verification — the reload-based path is strictly simpler to verify correct and matches the "no data was written anywhere, so a reload is always safe" principle already established for Phase A's own rollback instructions (§17). This must be stated plainly in whatever developer-facing note ships with the flag: *rollback requires a page reload after clearing the flag.*
- **Verification method:** the same DOM-identity check specified in §16 ("capture node references before flag-on init, confirm identity after") extended to a second phase — capture references again *after* clearing the flag and reloading, confirm they resolve to the same IDs with the same content, and confirm no `et_shell_v2`-related state (DOM nodes, listeners, observers, `window.__etShellV2*` globals) survives the reload.

### 19d. Performance budget
Three metrics, each compared flag-ON vs. flag-OFF on the same route, same machine, same number of samples, with regression capped at **under 5%** for each:

| Metric | What it measures here | Measurement method |
|---|---|---|
| **FCP** (First Contentful Paint) | Time to the first visible shell content (sidebar or toolbar) painting | `performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint').startTime`, read once per fresh page load. |
| **CLS** (Cumulative Layout Shift) | Whether the reparenting operation (§5, §15) causes a visible layout jump | `PerformanceObserver({type:'layout-shift'})`, summing `.value` for entries where `!entry.hadRecentInput`, over a fixed settle window (3s after load) — this is exactly the risk §15 already flags ("old shell flashes, then gets replaced"), now with a hard number attached instead of a qualitative warning. |
| **INP** (Interaction to Next Paint) | Responsiveness of the new shell's interactive elements (sidebar links, theme toggle) after mount | `PerformanceObserver({type:'event'})` reading `.duration` on a dispatched click against a representative shell control (e.g. a `.sb-link`), repeated across multiple samples, worst-case taken per INP's own definition. |

- **Baseline (flag OFF) must be measured fresh, not assumed from before Phase B1 existed** — the comparison is against *this* commit's flag-off state, since that's the actual rollback target, not an abstract "the app used to be fast" claim.
- **5% regression ceiling applies per-metric**, not as an averaged/blended number — a large CLS regression cannot be offset by a fast FCP.
- If any metric cannot be reliably automated in this environment (INP in particular is the hardest to script without a real user), the brief requires an explicit, documented best-effort approximation (as specified above) rather than skipping the metric — "we didn't measure it" is not an acceptable substitute for "we measured it this way, with these caveats."

---

## 1. Current shell DOM map

`tool.html`'s `<body>` is not a single shell — it is **five independent top-level regions**, only one of which (`.app`) contains the sidebar+view system most people think of as "the app." All five sit as direct siblings of each other in `<body>`, in this order:

```
<body>
  <div id="userBar">                     tool.html:3691   — EXISTING top toolbar/header
    .ub-left  (logo, hidden nav, hidden project counter)
    .ub-right (plan badge, username, admin link, THEME TOGGLE, profile/history button)
  </div>

  <div id="dashPanel">…</div>            tool.html:3731   — legacy "My Projects" slide-in panel
  <div id="dashOverlay"></div>           tool.html:3767   — scrim for dashPanel
  <div id="historyOverlay"></div>        tool.html:3770   — scrim for historyPanel
  <div id="historyPanel">…</div>         tool.html:3773   — "Activity Log" slide-in panel
  <div id="limitBanner">…</div>          tool.html:3791   — plan-limit upsell banner

  <div class="app">                      tool.html:3798   — THE region most work targets
    <div id="gate">…</div>                         tool.html:4098  — login/signup gate
    <div id="settingsPanel">…</div>                tool.html:4280  — account-settings slide-in drawer
    <div id="settingsOverlay"></div>               tool.html:4351  — scrim for settingsPanel
    <div id="ssSoonModal">…</div>                  tool.html:4356  — "Managed sGTM coming soon" modal
    <div id="mixpanelSoonModal">…</div>            tool.html:4406  — "Mixpanel coming soon" modal

    <aside id="et-sidebar">                        tool.html:4448  — THE SIDEBAR
      <div class="sb-project">…</div>                        — account identity block (icon, sbUserName, sbUserPlan)
      <nav class="sb-nav">                                   tool.html:4462
        9× <button class="sb-link" id="sbX" onclick="switchAppView('x',this)">
        1× <div class="sb-nav-section">Operations</div>      — groups Versions/Deployments/Health/Audit
        1× <button class="sb-link" onclick="toggleSettings()">  — Settings
      </nav>
      <div class="sb-footer">…</div>                         — New Tracking Pixel, CMS guide links, Log Out
    </aside>

    <div class="main">                             tool.html:4552  — THE MAIN WORKSPACE
      9× <div class="app-view" id="view-X">…</div>            — see §2 for the full list
    </div>
  </div>

  <style>…more CSS…</style>              tool.html:6085  — sits AFTER .app closes, still inside <body>
  <script>…all app JS…</script>                    — thousands of lines, ends near EOF
  <link rel="stylesheet" href="/easytrack-design-system.css"/>   tool.html:19858 (fixed in the baseline commit)
</body>
```

Key structural facts that constrain any shell work:
- **There is no single "app shell" element today.** `#userBar` (toolbar) and `.app` (sidebar+workspace) are *siblings in `<body>`*, not parent/child. A new `AppShell` wrapper that expects to own both the toolbar and the sidebar+main must either physically reparent both regions or visually compose them without assuming they're already nested.
- **`.app` closes at `tool.html:6082`**, immediately after the last `.app-view` (`view-audit`). Everything from `tool.html:6085` onward — thousands of lines of `<style>` and `<script>` — is a sibling of `.app`, not inside it. A shell wrapper inserted around `.app`'s children must not disturb this boundary.
- **The sidebar is a fixed-position element anchored to the physical right edge** (`#et-sidebar { position:fixed; top:0; right:0; left:auto; width:256px; height:100vh; }`, `tool.html:2891-2906`), and `.main` is pushed away from it via `margin-right:256px !important` (`tool.html:3174-3179`, itself one of three overlapping `.main` rule blocks — see §6). This right-anchoring is *because* the page is RTL by default, not an independent choice — see §12.

---

## 2. Current route/view map

Two interlocking systems exist. Both must keep working unchanged.

### 2a. `APP_VIEWS` — the view registry (`tool.html:7455`, confirmed unchanged since prior review)
```
{ overview: 'view-overview', pixels: 'view-pixels', gtmview: 'view-gtmview',
  managedserver: 'view-managedserver', projects: 'view-projects',
  versions: 'view-versions', deployments: 'view-deployments',
  health: 'view-health', audit: 'view-audit' }
```
`switchAppView(viewKey, btnEl)` (`tool.html:7509`) hides every `.app-view`, shows the target, and updates `.sb-link.active` state. No URL awareness at this layer.

### 2b. `ETRouter` — the URL layer wrapped around it (`tool.html:15994-16132`, newly discovered in this pass — **not documented in the prior Events integration brief**, which only inspected `switchAppView` in isolation)
This is a self-invoking function that runs *after* the raw functions are defined and **monkey-patches** `window.switchAppView`, `window.switchGateTab`, `window.toggleSettings`, and `window.enterTool` to add `history.pushState`/`replaceState` synchronization, while calling through to the original implementations it captured at `tool.html:16014-16017`. It is the actual source of truth for which URL shows which view:

| URL | Guard | Resolves to |
|---|---|---|
| `/sign-in` | guest-only | gate, login tab |
| `/register` | guest-only | gate, signup tab |
| `/dashboard` | auth required | `view-overview` |
| `/tool` | auth required | `view-pixels` |
| `/account` | auth required | `view-overview` + settings panel open |
| `/settings` | auth required | `view-overview` + settings panel open |
| `/pricing` | public | `view-overview` |

`VIEW_BTN` (`tool.html:16005-16009`) maps view keys back to sidebar button IDs (`sbOverview`, `sbPixels`, `sbGtm`, `sbProjects`, `sbVersions`, `sbDeployments`, `sbHealth`, `sbAudit`) so programmatic navigation still updates `.sb-link.active` correctly. `apply()` (`tool.html:16057`) is the reconciliation function, invoked on `popstate` (`tool.html:16129`) and once after auth resolves (`tool.html:15784`, `tool.html:16125`).

**Implication for Phase B1:** any new shell scaffold must not assume `switchAppView` is "the" navigation function — by the time the page has finished loading, `window.switchAppView` **is the `ETRouter` wrapper**, not the original. Calling the wrong one (e.g. if new code captures a reference to `switchAppView` early) will silently break URL sync.

---

## 3. Current selector and event-handler dependencies

Every one of these must resolve to the *same node* (or the same global function) after Phase B1, whether the flag is on or off.

**Global functions invoked via inline `onclick` on shell-region elements:**
`switchAppView`, `toggleSettings`, `toggleDashboard`, `toggleHistory`, `toggleTheme`, `startNewProject`, `showCmsGuide('salla'|'zid')`, `logout`, `showSsSoonModal`/`closeSsSoonModal`, `closeMixpanelSoonModal`.

**IDs read/written by JS (non-exhaustive; shell-relevant subset):**
`et-sidebar`, `sbOverview`, `sbPixels`, `sbGtm`, `sbManagedServer`, `sbProjects`, `sbVersions`, `sbDeployments`, `sbHealth`, `sbAudit`, `sbUserName`, `sbUserPlan` (`tool.html:16712-16713`), `gate`, `gform-pending`, `gtab-login`, `gtab-signup`, `settingsPanel`, `settingsOverlay`, `settingsName`, `settingsEmail`, `settingsPhone`, `settingsCms`, `settingsPlanBadge`, `userPlanBadge`, `userName`, `adminLink`, `ubProfileInitial`, `projCounter`, `projUsed`, `projMax`, `dashPanel`, `dashOverlay`, `historyPanel`, `historyOverlay`, `historyBody`, `historyEmpty`, `historyList`, `limitBanner`, `limitMsg`, `ssSoonModal`, `mixpanelSoonModal`.

**Classes with CSS *and* JS meaning (changing these breaks behavior, not just style):**
- `.sb-link` / `.sb-link.active` — `switchAppView` and `ETRouter` both toggle `.active`; `document.querySelectorAll('#et-sidebar .sb-link')` (`tool.html:7527`) is scoped *through* the `#et-sidebar` ID specifically.
- `.app-view` / `.app-view.active` — `ETRouter.toggleSettings` wrapper reads `document.querySelector('.app-view.active')` (`tool.html:16118`) to decide which URL to restore when Settings closes.
- `.sb-locked`, `.sb-soon`, `.sb-soon-premium` — cosmetic-only today (confirmed in the prior Events brief: no JS reads these to gate clicks), but still visible UI contract.
- `.sb-nav-section` — visual grouping label only, no JS dependency found.

**State globals the shell region's own code reads:** `window.currentUser`, `SS_TRACKING_LOCKED`, `_busy` (router re-entrancy guard, module-private inside the `ETRouter` closure — cannot be touched from outside at all).

---

## 4. Exact DOM boundaries to wrap or migrate

| Region | Boundary | In Phase B1 scope? |
|---|---|---|
| `#userBar` | `tool.html:3691-3727` | **Yes** — "Toolbar/header region." This already exists and is live (real CSS, not hidden — `tool.html:19794`, `#userBar{background:rgba(10,10,10,.88);…}`). Phase B1 wraps/restyles it; does not replace its logic. |
| `#et-sidebar` (chrome only, not nav item logic) | `tool.html:4448-4549` | **Yes** — "Sidebar shell." The frame/positioning/responsive behavior, not a reimplementation of the 9 nav buttons via the bundle's own item-rendering API (see §Recommendation in the closing summary — reusing the bundle's `createSidebar(items, …)` would mean re-authoring `onclick`/`id` wiring per item, directly risking §3's contract). |
| `.main` (chrome only) | `tool.html:4552, 6081` | **Yes** — "Main workspace" / "Shared page container." The 9 `.app-view` children keep their exact IDs and content; only the outer positioning/width/responsive frame changes. |
| Store switcher | **No live equivalent exists.** `.sb-project` (`tool.html` inside `#et-sidebar`, just an icon + `sbUserName`/`sbUserPlan` text) is an identity display, not a switcher — confirmed in the prior integration research: this app is single-store-per-account (`decoded.uid === clientId`), so there is nothing to switch *between* today. | **Yes, but as a shell only** — the bundle's `StoreSwitcher.js` component can be mounted showing the current (only) store, non-functionally, as pure chrome. No multi-store logic exists to wire it to. |
| `#gate`, `#settingsPanel`/`#settingsOverlay`, `#ssSoonModal`, `#mixpanelSoonModal` | `tool.html:4098-4448` | **No** — these are content/overlay systems, not shell chrome. Must remain physically and behaviorally untouched; they sit *inside* `.app` alongside the sidebar and main, so the shell wrapper must not disturb their sibling position or `z-index` stacking (`settingsPanel`/`settingsOverlay` at `z-index:150`, `ssSoonModal`/`mixpanelSoonModal` at `z-index:400`, sidebar at `z-index:100`). |
| `#dashPanel`, `#dashOverlay`, `#historyPanel`, `#historyOverlay`, `#limitBanner` | `tool.html:3731-3796` | **No** — these sit *outside* `.app` entirely, as siblings of `#userBar`. Out of scope; not touched by shell work at all. |
| Individual `.app-view` **contents** (Overview welcome header, Pixel Config form, GTM view, Health/Audit/Versions/Deployments tables, etc.) | inside each `#view-X` | **No** — explicitly excluded ("Dashboard content migration," "Tracking Health content," etc.). Only the *outer* `.main` frame these sit inside is in scope. |

---

## 5. Exact files Codex may modify (proposed — not yet approved for execution)

Following the same pattern as Phase A (additive, flagged, reversible):

| File | Proposed change |
|---|---|
| `assets/app-shell-bootstrap.js` (new) | ESM module. Imports `createAppShell`, `createSidebar` *(chrome only — see §4)*, `createPage`, `createPanel`, `createSection`, `createToolbar`, `createStoreSwitcher` from the committed bundle. Contains the feature-flag check (§7) and, only when the flag is on, the DOM-reparenting logic that moves the existing `#et-sidebar` and `.main` nodes (not copies — the same nodes, via `appendChild`, so every ID/class/handler travels with them unchanged) into the new chrome. Init must be idempotency-guarded per §19b — the flag check and the duplicate-init guard are two separate checks, both required. |
| `assets/app-shell-token-bridge.css` (new) | Additional token aliases beyond Phase A's bridge, specific to shell-only tokens (`--sidebar-width`, `--sidebar-bg`, etc.) mapped against `tool.html`'s existing `#et-sidebar`/`.main` values, so the new chrome inherits the *current* visual values rather than the bundle's defaults (236px vs. today's 256px, for example — a decision to make explicitly during implementation, not silently). |
| `tool.html` | Additive only: one more `<script type="module">` tag loading the new bootstrap module, and the minimum markup change required to give the bootstrap script a mount point (e.g. one new empty `<div id="appShellV2Root"></div>` placed as a sibling of `.app`, left empty and inert when the flag is off). **No existing line — sidebar markup, `.main`, `#userBar`, any view, any script — is edited or removed.** |

No `server.js`, `firestore-service.js`, `lib/**`, or backend file is touched by Phase B1 under any circumstance — it is a pure client-side, flagged, additive change, consistent with the "no backend changes" posture already established in Phase A.

---

## 6. CSS collision risks

**§19a (Zero CSS leakage) is the binding acceptance requirement for everything below** — the risks here are the *why*, §19a is the *hard rule*.

- **`.main` is defined three separate times** in `tool.html` (`:448` loose defaults, `:3174` with `!important` overrides that actually win, `:19804` a narrower `max-width` override) — this file already has accumulated, overlapping, specificity-fighting rules for the exact element Phase B1 needs to restyle. Any new rule targeting `.main` must be checked against **all three**, not just the one that looks authoritative.
- **`#et-sidebar` width mismatch:** live value is `256px` (`tool.html:2896`); the design-system bundle's own component-token default is `236px` (`--sidebar-width: 236px`, from the bundle's `tokens/component-tokens.css`, committed at baseline). If the new chrome uses the bundle's default token unmodified, the sidebar visually resizes — a real, easy-to-miss regression. Must be explicitly aliased in the new token bridge (§5) to `256px`, or the width difference must be a deliberate, reviewed decision.
- **Existing `et-` prefixed classes already live in `tool.html`:** `.et-logo-svg` (`tool.html:3694,4103,4462`) and `.et-theme-btn` (`tool.html:3714`). Neither collides by exact name with anything in the committed bundle (verified: the bundle has no `.et-logo-svg` or `.et-theme-btn`), but it confirms the app already uses the same `et-` prefix family the bundle uses for everything (`.et-sidebar`, `.et-appshell`, `.et-btn`, `.et-panel`, `.et-table`, `.et-page`, `.et-section`, …). **No current collision exists**, but this is a live risk class for any future addition on either side that doesn't check the other first.
- **ID vs. class name confusion, not a real CSS collision but a real *cognitive* risk:** the live sidebar is `<aside id="et-sidebar">` (an ID); the bundle's `Sidebar.js` factory produces an element with `className = 'et-sidebar'` (a class). They do not collide in CSS specificity terms (different selector types), but they are easy to conflate when reading code or debugging — the integration must never apply the bundle's `.et-sidebar` class to the *existing* `#et-sidebar` element, or vice versa, since the bundle's `.et-sidebar` rule (`width:var(--sidebar-width); background:var(--sidebar-bg); …`) and the live `#et-sidebar` rule (`width:256px; position:fixed; right:0; …`) would then compete on the same element with unpredictable winner (depends on source order and specificity, not a designed outcome).
- **Cascade order is currently favorable:** Phase A's `<link>` tags for the bundle's CSS were inserted near the *top* of `<head>` (`tool.html:23-33` region), before `tool.html`'s own large inline `<style>` block. Because later rules win on equal specificity, `tool.html`'s own shell CSS already "wins" over the bundle's by source order today — this must be preserved (i.e., any new shell-specific stylesheet added in Phase B1 should load *after* the bundle's own CSS, same as Phase A did) rather than accidentally reordered.

---

## 7. Rollback flag design

**Recommendation: a `localStorage`-backed flag, checked once at page load, with no server dependency (consistent with "no backend changes").**

```
Flag name:    et_shell_v2
Values:       'on' | absent (anything other than the literal string 'on' = off)
Default:      absent → OFF → current production shell renders exactly as today, byte-for-byte
Read by:      assets/app-shell-bootstrap.js, once, before any DOM mutation
Written by:   nothing in production yet — set manually via browser devtools/console during
              internal review (localStorage.setItem('et_shell_v2','on')), or via a query-string
              activation path for reviewers who can't/shouldn't use devtools — see §8.
```

Why `localStorage` over a query param, a cookie, or a server flag:
- **No backend dependency** — satisfies the explicit constraint that Phase B1 makes zero backend changes.
- **No risk of a stray `?shell=v2` link leaking the unreviewed shell to a real user** — `localStorage` doesn't travel via shared/bookmarked/forwarded URLs.
- **Persists per-browser across reloads for a reviewer**, without needing to re-add a query param on every navigation (important given `ETRouter` performs `pushState`/`replaceState` — a query param would need explicit preservation logic across every route change, which is itself new surface area to get wrong).

The check must be a hard gate at the very top of the bootstrap module: if the flag is not exactly `'on'`, the module does nothing further — no DOM reads, no DOM writes, no event listeners attached. This makes "OFF" mean *zero behavioral difference from Phase A's committed state*, not just "visually looks the same."

---

## 8. Feature-flag default and activation path

- **Default (all real users, indefinitely until explicitly changed):** OFF. Current shell renders. This is not a temporary state that expires — it stays OFF until a separate, explicit decision turns it on for real traffic.
- **Activation for review:** two supported paths, both opt-in and non-persistent-by-default:
  1. Browser console: `localStorage.setItem('et_shell_v2','on')` then reload. Reversible via `localStorage.removeItem('et_shell_v2')`.
  2. A reviewer-only query-string bridge: `?shell=v2` on first load sets the `localStorage` flag (one-time, so subsequent navigations via `ETRouter`'s `pushState` don't need to carry the param) and then the bootstrap module strips it from the visible URL via `history.replaceState` so it doesn't get bookmarked/shared as if it were a real route. This must **not** be added to `APP_ROUTES` (`server.js:322`) or `ETRouter.ROUTES` (`tool.html:15996`) — it is a client-side-only bridge, not a route.
- **No admin-panel toggle, no server-side allowlist (e.g. `ADMIN_EMAILS`-style gate) is proposed for Phase B1** — deliberately, to keep this a zero-backend-touch change. If broader internal (non-devtools-comfortable) reviewer access becomes necessary, that is a separate, explicit follow-up decision, not assumed here.
- **Promotion path (turning the default ON for real users) is explicitly out of scope for this brief and for Phase B1 itself** — it requires its own review/approval once the flagged-on shell has been validated, per the request that produced this document ("until the new shell passes review").

---

## 9. Desktop acceptance criteria

- All 9 `#view-X` panels render identically (pixel-for-pixel, same content, same interactive elements) whether reached via the old shell (flag off) or the new shell (flag on) — only the surrounding chrome differs.
- Sidebar remains reachable and every `.sb-link` click still calls `switchAppView`/`ETRouter` correctly, verified for all 9 view keys plus Settings.
- `#userBar`'s theme toggle, profile/history button, and plan badge remain functional and visible inside the new toolbar chrome.
- No layout shift/overlap between the new shell chrome and the pre-existing overlay systems (`#gate`, `#settingsPanel`, `#ssSoonModal`, `#mixpanelSoonModal`, `#dashPanel`, `#historyPanel`, `#limitBanner`) at any viewport ≥1280px.
- Visual diff against the flag-off baseline shows *zero* pixel difference (flag off must be provably inert, not just "looks the same").

## 10. Tablet acceptance criteria

- **Baseline fact to preserve, not fix:** below 900px, the *current* shell hides `#et-sidebar` entirely (`tool.html:3182-3191`, `@media(max-width:900px){ #et-sidebar{display:none;} }`) with **no alternative navigation of any kind** — no hamburger, no bottom bar, nothing (confirmed by exhaustive search: zero matches for any toggle/hamburger/mobile-nav function anywhere in `tool.html`). Users below 900px today are simply stuck on whichever view loaded.
- Phase B1's new shell, when flagged on, may introduce responsive navigation for the first time (the bundle's own `Sidebar.js` header block documents "Replaced by bottom tab bar below 768px" as an intended pattern) — but this is **new capability, not a preservation requirement**, and must be explicitly called out as such during review rather than assumed to be "just a wrap of what's there."
- If responsive nav is introduced in B1: verify every one of the 9 view-switch actions and the Settings toggle remain reachable at tablet widths (768-900px) through whatever new control replaces the hidden sidebar.
- Flag-off state must reproduce the current (sidebar-vanishes, no replacement) behavior exactly — this is the safe fallback, and it must stay reproducible even though it's arguably a pre-existing gap.

## 11. Mobile acceptance criteria

- Same baseline fact as tablet: nothing to preserve below 900px because nothing exists today. Below ~640px additional content-reflow rules exist (`tool.html:1551,1561,1570,1587,1834`) but none of them touch shell/navigation — they reflow *content inside* individual views.
- If B1 introduces mobile nav (flag on): verify touch-target sizing, no horizontal scroll introduced at 375px width, and that the density token (`tokens/density.css`, committed) is *not* silently defaulted to a cramped mode that hurts tap-target size on touch devices — density and viewport width are orthogonal concerns and must not be conflated.
- Flag-off state: reproduce the current no-nav-below-900px behavior exactly.

## 12. RTL/LTR acceptance criteria

- `<html lang="ar" dir="rtl" data-t="dark">` (`tool.html:2`) is the real, current, unconditional default — not a mode toggle. There is no LTR mode anywhere in the live app except the two explicitly `dir="ltr"`-scoped exceptions: `#view-managedserver` (`tool.html:4752`) and the two "coming soon" modals (`ssSoonModal`, `mixpanelSoonModal`, both `dir="ltr"`).
- The sidebar's physical right-edge anchoring (`right:0; left:auto`) is *a consequence of* RTL, not an independent layout choice — confirm the new shell's RTL-aware chrome (documented per-component in the bundle's own header blocks) mirrors correctly to also anchor right under `dir="rtl"`, and left under a hypothetical `dir="ltr"` — even though LTR is not used at the document root today, the two existing `dir="ltr"`-scoped regions prove the app already has to cope with mixed direction in the same page, so the new shell chrome must not assume `dir="rtl"` is document-wide.
- No dynamic direction-flipping exists anywhere in the current app (confirmed: the only `setAttribute('dir', …)` call in the entire file is unrelated, on a diagnostic-output `<div>` at `tool.html:14657`, set to `'auto'`). The new shell does not need to support a live RTL/LTR toggle — only correct static rendering under the app's existing fixed `dir="rtl"`.

## 13. Keyboard and focus-order acceptance criteria

- **Baseline fact:** the current shell has almost no keyboard-specific handling. The only keyboard interaction found anywhere near shell-adjacent UI is a single global `Escape` handler (`tool.html:7506`) that closes `ssSoonModal`/`mixpanelSoonModal` — nothing else. `#settingsPanel`, `#dashPanel`, `#historyPanel` have **no** Escape-to-close, no focus trap, no return-focus-to-trigger behavior today.
- Phase B1 must not *regress* the one existing Escape handler.
- Phase B1 is not required to retrofit focus-trap/Escape/return-focus behavior onto `#settingsPanel`/`#dashPanel`/`#historyPanel` (they're out of scope — §4), but if the new sidebar/toolbar chrome introduces any new interactive controls (e.g., a mobile nav toggle), those new controls must have a sane tab order and visible focus state — the bundle's own components already document keyboard contracts per-component (e.g. Sidebar.js: "Arrow keys move focus (roving tabindex)") and that documented behavior should be honored for any *new* control introduced, without being asked to retrofit it onto old ones.

## 14. Accessibility requirements

- Preserve the current `aria-label`/`role` usage that already exists on shell-adjacent elements (e.g. `role="dialog" aria-modal="true"` on `ssSoonModal`/`mixpanelSoonModal`, `aria-label` on the theme toggle button) — none of this is currently comprehensive, but none of it should be removed or weakened.
- The design-system bundle's own components document accessibility contracts per-component (StatusChip: "Always renders icon dot + text label, never color alone"; Sidebar: "current item `aria-current=page`"; Breadcrumbs: "`aria-label=Breadcrumb`") — where B1 uses these components for shell chrome, their documented contracts should be honored, not stripped for convenience.
- No WCAG audit of the *existing* app is in scope for B1 — only "don't make shell-adjacent accessibility worse than it is today, and honor the bundle's own documented contracts for whatever chrome is newly introduced."

## 15. Performance requirements

- Flag OFF: zero additional network requests, zero additional DOM nodes, zero additional JS execution beyond the flag check itself (a single `localStorage.getItem` read) — this must be measurable, not just visually indistinguishable.
- Flag ON: the reparenting operation (moving `#et-sidebar` and `.main`'s children into the new chrome) must happen before first paint of the shell region or use a no-flash technique (e.g. an inline pre-paint class), to avoid a visible "old shell flashes, then gets replaced" jump — this is a real risk given the reparent happens via a `<script type="module">`, which is deferred by spec and therefore runs *after* initial HTML parse.
- No new render-blocking resource — the bundle's CSS is already loaded via Phase A; no new synchronous script should be added.
- **§19d (Performance budget) is the binding, numeric version of this section** — FCP/INP/CLS, measured flag-on vs. flag-off, regression capped under 5% per metric.

## 16. Test commands

Following the same verification discipline used for Phase A and its correction:
```bash
node --check server.js
node --input-type=module --check < assets/app-shell-bootstrap.js
node --test tests/*.test.js
```
Plus, specifically for this phase (none of these exist yet — to be written alongside implementation, not retrofitted after):
- A live-server verification pass (as done for Phase A) hitting `/`, `/dashboard`, `/dashboard/`, `/settings`, `/settings/`, `/tool`, `/tool/`, `/sign-in/`, `/register/` with the flag both on and off, checking console errors and confirming all 9 `#view-X` panels are still reachable via the sidebar under both states.
- A DOM-identity check: capture `document.getElementById('et-sidebar')` and each `#view-X` node reference *before* the flag-on bootstrap runs, and confirm the *same* node references (not equal-but-different clones) are still in the document afterward — this is the concrete, automatable proof that "preserve every existing DOM anchor" actually held, not just "looks the same."
- The idempotency check specified in §19b (init twice, confirm no DOM/listener/observer duplication) is now a required test, not optional.

## 17. Rollback instructions

Identical philosophy to Phase A, extended for the flag. **§19c (Runtime rollback) is the binding, verified version of this section — reload is required and must be documented as such, not assumed.**
1. **Immediate, zero-deploy rollback (flag already shipped):** nothing to do — default is OFF. If a reviewer's browser has the flag on, `localStorage.removeItem('et_shell_v2')` and reload.
2. **Full code rollback:** `git diff fe21275cc540489611013330f032fb98359c72af -- tool.html assets/` and revert — the change is additive-only (new files, one new empty mount-point div, one new script tag), so `git checkout fe21275cc540489611013330f032fb98359c72af -- tool.html` plus deleting the two new `assets/*` files fully reverts, exactly as documented for Phase A.
3. No data, no Firestore, no server state is ever touched by this phase, so there is nothing to migrate back regardless of which rollback path is used.

## 18. Explicit non-goals

- Not migrating any view's content (Overview, Pixel Config, GTM Container, Managed sGTM, My Projects, Versions, Deployments, Health, Audit) to the new design system — only the frame those views sit inside.
- Not building a functional store switcher — no multi-store data model exists to switch between (§4); the store-switcher shell is chrome-only, showing the current single store.
- Not adding Events navigation, Events Explorer, or Event Details — per the standing decision that those remain blocked on the separate Event Observability backend work.
- Not touching `server.js`, `firestore-service.js`, `lib/**`, `admin.html`, or any auth/billing/provisioning code path.
- Not fixing the pre-existing "no mobile navigation below 900px" gap as a *requirement* — it may be improved as a side effect of introducing responsive shell chrome, but is not a scope commitment of this phase, and the flag-off path must reproduce the current gap exactly regardless.
- Not retrofitting focus-trap/Escape/keyboard behavior onto `#settingsPanel`, `#dashPanel`, or `#historyPanel` — out of scope (§4), not part of the shell.
- Not turning the feature flag's default ON for real users — that is a distinct, later, separately-approved decision.
