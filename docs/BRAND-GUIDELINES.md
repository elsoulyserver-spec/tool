# EasyTrack brand mark — guidelines (locked)

Status: **final**. This spec and the files it describes are the single source of truth. Do not redesign, re-propose, or re-derive proportions from scratch — extend this document if a new surface needs a rule it doesn't yet cover.

---

## 1. The mark

**Single-stroke E + data pipeline + event node.**

```
E────●
```

- The E-bracket (spine + top bar + bottom bar) is the letter.
- The middle stroke is the pipeline — it extends past the bracket and flows directly into the node with zero seam (no gap, no separate line-plus-circle).
- The node is the only colored element, always `#2F6BFF`, on every background, in every context.

Source files: [`logo.svg`](../logo.svg) (currentColor, universal), [`logo-dark.svg`](../logo-dark.svg) (white, for dark surfaces), [`logo-light.svg`](../logo-light.svg) (black, for light surfaces).

---

## 2. Construction grid

Master grid: `viewBox 0 0 120 120`, stroke width `12` (= 1 module).

| Element | Coordinates |
|---|---|
| Spine (x) | `36` |
| Top bar (y) | `30` |
| Bottom bar (y) | `90` |
| Bracket bar length | `36` (spine to `x=72`) |
| Pipeline stroke | `x=36` to `x=90` (runs under the node) |
| Node center | `(98, 60)` |
| Node radius | `10` |

**The one number that defines the whole mark:** bracket-bar-length : pipeline-reach = **1 : 2**. Pipeline reach = distance from the spine to the node's outer edge (`108 − 36 = 72`; bracket bar = `36`). Any resize of the mark must preserve this ratio exactly — it's the spec, not a guideline.

**Optical correction:** the node's diameter is ~1.7× the stroke width (`20` vs `12`), not 1:1. Round shapes measure smaller than straight strokes of equal weight to the eye, so the node is deliberately oversized to read as equal weight next to the bracket.

**Fusion rule:** the pipeline stroke must terminate *under* the node (overlapping into it), never stopping short. It must read as one continuous gesture, not a line touching a circle.

---

## 3. Clear space and minimum size

- **Clear space:** no other element (text, UI chrome, edge of frame) may sit closer than **1 module (the stroke width)** to the mark's bounding box, on any side.
- **Minimum size, digital:** 16px (favicon floor). Below 16px, use the favicon-tuned hand-fit version, not a naive downscale of the master vector.
- **Minimum size, print:** 6mm / ~0.25in.
- **App icon / favicon corner radius:** `rx` = ~21.9% of the tile edge (`14` of `64`, `112` of `512`) — a fixed ratio, not eyeballed per size.

---

## 4. Color system (locked: Option A)

| Role | Value | Use |
|---|---|---|
| Ink | `#0A0A0A` | Mark on light backgrounds; dark tile fill |
| Field | `#FFFFFF` | Mark on dark backgrounds; light tile fill |
| Node | `#2F6BFF` | The event node — **never** used for the bracket/pipeline stroke, **never** substituted |

Rule: the bracket and pipeline are always pure ink-on-field or field-on-ink — monochrome, full stop. The node is the only thing that ever carries color, and it never changes hue depending on theme, product surface, or marketing campaign. In-product, the same blue may double as a "live event" status color — that's intentional reuse, not a second brand color.

---

## 5. Usage rules — do / don't

**Do:**
- Use `logo-light.svg` on light surfaces, `logo-dark.svg` on dark surfaces, `logo.svg` (currentColor) when the surface color is dynamic/unknown at build time.
- Keep the node blue on every background, including monochrome print contexts where the rest of the mark goes single-color — the node can drop to the same ink color only in strict single-color reproduction (e.g. engraving, thermal receipt printers), never in any color-capable context.
- Preserve the 1:2 ratio at every size.

**Don't:**
- Don't recolor the bracket/pipeline (no brand-color tints, no gradients).
- Don't add drop shadows, glows, bevels, or any 3D effect.
- Don't rotate, skew, or distort the mark.
- Don't separate the pipeline stroke from the node (no gap).
- Don't redraw the bracket at a different width\:height ratio than 1:2.
- Don't place the mark on a busy background without the standard tile (rounded square, ink or field fill) behind it.

---

## 6. Asset index

| File | Purpose |
|---|---|
| `logo.svg` | Master mark, `stroke="currentColor"`, transparent — node fixed `#2F6BFF` |
| `logo-dark.svg` | White-stroke mark for dark surfaces |
| `logo-light.svg` | Black-stroke mark for light surfaces |
| `favicon.svg` | 64×64 dark tile (browser tab / SVG favicon) |
| `favicon.ico` | 16/32/48 multi-resolution icon (legacy browser support) |
| `app-icon-dark.svg` | 512×512 dark tile, master vector for app-icon export |
| `app-icon-light.svg` | 512×512 light tile, master vector for app-icon export |

Export the app-icon SVGs at 1024/512/192/64 as needed — they're vector masters built on the same grid, so every export size stays in exact proportion. Do not hand-redraw at each pixel size.
