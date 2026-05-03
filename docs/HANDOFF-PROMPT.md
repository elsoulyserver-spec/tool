# 🎯 HANDOFF PROMPT — Easy Track SS Hardening (Session 2 → Session 3)

> الصق المحتوى ده كـ first message في الـ session الجديدة عشان كلود التاني يلحق على آخر حاجة.

---

## السياق: Easy Track — Server-Side Tracking
- **Repo:** `easytrac.io-main` (vanilla Node 18+ HTTP، مفيش Express)
- **Stack:** Firestore + Puppeteer + axios
- **Workspace:** `C:\Users\Yousef\Downloads\easytrac.io-main\easytrac.io-main`

## ✅ اللي اتعمل في الـ Session اللي فاتت (review + 8 fixes)

اتعملت **مراجعة كاملة** للكود + اتطبّقت 8 إصلاحات (4 critical bugs + 4 security hardenings) — كله تم verify بـ `node --check` على 8 ملفات + `npm test` (13 tests passing).

### Bugs اتأصلحت

| # | الـ bug | الملف | الإصلاح |
|---|---------|-------|---------|
| 1 | **trailing junk** بيكسر `node server.js` | `server.js` (آخره) | حذف 3 سطور خرّب جاهة (`); ... });`) |
| 2 | **package.json corrupted** — `EJSONPARSE` يكسر `npm install`/`npm test` | `package.json` | إعادة كتابة الملف نظيف |
| 3 | **deploy-stape field mismatch** — frontend بيبعت `apiKey` والـ backend متوقع `stapeApiKey` | `tool.html:14296` | عدّل الـ payload لـ `{stapeApiKey, containerName}` |
| 4 | **ss_loadConfig** بيقرأ `d.provider` بدل `d.config.provider` (الـ wrapper مش متفكوك) — أي مستخدم رجع للـ tool ما كانش يلاقي إعداداته | `tool.html` (ss_loadConfig function) | فك الـ wrapper الصح + array check للـ platforms |
| 5 | **test-event UI كذب** — `if (res.ok)` HTTP-level بدل `res.data.ok` body-level | `tool.html` (ss_sendTestEvent) | غيّر لـ `res.ok && res.data.ok` + إضافة latency في الـ message |
| 6 | **parseBody DoS** — مفيش حد لحجم الـ body (unlimited memory) | `server.js` (parseBody) | DEFAULT_BODY_LIMIT = 1MB، SS_BODY_LIMIT = 64KB، Content-Length pre-check + streaming abort + 413 response |
| 7 | **SSRF في validateUrl/sendTestEvent** — أي URL يعدي بدون فلترة (metadata service exposed!) | `lib/providers/base.js` | `assertSafeUrl()` جديد: protocol whitelist + port whitelist (80/443/8080/8443) + DNS lookup + private/loopback/link-local/CGNAT/metadata IP blocking + IPv6 coverage. **اتعمل smoke test 11/11 dangerous URLs blocked** |
| 8 | **XSS في buildSSRelayTag** — `ssUrl`/`evName`/`platform` بيتحقنوا في `<script>` بدون escaping | `tool.html` (buildSSRelayTag) | hard regex validation للـ ssUrl + `JSON.stringify` لكل user input قبل ما يُحقن في الـ JS source |

### Files اللي اتعدلت
```
server.js                       (parseBody + ssParseBody helper + 5 callsites updated)
package.json                    (rewritten clean)
tool.html                       (4 frontend bugs)
lib/providers/base.js           (SSRF guard added — exports assertSafeUrl)
HANDOFF-PROMPT.md               (هذا الملف)
```

### Verification الأخير
```bash
node --check ... → كل 8 ملفات OK
npm test         → 13 passed / 0 failed
SSRF smoke test  → 11/11 blocked (allowlist رفعت `EAI_AGAIN` للـ public DNS بسبب الـ sandbox، بس في production هتعدي عادي)
```

---

## ⚠️ Critical caveat: Windows ↔ Linux mount sync glitch

