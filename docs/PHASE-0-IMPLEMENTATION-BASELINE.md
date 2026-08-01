# Phase 0 — Implementation Baseline, Isolation & Plan

**Owner:** Claude (Architect/Reviewer). **Status:** planning/audit only — no code, no commits, no frozen files touched.
**Locked references:** `docs/EASYTRAC-UX-REDESIGN-SPEC.html`, `docs/EASYTRAC-DESIGN-SYSTEM.html` (v2). Do not redesign.
**Launch safety:** `NEXT_UI_ENABLED=false`; migrated routes behind allowlist; Next.js is a **separate** service; legacy stays fully usable; no push/deploy.

---

## 1. Git working-tree audit

- **Branch:** `fix/sgtm-container-import` — **6 commits ahead of origin, unpushed.**
- **My commits this session (local only):**
  - `7d8f0b9` chore: disabled Next.js migration seam (PR-0)
  - `bc01e87` chore: Next.js auth preview shell (PR-1)
  - `65d9d2d` feat(billing): manual paid marker + trial metadata
  - `780a253` feat(frontend): display-only trial banner
- **Scale of uncommitted work:** `git diff --stat HEAD` = **~12,083 insertions / 3,798 deletions across 21 tracked-modified files**, PLUS dozens of untracked files. This is a very large **pre-existing** managed-sGTM / Phase-2 build sitting uncommitted, with my UX/trial work layered on top.
- **Index:** clean (nothing staged).
- **`frontend/`:** 30 files, **all tracked & committed, 0 untracked** → the one clean, isolated workspace.

---

## 2. Pre-existing WIP map

Four disjoint buckets. Only bucket A is editable in this workstream.

### A — SAFE (mine, committed, isolated) — the Next.js frontend
`frontend/**` (30 files). Contains: app router shell (`app/layout.tsx`, `app/home/page.tsx`, `app/providers.tsx`, `app/p0.css`), auth (`lib/auth.tsx`, `lib/firebase.ts`, `lib/preview.ts`, `lib/utils.ts`), trial display (`lib/trial-display.js`, `components/TrialBanner.tsx`), config (`next.config.mjs`, `tsconfig.json`, `.gitignore`, `.env.local.example`). Also **pre-existing scaffold I committed in PR-1** (fonts.ts, `components/typography/*`, `components/analytics/EventsTable.tsx`, `lib/formatters.ts`, `lib/theme.ts`, `styles/globals.css`, `styles/typography.css`, `tailwind.config.ts`) — currently **excluded from typecheck** (tsconfig excludes) until wired.

### B — FROZEN production (do not touch, ever)
`tool.html` (+5,501), `server.js` (+2,621 pre-existing WIP), `admin.html` (+1,029; interleaved WIP + my deferred trial edits), `index.html` (+3,047), `lib/gtm-config-builder.js`, `lib/config-blob-store.js`, `lib/crypto-vault.js`, `lib/server-side/sgtm-templates/*.tpl`, `Dockerfile`, `.env.example` (pre-existing part), `favicon.svg`.

### C — Untracked pre-existing Phase-2 WIP (do NOT commit or build on)
`packages/` (**design-tokens**, analytics-charts, analytics-table — full Style-Dictionary setup, untracked), `lib/profile-service.js` (+ my 3 uncommitted trial lines), `lib/{api-key-service,audit-service,cloud-monitoring,cloud-run-service,diagnostic-rules,dlq-worker,gtm-entity-registry,health-service,metrics,secret-manager,shard-registry,sgtm-template-loader,ssrf-guard,timeline-service}.js`, `lib/libapi-key-service.js.js`, `lib/providers/*`, `lib/provision/*`, `edge-router/`, `firestore-service.js`-adjacent services, ~24 untracked `tests/*`, `netlify-site/`, `marketing/`, `scripts/`, logos/icons/OG images, `robots.txt`, `sitemap.xml`, `firestore.indexes.json`.

### D — Mine, uncommitted (design docs + status)
`docs/EASYTRAC-UX-REDESIGN-SPEC.html`, `docs/EASYTRAC-DESIGN-SYSTEM.html`, `docs/EASYTRAC-P0-IMPLEMENTATION-PLAN.html`, `docs/TRIAL-FEATURE-STATUS.md`, **this file**. (Other `docs/*` are pre-existing.) Safe to commit as docs, separately from code.

