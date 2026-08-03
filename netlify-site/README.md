# netlify-site/ — NOT a deployable site

**Do not deploy this folder.** It has no `index.html` on purpose.

## What happened

`netlify-site/index.html` was a self-contained copy of the landing page, committed once
in `9cd3193 "chore: add deployment tooling"` and never updated again. The canonical
landing page — `/index.html` at the repo root — moved on without it.

By 2026-08-01 the copy had drifted far enough to be a launch hazard. Release QA found it
still served:

| Stale content in the snapshot | Approved content |
|---|---|
| سنوي / شهري billing toggle | monthly only — **no annual pricing** |
| Starter ٤٩٩ ر.س / سنة, Growth ٩٩٩ ر.س / سنة | Basic ٢٥ ر.س/شهر, Growth ٤٩ ر.س/شهر |
| "وفّر حتى ١٦٪" annual-discount FAQ | removed |
| plan name "Starter" | plan name "Basic" / الباقة الأساسية |

Deploying it would have published pricing the business does not offer.

## The safeguard

The snapshot is **preserved, not deleted** — it moved to
`_archive/index.stale-2026-07-12.html.bak`. Nothing is lost, and `git log --follow` still
reaches its full history.

Two independent things had to be true, not one:

1. **No longer the folder's `index.html`.** A static host pointed at `netlify-site/` as a
   site root now 404s instead of publishing it — this alone was the first fix.
2. **No longer servable by path at all, on the app that's actually deployed.**
   `server.js`'s static file handler is a generic file server rooted at the repo root: it
   serves *any* file under an allowed extension (`.html`, `.css`, images, fonts, `.txt`,
   `.map`) by its literal path, not an allowlist of specific pages. That means the archived
   file, if it had kept the `.html` extension, would still have been fetchable directly at
   `/netlify-site/_archive/index.stale-2026-07-12.html` on the real running app — unlinked,
   but not actually inert. The `.bak` extension is **not** in `server.js`'s
   `STATIC_ALLOW_EXT` allowlist, so that same handler now returns `403 Forbidden` for it.
   `tests/public-pages.test.js` boots a real `server.js` instance and asserts this directly.

`tests/public-pages.test.js` also fails if any file that *would* be served from a public
path reintroduces annual pricing or the old plan names.

## If you need a static marketing site again

Publish the canonical page instead of reviving this copy. It needs these files together:

```
index.html  privacy.html  terms.html  legal.css  easytrack-design-system.css
favicon.svg  favicon.ico  favicon-16x16.png  favicon-32x32.png
apple-touch-icon.png  android-chrome-192x192.png  android-chrome-512x512.png
og-image.png  site.webmanifest  robots.txt  sitemap.xml
```

Copying `index.html` into a second folder is what created this problem — prefer serving
the root directly, or generating the static bundle from it at deploy time so it cannot drift.