أثناء العمل اكتشفنا إن الـ Linux mount (الشغل بيوصله من خلال `mcp__workspace__bash`) بيشوف نسخة **مقطوعة/قديمة** من بعض الملفات حتى لما الـ Windows side (الـ Read/Edit tools) شايف النسخة الكاملة. الحل اللي اشتغل: rewrite الملف كامل عبر `bash << 'EOF'` heredoc — مش عبر Edit tool.

**ملحوظة:** الإصلاحات نزلت على Windows side صح (الـ Read tool بيشوفها)، بس **لو فتحت الـ repo في Linux/Docker مباشرة** ممكن تشوف نسخة قديمة من `server.js` و `lib/providers/base.js` — لازم تتأكد إن الـ files الـ committed في Git فيها كل الـ fixes (شغّل `node --check` و `npm test` بعد أي clone جديد).

---

## 📋 الحاجات اللي **لسه** ناقصة (priority)

### 🔴 High — security
1. **Firebase ID token verification** (TODO الموجود في كل /api/ss/* route).
   - حالياً: X-Client-Id header فقط — غير موثّق. أي user عنده client ID يقدر يحذف/يعدّل config حد تاني.
   - الحل: middleware يـ verify `Authorization: Bearer <ID_TOKEN>` عبر `firebase-admin.auth().verifyIdToken()` ويـ assert إن `decoded.uid === clientId`.
   - الـ scope: ~ساعتين، يحتاج branch منفصل، يحتاج تعديل الـ frontend `_ssApi()` يبعت الـ token.

2. **Body limit في باقي الـ endpoints** (`/api/gtm/import`, `/api/scan-url`, إلخ) — حالياً DEFAULT_BODY_LIMIT = 1MB يحميهم بس مينفعش يـ 413 صح.

### 🟠 Medium
3. **Rate limiter in-memory** — على Railway autoscale أو restart counters تروح. الحل: Firestore-backed counter أو Redis.
4. **Stape integration test** — الـ provider best-effort. لازم test حقيقي بـ Stape sandbox key، أو feature-flag الـ endpoint يرجع 501 لحد ما يتأكد.
5. **AAD encryption** — `crypto-vault` يربط الـ ciphertext بـ `clientId+platform` كـ AAD عشان token ما يتنقلش بين configs.

### 🟡 Low / Polish
6. **CSP** — `unsafe-inline` + `unsafe-eval` لازم يـ refactor `tool.html` يستخدم `addEventListener` بدل `onclick=""`.
7. **gtm_discovery.json** (270KB) و `PROMPT-SERVER-SIDE.md` و `PROMPT-SS-V2.md` — تتنقل لـ `docs/` أو تتحذف من الـ repo.
8. **firestoreService.getSSConfigPublic()** يعمل redaction داخلياً (defense-in-depth ضد سهو في route تاني).

---

## 🚀 المطلوب من Claude الجديد

اقرأ الملفات اللي اتعدلت (`server.js`, `tool.html`, `lib/providers/base.js`)، اتأكد إن الـ fixes موجودة، شغّل:
```bash
cd C:\Users\Yousef\Downloads\easytrac.io-main\easytrac.io-main
node -e "JSON.parse(require('fs').readFileSync('package.json'))"
node --check server.js
npm test
```

لو الـ 3 commands كلها OK، انتقل لـ priority #1 (Firebase ID token verification). لو فيه فرق بين الـ Windows view و bash view من حاجة، استخدم `bash heredoc` بدل Edit tool في الملفات اللي ظهرت متقطعة.

**اللي محتاج تطلبه من المستخدم قبل ما تبدأ:**
- يأكد إنه فاتح الـ folder الصح (`C:\Users\Yousef\Downloads\easytrac.io-main\easytrac.io-main`)
- يقرر — Firebase ID verification الأول، ولا حاجة تانية من الـ pending list؟

---

**اللي أنا عملته كان:** review كامل + 8 fixes + smoke test على الـ SSRF guard.
**اللي محتاج كلود الجديد:** يكمل من Firebase ID token verification (priority #1).