---

## 3. Implementation matrix

| # | Phase / Feature | Current source | Target (route · file) | API dependency | Owner | Risk | Test requirement |
|---|---|---|---|---|---|---|---|
| 1 | Design tokens + foundations | DS v2 doc; `packages/design-tokens` is **untracked WIP** | `frontend/styles/tokens.css` (**new, self-contained**) + `globals` wiring | none | Codex (brief by Claude) | **High** (WIP token pkg) | `next build` + token compile |
| 2 | Core component library | DS v2 §04–06 | `frontend/components/ui/*` + `/showcase` route | none | Codex | Med | component render + a11y tests; showcase route |
| 3 | AppShell | UX spec §04 nav | `frontend/components/app/*`, `app/(app)/layout.tsx` | none | Codex | Med | build + responsive/RTL manual |
| 4 | Tracking Command Center (Home) | UX spec §05.1 | `app/home/page.tsx` (replace stub) | `GET /api/v1/clients/:id/{profile,diagnostics,timeline}` (existing) | Codex | High (real-data honesty) | states render; no fabricated metrics |
| 5 | Destinations | UX spec §05.2–5.3 | `app/(app)/destinations/*` | read from profile/diagnostics; **no new integrations** | Codex | Med | list/detail/empty states |
| 6 | Provisioning experience | UX spec §5.5 | `app/(app)/provisioning/*` | existing job/poll data only; **no logic change** | Codex | Med | pending/running/failed/retry states |
| 7 | Live Event Stream + Tracking Health | UX spec §5.4/5.6 | `app/(app)/{events,health}/*` | **BLOCKED** — needs real endpoints (Claude report first) | Codex (gated) | High | only real-data UI; mock only in previews |
| 8 | Trial visibility completion | TRIAL-FEATURE-STATUS.md | banner + admin display | needs `profile.paidAt` (uncommitted) + admin WIP committed | Codex (gated) | High | display-only; no enforcement |

---

## 4. Safe file list (Codex may create/edit)

