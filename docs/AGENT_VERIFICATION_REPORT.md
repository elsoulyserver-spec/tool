# GTM Server Container - 7-Agent Production-Readiness Verification

Run as one coordinated battery (the "apply patch -> re-run affected agents" loop needs
central control of shared repo files; independent parallel agents would clobber each
other's patches). Every claim below is backed by an executed harness, not inspection.

Harnesses (in the session scratchpad, runnable against the repo):
`agent_audit.js` (Agents 1/3/6), `agent4_runtime.js` (Agent 4), `lib/server-side/validate-container.js` (shipped validator).

---

## 1. Executive Summary

| Agent | Domain | Result |
|---|---|---|
| 1 | Sandbox compatibility (4 templates) | **PASS** |
| 2 | Credential integrity / data-flow | **PASS** (gate added) |
| 3 | GTM import verification | **IMPORTABLE** |
| 4 | Runtime event delivery (purchase) | **PASS** (4/4 platforms) |
| 5 | Snapchat API compliance | **NON-COMPLIANT -> PATCHED to v3 -> COMPLIANT** |
| 6 | Validator penetration test | **14/14 (100%) caught** |
| 7 | Production readiness | **GO (conditional)** - score 90/100 |

One real defect was found by Agent 5 (Snapchat still on the deprecated v2 API) and one
hardening gap by Agent 2 (no hard publish gate). Both were patched and affected agents
re-ran green.

---

## 2. Agent Reports

### Agent 1 - GTM Sandbox Compatibility Auditor -> PASS
Files: `lib/server-side/sgtm-templates/{meta-capi,tiktok-events,snapchat-capi,google-ads-ec}.tpl`
Per template, scanning the `___SANDBOXED_JS_FOR_SERVER___` block:

```
meta-capi      regex=0 .test(=0 newRegExp=0 try{=0 }catch=0 Date=0 new=0 nonASCII=0 NUL=0  Object.keys+require(Object)=true  perms: send_http+logging present
tiktok-events  regex=0 .test(=0 newRegExp=0 try{=0 }catch=0 Date=0 new=0 nonASCII=0 NUL=0  Object.keys+require(Object)=true
snapchat-capi  regex=0 .test(=0 newRegExp=0 try{=0 }catch=0 Date=0 new=0 nonASCII=0 NUL=0  Object.keys+require(Object)=true
google-ads-ec  regex=0 .test(=0 newRegExp=0 try{=0 }catch=0 Date=0 new=0 nonASCII=0 NUL=0  Object.keys+require(Object)=true
```
require() across all four resolves only to: `sendHttpRequest, JSON, sha256Sync, makeNumber,
makeString, logToConsole, getTimestampMillis, Math, Object`. No `Date` (Google Ads builds
the timestamp arithmetically in `toGadsTs()`). **No remaining compatibility risks.**

### Agent 2 - Credential Integrity Auditor -> PASS
Data flow (`tool.html`):
```
config/scanner -> S.pixelIds (string | {id,url}) --+
CAPI token inputs -> _capiTokens ------------------+--> _pcSS.{pixelIds,tokens}
                                                    |        |
                            (Object.assign merge) --+        v
                                          buildSSContainer(): credVal(raw, placeholder)
                                                             |
                                              tag.parameter[].value  (pixelId/accessToken/...)
```
Vulnerable path (pre-fix): `_pcSS.pixelIds = Object.assign({}, _pcSS.pixelIds, S.pixelIds)`
could carry an object or a scanned URL into `pixelId`/`accessToken`. Now every credential
site passes through `credVal()` (function `credVal` in `buildSSContainer`):
```js
if (low.indexOf('http://')===0 || low.indexOf('https://')===0 ||
    v.indexOf('://')!==-1 || low.indexOf('easytrac.io')!==-1) return placeholder;
```
Test (input `https://tool.easytrac.io/`): credVal -> placeholder; and the validator marks a
URL credential as a hard **ERROR**. Covered fields: pixelId, accessToken, apiToken,
pixelCode, conversionId.
**Recommendation (implemented): block, don't just replace.** Silent replacement keeps the
container importable, but a hard gate was added so a container with ANY validation error is
never published (see patch P2).

### Agent 3 - GTM Import Verification -> IMPORTABLE
Built a full container (4 templates + 4 CAPI tags + GA4 client + All-Events trigger + 2
header variables) and ran the shipped validator:
```
schema: exportFormatVersion==2 OK | usageContext=SERVER OK | customTemplate=4 OK |
every tag has type OK | every tag has firingTriggerId OK | every template has templateData OK |
client present OK | trigger present OK
validator: checks=91 errors=0 warnings=0  -> IMPORTABLE
```
Blocking issues: **none**.

### Agent 4 - Runtime Event Delivery -> PASS (4/4)
Each template's real sandboxed JS executed against mocked GTM APIs for
`{event_name:purchase, value:100, currency:USD}`:
```
Meta CAPI      POST graph.facebook.com/v22.0/<pixel>/events  body.data[0].custom_data.value=100, em=64-hex  success(200)->gtmOnSuccess  fail(500)->gtmOnFailure
TikTok         POST business-api.tiktok.com/.../event/track/ header Access-Token, properties.value=100      success/fail OK
Snapchat (v3)  POST tr.snapchat.com/v3/<pixel>/events?access_token=  data[0].event_name=PURCHASE,action_source=WEB,event_time(ms),custom_data.value=100  success/fail OK
Google Ads EC  POST googleads.googleapis.com/v17/customers/<cid>:uploadClickConversions  conversion_value=100,gclid set,conversion_date_time matches yyyy-MM-dd HH:mm:ss+00:00  success/fail OK
```

### Agent 5 - Snapchat API Specialist -> NON-COMPLIANT, then PATCHED -> COMPLIANT
Checked against current docs (developers.snap.com Conversions API v3; v2 deprecated early 2025).
Findings (pre-patch) and fixes:

| Item | Before (v2) | After (v3) |
|---|---|---|
| Endpoint | `tr.snapchat.com/v2/conversion` (deprecated) | `tr.snapchat.com/v3/{pixel_id}/events?access_token={token}` |
| Auth | `Authorization: Bearer` header | token in URL query (header removed) |
| Body shape | flat object | `{ data: [ event ] }` |
| Event field | `event_type` | `event_name` |
| Dedup id | `client_dedup_id` | `event_id` (matches pixel client_dedup_id) |
| Required | (missing) | `action_source: 'WEB'` added |
| user_data | `ip_address`,`user_agent` | `client_ip_address`,`client_user_agent`; `external_id` string |
| custom_data | `price`,`transaction_id`,`item_ids` | `value`,`order_id`,`content_ids` |
| event_time | ms | ms (kept; v3 accepts s or ms, ms encouraged) |

Post-patch Agent 1 + Agent 4 re-ran green.

### Agent 6 - Validator Penetration Tester -> 14/14 (100%)
```
[CAUGHT] regex literal           [CAUGHT] URL in pixelId        [CAUGHT] non-ASCII in templateData
[CAUGHT] RegExp constructor      [CAUGHT] URL in accessToken    [CAUGHT] NUL byte in templateData
[CAUGHT] try/catch               [CAUGHT] URL in apiToken       [CAUGHT] unsupported require API
[CAUGHT] new keyword             [CAUGHT] URL in pixelCode      [CAUGHT] Object.keys w/o require(Object)
[CAUGHT] missing usageContext    [CAUGHT] URL in conversionId
COVERAGE: 14/14 = 100%
```
Missing checks: none for the attack classes specified. (Future hardening ideas in Remaining Risks.)

### Agent 7 - Production Readiness Reviewer -> GO (conditional), 90/100
- Reliability: primary export path is deterministic, validated, ASCII-only. +
- GTM compatibility: 4/4 templates sandbox-clean; import verified. +
- Security: credentials sanitized + hard publish gate; no URL leak. +
- Failure handling: runtime success/failure paths both wired to gtmOnSuccess/Failure. +
- Maintainability: validator extracted to a reusable module + CLI. +
- Deductions: inline Snapchat *fallback* (offline-only) still v2; server-side
  `gtm-config-builder.js` fallback truncated; workspace tooling intermittently corrupts files.

---

## 3. Remaining Risks

1. **Inline Snapchat fallback** in `tool.html` (`_makeFallbackTpl` SNAP_TEMPLATE_CODE) still
   emits a v2-style payload. Only reached if `GET /api/sgtm-templates` fails (offline/static
   preview); the production path embeds the v3 `.tpl`. Recommend converting the fallback to v3.
2. **`lib/gtm-config-builder.js`** server-side fallback remains truncated (not the primary
   path; `require()` of it is wrapped in try/catch in server.js). Reconstruct or delete.
3. **Workspace file corruption**: the editor/linter intermittently truncated/NUL-padded large
   files during this work. Commit the now-clean files to git so corruption is recoverable.
4. Validator is heuristic (string/regex scans), not a full GTM compiler; it catches the known
   failure classes but is not a substitute for GTM's own import check.

---

## 4. Production Readiness Score: 90 / 100

Primary export path: importable, runtime-correct, credential-safe, ASCII-only, Snapchat v3.
Points withheld for the two non-primary leftovers (Snapchat fallback, truncated server builder)
and the environment's file-corruption behaviour.

## 5. Go / No-Go: **GO** (conditional)

Ship the primary generator path. Conditions before/just after release: (a) convert the
Snapchat inline fallback to v3 or disable it, (b) commit the clean files to git.

## 6. Exact patches applied this round

- **P1 - Snapchat v2 -> v3** (`lib/server-side/sgtm-templates/snapchat-capi.tpl`): endpoint,
  auth, body shape, field renames per the table in Agent 5. Re-verified: 0 regex, 0 try/catch,
  0 non-ASCII; runtime POSTs to the v3 endpoint.
- **P2 - hard publish gate** (`tool.html`, direct-publish handler, after
  `_serverConfigJson = buildSSContainer();`):
  ```js
  var _ssVal = (typeof window !== 'undefined') && window.__ET_SS_VALIDATION;
  if (_ssVal && _ssVal.errors && _ssVal.errors.length) {
    _serverConfigJson = null;
    throw new Error('Server container BLOCKED - failed validation: ' + _ssVal.errors.join('; '));
  }
  ```

(Prior rounds: regex->isHex64, try/catch->`JSON.parse||{}`, `require('Object')`, NUL strip,
ASCII fold, `credVal()` on 7 credential sites, `etAsciiDeep` + `validateSSContainer` before
return, reusable `validate-container.js`.)

## 7. Evidence the original GTM parsing error is resolved

Original failure: `Unable to parse Sandboxed JavaScript code ... Offending token '/'` on
`if (s.length === 64 && /^[a-f0-9]+$/.test(s)) return s;`.

Checked **in the generated container's `templateData`** (not the source):
```
contains /^[a-f0-9]+$/ : false
contains .test(        : false
contains isHex64       : true     (regex replaced by a char-by-char hex loop)
```
All four templates: 0 regex literals, parse as valid JS (esprima), and Agent 3 reports the
full container IMPORTABLE with 0 errors. The offending `/` token no longer exists in any
sandboxed JS the generator emits.
