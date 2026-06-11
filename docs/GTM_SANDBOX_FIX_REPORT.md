# GTM Server-Side Sandboxed JS — Compatibility Audit & Fix Report

**Scope:** the four inline Custom Templates embedded in the generated server container
(`containerVersion.customTemplate[].templateData`): Meta CAPI, TikTok Events API,
Snapchat CAPI, Google Ads Enhanced Conversions.

**Files involved**
- `lib/server-side/sgtm-templates/meta-capi.tpl`
- `lib/server-side/sgtm-templates/tiktok-events.tpl`
- `lib/server-side/sgtm-templates/snapchat-capi.tpl`
- `lib/server-side/sgtm-templates/google-ads-ec.tpl`
- `lib/gtm-config-builder.js` (the generator that reads the `.tpl` files and embeds them)

**Result:** all four templates now pass: container JSON round-trips, 0 NUL bytes,
0 regex literals, 0 `try/catch`, all `require()` calls resolve to valid server APIs,
`Object.keys` is backed by `require('Object')`, and every sandbox body parses as valid JS.

---

## 1. Root cause analysis

The generator writes each template's **full source** (the `___INFO___ … ___SANDBOXED_JS_FOR_SERVER___ …`
block) into `customTemplate[].templateData`. On import, GTM **compiles the sandboxed JS**.

GTM's sandboxed JavaScript is **ECMAScript 5.1** plus a small set of ES6 features (arrow
functions, `const`/`let`). Several constructs are **removed at the parser level** — they
are rejected when the template is compiled, before any code runs:

- **Regex literals** (`/.../`) — unsupported. The parser hits the leading `/` and stops.
  This produced your exact error: `Unable to parse Sandboxed JavaScript code … Offending token '/'`
  on `if (s.length === 64 && /^[a-f0-9]+$/.test(s)) return s;`.
- **`try` / `catch` / `finally` / `throw`** — unsupported.
- **`new`**, `this`, and global constructors/objects (`Object`, `Date`, `String`, `window`,
  `document`, `setTimeout`, …) — unavailable. Everything comes from `require()`.

The original hex check used a regex literal → first parse error. After that line was
hand-refactored to the `isHex64()` helper, **three latent blockers remained**:

1. `try { JSON.parse(...) } catch(e){}` in **TikTok** and **Google Ads** — unsupported syntax.
2. `Object.keys(...)` called in **all four** templates **without** `const Object = require('Object')`
   — `Object` is not a sandbox global.
3. **NUL-byte padding corruption** (548–1,795 `` bytes per file, from an editor crash —
   note the `*.corrupted-backup` / `*.bak2` artifacts in the repo). `fs.readFileSync(…, 'utf8')`
   reads those NULs into `templateData`; a single control byte inside the string makes GTM
   reject the whole import.

---

## 2. Confirmed against official Google docs

| Question | Verdict | Source |
|---|---|---|
| Regex literals `/.../` | **Not supported** (parser error) | Sandboxed JavaScript |
| `try` / `catch` | **Not supported** | community + sandbox is ES5.1 restricted |
| `const` / `let` | **Supported** (ES6 subset) | Sandboxed JavaScript |
| Arrow functions | **Supported** | Sandboxed JavaScript |
| Template literals `` ` `` | Not relied on (avoided) | — |
| `Array.prototype.map` | **Supported** | Standard Library |
| `String` `.trim/.charAt/.indexOf/.split/.toLowerCase` | **Supported** | Standard Library |
| `Object.keys/values/entries` | Only via `require('Object')` | Custom Template APIs |
| `JSON.parse` / `JSON.stringify` | **Supported**; `parse` returns `undefined` on bad input (never throws) | Custom Template APIs |
| `sendHttpRequest` returns a Promise (`.then/.catch`) | **Supported** | Custom Template APIs |
| `sha256Sync(s, {outputEncoding:'hex'})` | **Supported** | Custom Template APIs |
| `Math.floor`, `getTimestampMillis`, `makeNumber`, `makeString`, `logToConsole` | **Supported** | Custom Template APIs |

`require()` audit — every call resolves to a valid server-side API:
`sendHttpRequest, JSON, sha256Sync, makeNumber, makeString, logToConsole, getTimestampMillis, Math, Object`.
Declared permissions (`send_http`, `read_event_data`, `logging`) cover the APIs used.

---

## 3. Incompatible features found (and disposition)

| # | Incompatibility | Where | Fix |
|---|---|---|---|
| 1 | Regex literal `/^[a-f0-9]+$/` | (original) hex check | Already refactored to `isHex64()` loop — confirmed 0 regex literals remain |
| 2 | `try { … } catch(e) { … }` | tiktok-events, google-ads-ec | Replaced with `var parsed = JSON.parse(res.body) \|\| {};` |
| 3 | `Object.keys()` without `require('Object')` | all 4 | Added `const Object = require('Object');` |
| 4 | NUL-byte padding corruption | all 4 (`.tpl` on disk) | Stripped; generator hardened to strip control chars on load |

---

## 4. Exact code changes

### 4a. All four templates — add the missing `Object` API

```diff
 const getTimestampMillis = require('getTimestampMillis');
 const Math               = require('Math');
