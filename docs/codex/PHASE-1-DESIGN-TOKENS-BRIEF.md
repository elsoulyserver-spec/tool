# Codex Brief — Phase 1: Design Tokens & Foundations

> **Role:** You are the Implementation Engineer. Implement **only** what this brief specifies. Do not change architecture, invent flows, rename tokens, or touch anything outside the Allowed Files. If something is ambiguous, stop and ask — do not improvise.
>
> **Launch safety (hard rules):** `NEXT_UI_ENABLED=false` stays false. No push. No deploy. Do not touch frozen production or pre-existing WIP. No app pages/components in this phase. No fake data.

---

## 1. Objective
Create a **self-contained design-token layer** for the EasyTrac Next.js frontend that encodes the approved **Design System v2** as CSS custom properties, wire it globally, and make it RTL- and reduced-motion-safe. Tokens only — **no components, no pages.** The contract must be migratable later into the root token package **without renaming any public token**.

## 2. Source of truth
- `docs/EASYTRAC-DESIGN-SYSTEM.html` (v2) — the approved visual identity.
- This brief — the exact token names and values (authoritative for Phase 1).
- **Do not redesign.** Do not copy Stape visually. Do not invent values not listed here.

## 3. Allowed files (the ONLY files you may create/edit)
1. **CREATE** `frontend/styles/tokens.css` — the token layer + base element styles + reduced-motion handling.
2. **EDIT** `frontend/app/layout.tsx` — add exactly one import: `import '../styles/tokens.css'` placed **before** the existing `import './p0.css'`. No other change.
3. **(OPTIONAL) EDIT** `frontend/app/p0.css` — **prefer NOT editing it; wire `tokens.css` without touching `p0.css`.** Only if strictly necessary, replace existing hardcoded **color values** with equivalent `var(--et-*)` references (mapping in §6.9). Change **colors only** — do **not** change layout, spacing, typography sizes, borders, component structure, responsive behavior, or animations, and do not rename variables or change selectors.
4. **CREATE** `tests/tokens-contract.test.js` — a Node test asserting the required tokens + exact brand/state hex values exist in `tokens.css`.

Nothing else. If a change seems to require another file, **stop and report**.

## 4. Forbidden files (never touch)
- **`packages/**`** — especially `packages/design-tokens/**` (untracked pre-existing WIP). Do not import, read at build time, copy, move, or depend on it in any way.
- Frozen production: `tool.html`, `server.js`, `admin.html`, `index.html`, `lib/**` (root), `lib/server-side/**`, `Dockerfile`, `.env.example`, `favicon.svg`.
- Any other untracked pre-existing WIP: `lib/providers/**`, `lib/provision/**`, `edge-router/**`, root untracked `tests/*` (the Phase-2 suite — do not modify existing ones; you may only **add** `tests/tokens-contract.test.js`), `netlify-site/**`, `marketing/**`, `scripts/**`, `firestore.indexes.json`, root logos/manifests.
- `frontend/app/fonts.ts` and any `next/font` wiring — **do not import or re-enable** (font assets are missing; would break the build). Font tokens must degrade gracefully to system fonts (see §6.3).
- Backend/API, generator, provisioning, GTM publishing, signup, payment — untouched.
- `.claude/**`, `.env`, `.env.local`, `node_modules/`, `.next/`.

## 5. Token naming contract
- Namespace **every** token `--et-*` (EasyTrac). Never redefine third-party or unprefixed globals.
- Tiers: `--et-color-*`, `--et-status-*`, `--et-font-*`, `--et-font-size-*`, `--et-font-weight-*`, `--et-line-*`, `--et-tracking-*`, `--et-space-*`, `--et-radius-*`, `--et-shadow-*`, `--et-glow-*`, `--et-z-*`, `--et-duration-*`, `--et-ease-*`, `--et-focus-ring`.
- All tokens live on `:root` in `tokens.css`. This is the **public contract** — later migration into the root package must keep these exact names. Do not rename.
- Committed to a single dark identity (DS v2). Do **not** add a light theme in this phase.

## 6. Required CSS variables (exact values)
Define all of the following on `:root` in `frontend/styles/tokens.css`.

