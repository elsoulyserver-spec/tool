# EasyTrac Coded Design System — Implementation Architecture

## About this bundle

This is a **modular source implementation** of the design decisions specified in three approved
documents. It is not a new design and does not change any token value, component variant, state,
or behavior defined in v1 — it is the same system, restructured from one demonstration file into
real, independently importable modules.

Grounded in, and traceable back to:
- **EasyTrac Design System Specification v2.0** — tokens, components, states, visual classes
- **EasyTrac Interaction & Behavior Specification v1.0** — keyboard, focus, dialogs, toasts, loading
- **EasyTrac Screen Specifications v1.0** — which components compose which screens

The live, interactive single-file reference (`EasyTrac Coded Design System.dc.html`, elsewhere in
this project) remains the fastest way to *see* every token/component/state together and is 100%
visually identical to what's implemented here. This bundle is the **architecture** a frontend team
would actually build from: separate files, real DOM factory functions, and a documented API per
component — vanilla JS + CSS custom properties, framework-agnostic (swap the `document.createElement`
calls for JSX/Vue/Svelte templates in your stack; the token and class contract is what must survive).

## Folder structure

```
design_handoff_easytrac_design_system/
  tokens/
    primitives.css          Raw scales — color, space, radius, type, motion, z-index. No meaning attached.
    semantic.dark.css       Dark theme semantic mapping (primary mode) + theme-independent status classes.
    semantic.light.css      Light theme semantic mapping (fully supported alternate).
    density.css             Four density modes (low/medium/high/veryhigh) as [data-density] blocks.
    component-tokens.css    Third token layer — button/input/card/sidebar/dialog/table/status/
                             timeline/healthscore/incidentcard tokens, each mapping ONE component's
                             surface to semantic tokens. Components import nothing above this layer.
    motion.css              Shared @keyframes + prefers-reduced-motion override.
  layout/                   AppShell, Page, Workspace, Panel, Section, Inspector, SplitView, Toolbar
                             + layout.css (structural classes, no business logic).
  components/               21 base components (Button → DataTable) + components.css.
  operational/              16 EasyTrac-specific components (HealthScore → OfflineState) + statusMap.js
                             (the single source mapping all 14 approved states to the 5 visual classes)
                             + operational.css.
  charts/                   6 chart primitives as reusable SVG-emitting functions (Sparkline →
                             IncidentTimeline). No pie/donut/gauge/3D/dual-axis — matches Design
                             System §23 exactly.
  patterns/                 8 screen-level compositions (SearchFilterTable, IncidentResolution,
                             DeploymentProgress, DestinationSetup, CredentialEntry, SettingsForm,
                             Wizard, HealthDashboard) — each imports only from layout/, components/,
                             operational/, charts/, never redefines a token or color.
  icons/statusIcons.js      The 5 fixed status glyph shapes (Design System §22), size-locked to
                             16/20/24px.
  index.js                  Public entry point — re-exports everything, documents CSS load order.
```

## Token architecture (why three layers)

1. **Primitive** (`tokens/primitives.css`) — raw values, no meaning. Never referenced by components.
2. **Semantic** (`tokens/semantic.*.css`) — purpose-named, theme-aware (`--surface-1`, `--text-primary`,
   `--brand`) plus the theme-*independent* status classes (`--status-critical-fg`, etc.) that are
   reserved exclusively for operational state per Design System §2/§7.
3. **Component** (`tokens/component-tokens.css`) — one block per component family (Button, Input,
   Card, Sidebar, Dialog, Table, Status, Timeline, HealthScore, IncidentCard), each mapping that
   component's surfaces onto semantic tokens. **Every component file consumes only this layer** —
   never a primitive or semantic token directly. A rebrand or theme change touches layers 1–2 only;
   component code never changes.

Token-file consolidation note: the ten component-token families are kept in one file
(`component-tokens.css`), clearly sectioned by component, rather than ten near-empty files — this
mirrors how token files are organized at Vercel/Radix-scale systems and avoids file-count noise for
what is fundamentally one layer. Split further if your build tooling benefits from per-component
CSS chunking.

## Component API convention

Every file opens with a header block documenting exactly what the Design System/Interaction Spec
requires design review to check: **API, Variants, States, Accessibility, Keyboard, RTL, Responsive,
Token dependencies, Spec reference**. This is the same 19-field discipline the Screen Specifications
apply to screens, applied here to components.

## Using this bundle

These are **reference implementations**, not a published npm package — vanilla DOM factory functions
chosen so the logic is inspectable and framework-agnostic. To build EasyTrac's real frontend:

1. Load the CSS files in the order documented in `index.js`'s header comment.
2. Set `data-theme`, `data-density`, and `dir` on your root element.
3. Either use these factory functions directly (they run as-is in any modern browser via
   `<script type="module">`), or port each function's DOM calls to your framework of choice (React/
   Vue/Svelte) — the CSS classes, custom properties, and documented API/a11y/keyboard/RTL contract
   in each header are what must be preserved; the JS implementation detail is not sacred.
4. Compose screens from `patterns/*`, not by hand-assembling base components per screen — every
   pattern already encodes the composition Design System §11 and Screen Specifications specify.

## Fidelity

100% visually and behaviorally equivalent to `EasyTrac Coded Design System.dc.html` (v1). No token
value, component variant, state, or interaction rule was changed — only the file architecture.

## Related specs in this project

- `EasyTrac Design System Specification.dc.html`
- `EasyTrac Interaction and Behavior Specification.dc.html`
- `EasyTrac Screen Specifications.dc.html`
- `EasyTrac Coded Design System.dc.html` (the live single-file reference this bundle restructures)