+const Object             = require('Object');
```

Required because `Object.keys()` is used in the `clean()` helper and in the final
`Object.keys(x).length > 0` payload guards. In the sandbox, bare `Object` is undefined;
`Object.keys/values/entries` exist only on the object returned by `require('Object')`.

### 4b. TikTok + Google Ads — remove unsupported `try/catch`

```diff
-  var parsed;
-  try { parsed = JSON.parse(res.body); } catch(e) { parsed = {}; }
+  var parsed = JSON.parse(res.body) || {};
```

Behaviour is identical: GTM's `JSON.parse` returns `undefined` for malformed JSON instead
of throwing, so `|| {}` yields the same `{}` fallback the `catch` produced. Downstream
checks (`parsed.code === 0` for TikTok, `!parsed.partialFailureError` for Google Ads) are
unchanged.

### 4c. Regex hex check (already in place — kept as the canonical replacement)

```js
// Sandbox-safe hex check (GTM sandboxed JS does NOT support regex literals)
function isHex64(s) {
  if (!s || s.length !== 64) return false;
  var hexChars = '0123456789abcdef';
  var i;
  for (i = 0; i < 64; i++) {
    if (hexChars.indexOf(s.charAt(i)) === -1) return false;
  }
  return true;
}
```

This replaces `if (s.length === 64 && /^[a-f0-9]+$/.test(s)) return s;`. If you ever need
regex inside the sandbox, the only sanctioned route is the `createRegex` + `testRegex` APIs
— but the loop above is simpler and dependency-free.

### 4d. NUL-byte corruption

The four `.tpl` files were rewritten on disk with all control bytes removed (verified 0
NULs). No code change — a content repair.

---

## 5. Updated generator code (`lib/gtm-config-builder.js`)

Hardened `_loadTpl` so corrupt control characters can never reach the container JSON again,
plus a guard that fails loudly on an empty/truncated template:

```js
function _sanitizeTpl(text) {
  if (text == null) return null;
  return text
    .replace(/^\uFEFF/, '')                                  // strip BOM
    .replace(/\r\n?/g, '\n')                                  // CRLF/CR -> LF
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');       // drop control chars
}

function _loadTpl(name) {
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, 'server-side', 'sgtm-templates', name + '.tpl'),
      'utf8',
    );
    const clean = _sanitizeTpl(raw);
    if (!clean || clean.indexOf('___SANDBOXED_JS_FOR_SERVER___') === -1) {
      throw new Error('template ' + name + ' is empty or missing required sections');
    }
    return clean;
  } catch (e) {
    return null;
  }
}
```

---

## 6. Verification performed

A Node harness mirrored the generator: load + sanitize each `.tpl`, build
`containerVersion.customTemplate[]`, `JSON.stringify` → `JSON.parse` round-trip, then for
each sandbox body check NULs / regex literals / `try-catch` / `require()` validity /
`Object` requirement, and parse the body with **esprima**.

```
CONTAINER JSON round-trip OK, templates = 4
[meta-capi]      PASS  nulls=0 regexLiterals=0 tryCatch=0 ObjRequire=true  esprima: OK
[tiktok-events]  PASS  nulls=0 regexLiterals=0 tryCatch=0 ObjRequire=true  esprima: OK
[snapchat-capi]  PASS  nulls=0 regexLiterals=0 tryCatch=0 ObjRequire=true  esprima: OK
[google-ads-ec]  PASS  nulls=0 regexLiterals=0 tryCatch=0 ObjRequire=true  esprima: OK
ALL TEMPLATES PASS
```

> Note: the regex matches still present elsewhere in the repo — `lib/server-side/hash-utils.js`,
> `lib/server-side/payload-sanitizer.js`, and `tool.html` — are **correct**. Those run in
> Node.js / the browser, not the GTM sandbox, so regex literals are fine there. Only the
> `.tpl` sandbox code must avoid them.

---

## 7. Round 2 - ASCII, credential bug, and pre-export validation

### 7a. Non-ASCII stripped from all four templates (Requirement 3)
The `.tpl` sandboxed JS still carried non-ASCII characters that are removed now:

| File | box `-` (U+2500) | em-dash (U+2014) | emojis/arrows | total removed |
|---|---|---|---|---|
| meta-capi.tpl | 600 | 3 | 2 (check/cross), 1 arrow | 607 -> 0 |
| tiktok-events.tpl | 694 | 1 | 3 | 698 -> 0 |
| snapchat-capi.tpl | 473 | 2 | 3 | 478 -> 0 |
| google-ads-ec.tpl | 473 | 4 | 4 (incl. warning + VS-16) | 482 -> 0 |

Log strings now match the requested form, e.g. `logToConsole('ET:MetaCAPI: success', ...)`
(was `'ET:MetaCAPI: (check) success'`). All four files are now 100% ASCII and still
parse as valid sandboxed JS (esprima OK).

### 7b. Credential-field URL bug (Requirement 8) - BUG FOUND & FIXED
Root cause: in `buildSSContainer()` (tool.html) credential fields were filled directly
from `_pcSS.pixelIds[plat]` / `_pcSS.tokens[plat]`. Those objects are merged from
`S.pixelIds` (line ~11494) which can hold **objects** (`{id, url}`) or values seeded by
config/scan paths - so a tool/sGTM URL (`https://tool.easytrac.io/`) could land in
`pixelId` / `accessToken`. Fixed with a `credVal()` normaliser applied to all 7 credential
sites (meta pixel+token, snap pixel+token, tiktok pixel+token, gads conversion id):