### 6.1 Color — ground, surfaces, borders
```
--et-color-bg:             #0A0A0A;
--et-color-surface:        #101013;
--et-color-surface-2:      #161619;
--et-color-surface-3:      #1D1D21;
--et-color-border:         rgba(255,255,255,0.07);
--et-color-border-strong:  rgba(255,255,255,0.12);
```
### 6.2 Color — primary (ACTIONS ONLY)
```
--et-color-primary:          #2F6BFF;
--et-color-primary-strong:   #3D78FF;   /* hover / gradient top */
--et-color-primary-soft:     rgba(47,107,255,0.12);
--et-color-primary-line:     rgba(47,107,255,0.42);
--et-color-primary-contrast: #FFFFFF;   /* text on primary */
```
### 6.3 Typography — families (graceful system fallback; DO NOT import next/font)
```
--et-font-sans:  var(--font-ui-ar, "IBM Plex Sans Arabic"), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", Tahoma, sans-serif;
--et-font-brand: var(--font-brand-ar, "ThmanyahSans"), var(--et-font-sans);
--et-font-latin: var(--font-ui-en, "Inter"), ui-sans-serif, system-ui, sans-serif;
--et-font-mono:  var(--font-code, "JetBrains Mono"), ui-monospace, "SF Mono", Menlo, Consolas, monospace;
```
### 6.4 Text colors
```
--et-color-text:            #FFFFFF;   /* primary text */
--et-color-text-secondary:  #A1A1AA;   /* muted */
--et-color-text-tertiary:   #71717A;   /* derived — faint labels/timestamps */
```
### 6.5 State colors (SYSTEM STATE ONLY — never actions)
```
--et-color-success: #22C55E;  --et-color-success-soft: rgba(34,197,94,0.13);  --et-color-success-fg: #4ADE80;
--et-color-warning: #F59E0B;  --et-color-warning-soft: rgba(245,158,11,0.13); --et-color-warning-fg: #FBBF24;
--et-color-danger:  #EF4444;  --et-color-danger-soft:  rgba(239,68,68,0.13);  --et-color-danger-fg:  #F87171;
```
### 6.6 Semantic status aliases (composed)
```
--et-status-live:      var(--et-color-success);
--et-status-degraded:  var(--et-color-warning);
--et-status-down:      var(--et-color-danger);
--et-status-idle:      var(--et-color-text-tertiary);
--et-status-info:      var(--et-color-primary);
--et-focus-ring:       var(--et-color-primary);
```
### 6.7 Type scale, weights, line-height, tracking
```
--et-font-size-xs: 0.6875rem; --et-font-size-sm: 0.8125rem; --et-font-size-base: 0.9375rem;
--et-font-size-md: 1.0625rem; --et-font-size-lg: 1.1875rem; --et-font-size-xl: 1.375rem;
--et-font-size-2xl: 1.625rem; --et-font-size-3xl: 1.875rem; --et-font-size-4xl: 2.125rem; --et-font-size-5xl: 2.875rem;
--et-font-weight-regular: 400; --et-font-weight-medium: 500; --et-font-weight-semibold: 650; --et-font-weight-bold: 750; --et-font-weight-black: 800;
--et-line-tight: 1.05; --et-line-snug: 1.3; --et-line-normal: 1.65;
--et-tracking-tight: -0.02em; --et-tracking-tighter: -0.04em; --et-tracking-wide: 0.12em;
```
### 6.8 Spacing (8px rhythm), radius, elevation, z-index, motion
```
--et-space-0:0; --et-space-1:0.25rem; --et-space-2:0.5rem; --et-space-3:0.75rem; --et-space-4:1rem;
--et-space-5:1.25rem; --et-space-6:1.5rem; --et-space-8:2rem; --et-space-10:2.5rem; --et-space-12:3rem; --et-space-16:4rem; --et-space-20:5rem;
--et-radius-sm:12px; --et-radius-md:14px; --et-radius-lg:16px; --et-radius-pill:999px;
--et-shadow-1:0 1px 2px rgba(0,0,0,0.4);
--et-shadow-2:0 8px 30px -12px rgba(0,0,0,0.7);
--et-shadow-3:0 30px 80px -40px rgba(0,0,0,0.85);
--et-glow-primary:0 0 40px -6px rgba(47,107,255,0.45);
--et-z-base:0; --et-z-raised:10; --et-z-sticky:100; --et-z-drawer:200; --et-z-modal:300; --et-z-toast:400; --et-z-tooltip:500;
--et-duration-instant:80ms; --et-duration-quick:140ms; --et-duration-standard:200ms; --et-duration-deliberate:320ms; --et-duration-ambient:2000ms;
--et-ease-standard:cubic-bezier(0.2,0.7,0.2,1);
--et-ease-entrance:cubic-bezier(0.16,1,0.3,1);
--et-ease-exit:cubic-bezier(0.4,0,1,1);
--et-ease-ambient:cubic-bezier(0.42,0,0.58,1);
```
### 6.9 Global/base styles (KEEP EXTREMELY NARROW)
Inside `tokens.css`, the ONLY non-token global styling permitted is:
- The `:root` token declarations (§6.1–6.8).
- Default **body** background + text color (+ `font-family`), and nothing else on body:
  `body{ background:var(--et-color-bg); color:var(--et-color-text); font-family:var(--et-font-sans); }`
  Do **not** set global `font-size`, `line-height`, margins/padding, smoothing, or any reset — components apply typography via the tokens.
- A consistent visible focus ring:
  `:focus-visible{ outline:2px solid var(--et-focus-ring); outline-offset:2px; }`
- The `prefers-reduced-motion` block (§8).
- **RTL:** no directional rules are needed at token level; add a logical-property/token adjustment only if strictly required, and never physical `left`/`right`.