- Anything **new** under `frontend/` (especially `frontend/components/ui/**`, `frontend/components/app/**`, `frontend/app/(app)/**`, `frontend/styles/tokens.css`, `frontend/lib/**` new helpers, `frontend/app/showcase/**`).
- Existing committed `frontend/**` files that are **mine** (layout, providers, home, p0.css, auth, firebase, preview, trial-display, utils, next.config, tsconfig, package.json).
- `frontend/tsconfig.json` (to re-include scaffold files as they're wired).
- `docs/codex/*` brief files (created by Claude).
- New `tests/*` **only** for frontend logic (e.g., `tests/*-display.test.js` style) or `frontend/**/*.test.tsx`.

Per phase, Codex gets a **narrower** allowlist inside this set. Never the whole tree.

## 5. Forbidden file list (Codex must never touch)

- **All of bucket B** (frozen production): `tool.html`, `server.js`, `admin.html`, `index.html`, `lib/gtm-config-builder.js`, `lib/config-blob-store.js`, `lib/crypto-vault.js`, `lib/server-side/**`, `Dockerfile`, `.env.example`, `favicon.svg`.
- **All of bucket C** (untracked Phase-2 WIP): `packages/**` (incl. `design-tokens`), `lib/profile-service.js`, every untracked `lib/*.js` service, `lib/providers/**`, `lib/provision/**`, `edge-router/**`, untracked `tests/*` (the Phase-2 suite), `netlify-site/**`, `marketing/**`, `scripts/**`, `firestore.indexes.json`, root logos/icons/manifests.
- **Generator / provisioning / GTM publishing / signup / payment** logic anywhere.
- `.claude/**`, `.env`, `.env.local`, `node_modules/`, `.next/`.

---

## 6. Ownership split (Claude ⟷ Codex)

**Claude:** architecture & route/component boundaries; design-token mapping (names/values from DS v2); UX acceptance criteria; per-phase file-scoped briefs (in `docs/codex/`); API/contract, security, a11y, RTL, responsive review; diff review; regression review; test planning; phase accept/reject; docs updates; small review fixes only.

**Codex:** React/Next implementation; CSS + token wiring; reusable components; responsive + RTL; loading/empty/error/success states; motion (CSS-first); unit/component tests; in-scope build fixes; small in-scope refactors. **Codex must not:** change architecture, invent flows, rename approved vocabulary, touch backend/frozen/forbidden files, add fake metrics, or bundle unrelated WIP.

**Never edit the same file simultaneously.** Claude hands a brief, Codex implements, Claude reviews the diff.

---

## 7. Commit boundaries

- One coherent commit (or a few) per phase, **frontend-only**, staged **file-by-file** from the phase allowlist.
- **Inspect `git diff --cached` before every commit**; abort if any bucket B/C/D content appears.
- Never commit `node_modules`, `.next`, `.env*.local`, logs, secrets. Commit `frontend/package-lock.json` only if the repo convention allows (currently root `.gitignore` ignores lockfiles — confirm per phase).
- Message convention: `feat(frontend): …` / `feat(ui): …` / `chore(frontend): …`.
- **No push, no deploy.** Report hashes + file list each phase.
- Design docs (bucket D) may be committed separately as `docs:` commits — not mixed with code.

---

## 8. Risk report

| Risk | Severity | Mitigation |
|---|---|---|
| **Design-token package is untracked pre-existing WIP** (`packages/design-tokens`) and `globals.css` references it via a broken path | **High** | Phase 1: Codex builds a **self-contained** `frontend/styles/tokens.css` (CSS vars from DS v2) — do **not** import/commit `packages/**`. Decouple from the WIP. |
| Enormous uncommitted tree (~12k insertions) → accidental sweep-in | **High** | Strict per-phase allowlists; mandatory staged-diff inspection; frontend-only commits. |
| `admin.html` trial edits interleaved with production WIP (deferred) | **Med** | Stays uncommitted/untouched; excluded from all phases until post-launch WIP isolation. |
| Home could show fabricated metrics if endpoints lack data | **High** | Phase 4: real data only; explicit unknown/empty states; Claude pre-audits endpoints. |
| Committed scaffold files excluded from typecheck (`components/typography`, `analytics`, `lib/formatters`, `lib/theme`) | **Med** | Re-include incrementally as wired (Phase 2), fixing their type errors in-scope. |
| Same-origin Firebase session depends on the proxy | **Med** | Keep Next.js proxied same-origin (PR-0 seam); never a separate subdomain. |
| Enabling UI prematurely | **High** | `NEXT_UI_ENABLED=false` until a full phase is reviewed AND parity proven. |

---

## 9. Test & rollback gates (per phase, all must pass)

**Gates:** (1) `cd frontend && npm run build` succeeds. (2) `tsc --noEmit` clean for in-scope files. (3) relevant `node --test` / component tests pass. (4) No bucket B/C/D file in the diff. (5) RTL (`dir="rtl"`) + LTR both render. (6) Keyboard focus visible; reduced-motion honored. (7) Responsive at 375 / 768 / 1280. (8) No fabricated data. (9) Legacy app still boots unchanged (spot check with flag off).

**Rollback:** every phase is frontend-only and behind `NEXT_UI_ENABLED=false` + the route allowlist → instant disable via env. Per-commit revert is clean (isolated files). No backend/legacy state to unwind.

---

## 10. Recommended execution order

1. **Phase 1 — Design tokens & foundations** *(self-contained `frontend/styles/tokens.css`; decouple from `packages/`)* → prerequisite for everything.
2. **Phase 2 — Core component library** + `/showcase` review route.
3. **Phase 3 — AppShell** (nav, Operations disclosure, mobile).
4. **Phase 4 — Tracking Command Center (Home)** on real endpoints.
5. **Phase 5 — Destinations** (list + detail shell; official icons).
6. **Phase 6 — Provisioning experience** (UI over existing job data).
7. **Phase 7 — Live Event Stream + Tracking Health** — **only after Claude reports real endpoints/collections/fields**; else deferred.
8. **Phase 8 — Trial visibility completion** — **only after** its committed dependencies exist (`profile.paidAt`, admin WIP isolated). Currently blocked (see TRIAL-FEATURE-STATUS.md).

**Two decisions I need before Phase 1:**
- **(D1)** Approve the **self-contained token layer** in `frontend/` (recommended), instead of wiring the untracked `packages/design-tokens` WIP.
- **(D2)** Confirm the **first Codex brief** is `docs/codex/PHASE-1-DESIGN-TOKENS-BRIEF.md`, transferred by file path only.