```js
function credVal(raw, placeholder) {
  var v = raw;
  if (v && typeof v === 'object') v = v.id || v.value || v.token || '';   // unwrap objects
  v = (v == null ? '' : String(v)).replace(/^\s+|\s+$/g, '');
  if (!v) return placeholder;
  var low = v.toLowerCase();
  if (low.indexOf('http://') === 0 || low.indexOf('https://') === 0 ||
      v.indexOf('://') !== -1 || low.indexOf('easytrac.io') !== -1) return placeholder; // never a URL
  return v;
}
```

Unit test (extracted credVal, run in Node):

```
credVal("https://tool.easytrac.io/")            = "YOUR_META_PIXEL_ID"   (URL rejected)
credVal({id:"123456789",url:"https://..."})     = "123456789"           (object -> id)
credVal("  987654321  ")                         = "987654321"           (trimmed)
credVal("EAAabcTOKEN")                           = "EAAabcTOKEN"          (real token kept)
credVal("")                                      = placeholder
```

### 7c. Output is ASCII-folded + validated before export (Requirements 1, 9, 10)
`buildSSContainer()` now, right before returning, runs `etAsciiDeep(export)` (em-dash/arrow
-> ASCII, drop emojis/smart-quotes/box chars across every string in the container) and then
`validateSSContainer(export)`, logging pass/fail to the console. Two CAPI-tag `notes` that
embedded check/warning emojis were also made ASCII (`'set'` / `'not set'`).

### 7d. Reusable validator: `lib/server-side/validate-container.js`
A standalone Node module + CLI you can run on any export before importing:

```
node lib/server-side/validate-container.js docs/easytrack-sgtm-server-container.generated.json
```

It checks: JSON validity; GTM schema basics (containerVersion, usageContext=SERVER);
per-template sandboxed-JS compatibility (no regex literal/`.test()`/`new RegExp`, no
`try/catch`, no `new`, no non-ASCII, no NUL, `Object.keys` requires `require('Object')`);
`require()` API validity against the supported server API list; and credential hygiene
(no URL in pixelId/accessToken/apiToken/pixelCode/conversionId/...).

Test results:
```
Real regenerated container : 76 checks, 0 errors, 3 warnings -> PASS
Synthetic bad container    : 4 errors -> FAIL (regex literal, try/catch, 2 URL credentials)
```

### 7e. Pre-export validation checklist
1. JSON parses (`JSON.parse` round-trips).
2. `containerVersion.container.usageContext` includes `SERVER`.
3. Every `customTemplate[].templateData`:
   - contains `___SANDBOXED_JS_FOR_SERVER___`;
   - 0 regex literals / `.test()` / `new RegExp`;
   - 0 `try`/`catch`; 0 `new`;
   - 0 non-ASCII; 0 NUL/control bytes;
   - `Object.keys` only with `require('Object')`;
   - every `require('X')` is a supported server API.
4. Every tag has `type` + `firingTriggerId`; credential fields hold IDs/tokens, never URLs.
5. `client[]`, `trigger[]` present.
6. Whole export is ASCII.

### 7f. Helper-function validation (Requirement 6)
`hash()`, `hashPhone()`, `clean()`, `toArray()` and the timestamp helpers were checked
against the GTM Standard Library: they use only supported methods - `String.split/join/
indexOf/charAt/toLowerCase/trim`, `Array.map/push`, `Object.keys` (via `require('Object')`),
`Math.floor`, `makeString/makeNumber`, `sha256Sync`, `getTimestampMillis`. No `Date`, no
regex, no `new`. The Google Ads `toGadsTs()` builds the `yyyy-MM-dd HH:mm:ss+00:00` string
with pure arithmetic (no `Date`, unavailable in the sandbox).