**Do NOT add:** a global CSS reset, `box-sizing` on `*`, any broad element selector (`*`, `html`, headings, `a`, `p`, list, form/table/button element styles), component styling, page styling, or layout rules.

**Optional `p0.css` alias (only if you choose to edit file #3 — colors only):**
`--ink→var(--et-color-bg); --panel→var(--et-color-surface); --line→var(--et-color-border); --text→var(--et-color-text); --muted→var(--et-color-text-secondary); --acc→var(--et-color-primary); --good→var(--et-color-success); --warn→var(--et-color-warning); --crit→var(--et-color-danger)`. Keep names/selectors/everything else; change only color values. **Prefer not editing `p0.css` at all.**

## 7. RTL requirements
- Tokens are direction-agnostic (correct — keep them so).
- Base styles must use **logical CSS properties** exclusively; no `left`/`right`/`margin-left`/etc.
- Do not set `direction` in `tokens.css` (the app root already sets `dir="rtl" lang="ar"`).
- Verify the base renders correctly with both `dir="rtl"` and `dir="ltr"` on `<html>`.

## 8. Reduced-motion requirements
- Add `@media (prefers-reduced-motion: reduce)` that **redefines the motion duration tokens** on `:root` to near-instant:
  `--et-duration-instant / -quick / -standard / -deliberate / -ambient: 0.001ms;`
- Do **not** add a broad `*` animation/transition reset — that is a forbidden broad selector (§6.9). Because every EasyTrac component animates via these duration tokens, redefining the tokens here disables motion without any global selector.
- No always-on animations are introduced in this phase.

## 9. Accessibility requirements
- Visible keyboard focus via `:focus-visible` (token above).
- Do not lower contrast: primary text `#FFFFFF` on `#0A0A0A`; secondary `#A1A1AA` for non-essential text only.
- State colors carry a text/foreground variant (`*-fg`) meant for text on dark — use those, not the raw state hue, for any text.
- No motion required to understand state (motion is enhancement only).

## 10. Build & test commands
```
cd frontend && npm run build          # must succeed
cd frontend && npx tsc --noEmit       # must be clean (no new errors)
node --test tests/tokens-contract.test.js   # must pass (run from repo root)
```

## 11. Acceptance criteria
- `frontend/styles/tokens.css` exists and defines **every** token in §6 with the exact values.
- `frontend/app/layout.tsx` imports `tokens.css` before `p0.css`; no other change.
- `tokens.css` global styling is limited to §6.9 — **no reset, no `box-sizing:*`, no broad element selectors**; only `:root`, `body` (bg/color/font-family), `:focus-visible`, and the reduced-motion block.
- `frontend/app/p0.css` is **unchanged** (preferred) — or, if edited, differs **only** in color values now referencing `--et-*` (names, selectors, spacing, sizes, borders, structure, responsive, animations all unchanged).
- Reduced-motion block redefines the duration tokens (§8); no `*` reset.
- All three commands in §10 pass.
- `git diff --cached` shows **only** the allowed files actually changed (2–4 of them). No `packages/**`, no frozen file, no other WIP, no `fonts.ts`/`next/font`.
- No components, no pages, no fake data.

## 12. Commit boundaries
- **One commit:** `feat(frontend): add self-contained design tokens (Phase 1)`.
- Stage the allowed files individually (2–4 files: `tokens.css`, `layout.tsx`, `tokens-contract.test.js`, and `p0.css` **only if** you edited it). `git add <file>` each. Do **not** `git add -A`/`.`.
- Run `git diff --cached --stat` and inspect the full staged diff before committing; if anything outside the Allowed Files appears, unstage and stop.
- Do not commit `node_modules`, `.next`, `.env*`, logs, or lockfiles unless explicitly required by the build (root `.gitignore` ignores `package-lock.json`; leave it).
- **No push. No deploy.** Report the commit hash and file list.

## 13. Rollback instructions
- The token layer is inert to customers (`NEXT_UI_ENABLED=false`; not deployed).
- To disable without revert: remove the `import '../styles/tokens.css'` line from `layout.tsx` (tokens stop applying). If you edited `p0.css`, also revert that edit so its variables fall back to their prior hardcoded values.
- Full rollback: `git revert <commit>` (isolated, frontend-only) or `git reset` the commit before pushing (nothing pushed).

## 14. Do NOT touch pre-existing WIP — explicit
- The root `packages/design-tokens/**` is **untracked pre-existing WIP**. Do not import it, generate from it, copy its values by reading its files, move it, commit it, or reference it in any build step. Your token values come **only** from §6 of this brief.
- Do not stage, commit, or modify any file in §4. Do not include unrelated WIP in your commit.
- If the build appears to require a forbidden or WIP file, **stop and report** rather than editing it.

---

**When done, report:** commit hash, exact files changed, output of the three §10 commands, confirmation that `git diff --cached` contained only the four Allowed Files, and confirmation that `packages/**` and all frozen/WIP files are untouched. Then stop for Claude's review.
