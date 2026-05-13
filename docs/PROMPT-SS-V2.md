# Mission: Build Server-Side Tracking for Easy Track (production-ready)

أنت Senior Tracking Engineer. مطلوب تبني Server-Side Tracking كامل في
Easy Track وتشيل status "Coming Soon"، عشان يكون feature production-ready.

═══════════════════════════════════════════════════════════
## 📂 الملفات (اقرأها بالترتيب)

1. `tool.html` — الأداة كلها (HTML + CSS + ET Engine JavaScript)
   • سطر 5880+ : `generate()` — مولّد GTM Container JSON
   • سطر 12849+ : ET Engine — `buildPlatformPayload`, `_userIdentity`, `sha256`
   • سطر 13391+ : SERVER-SIDE UI placeholder الموجود حالياً
   • 3 أماكن "Coming Soon": sidebar (~3493) + page title (4151-4152) + layout بـ `opacity:0.6`

2. `server.js` — ⚠️ vanilla Node.js HTTP (مفيش Express)
3. `gtm-service.js` — GTM API service (شوف JWT auth pattern)
4. `firestore-service.js` + `package.json` — للـ deps المتاحة
   • متاح: `firebase-admin`, `puppeteer` فقط
   • لازم تضيف: `axios`

═══════════════════════════════════════════════════════════
## 🎯 المطلوب

المستخدم يقدر:
1. يختار provider: **Stape** / **Google Cloud Run** / **Self-Hosted**
2. يدخل sGTM URL + Access Tokens لكل منصة
3. يعمل Test Event حقيقي قبل Save
4. يحصل على GTM Container JSON فيه `transport_url` على tags GA4
   ⚠️ هذا أهم نقطة — الـ Container المُصدَّر لازم يعكس إعدادات SS

═══════════════════════════════════════════════════════════
## 🏗️ Architecture

### Provider Strategy
```
StapeProvider       — Real API integration (لو الـ API documented)
GoogleCloudProvider — Guided stub: returns instructions JSON, مفيش deploy فعلي
SelfHostedProvider  — Passive: validateUrl + sendTestEvent بس
```

⚠️ ممنوع تستورد `@google-cloud/run` — مفيش GCP creds في الـ backend.
⚠️ Stape: قبل ما تكتب الكود، اعمل WebFetch على docs بتاعهم وأكّدلي:
   - endpoint للـ container creation
   - auth method (Bearer token / X-API-Key)
   - response shape
   لو الـ API مش متاحة publicly، حوّل Stape لـ guided زي GCP واسألني.

### Auth Strategy (Important)
السيرفر مفيهوش Firebase Auth verification حالياً. هتبع نفس pattern
الموجود: `X-Client-Id` header. لكن:
- ضيف TODO comment فوق كل /api/ss/* route:
  `// TODO(security): harden with Firebase ID token verification`
- وثّق في docs/SERVER-SIDE-SETUP.md إن الـ deployment يتطلب trust
  في الـ network layer
- Rate limit أعلى (lockout) لو نفس clientId جاب 5 errors متتالية

### Constraints
- مفيش Express — vanilla `http.createServer` فقط
- مفيش `@google-cloud/run`
- مفيش Joi — manual validation بدلها
- مفيش Jest — استخدم `node --test` (built-in 18+)
- لا tokens في console / logs / responses أبداً
- Firestore + AES-256-GCM فقط لتخزين tokens
- existing Pixel Config Generator flow لازم يفضل شغّال 100% لو SS disabled
- RTL UI + استخدم CSS vars الموجودة فقط: `--acc`, `--bdr`, `--bdr2`,
  `--sur`, `--sur2`, `--wht`, `--wht2`, `--mut` (مفيش `--bg2` ولا `--bdr3`)

═══════════════════════════════════════════════════════════
## 📁 File Structure

```
NEW  /lib/crypto-vault.js              ← AES-256-GCM (Node built-in crypto)
NEW  /lib/ss-rate-limiter.js           ← Map-based, 100/min per clientId
                                          + setInterval cleanup كل دقيقة
NEW  /lib/providers/base.js            ← abstract + withRetry + validateUrl
NEW  /lib/providers/stape.js           ← real OR guided (depends on API)
NEW  /lib/providers/gcloud.js          ← guided stub: instructions JSON
NEW  /lib/providers/selfhosted.js      ← passive validator
NEW  /tests/crypto-vault.test.js       ← node --test runner
NEW  /docs/SERVER-SIDE-SETUP.md        ← deployment guides
MOD  /firestore-service.js             ← +saveSSConfig +getSSConfig +deleteSSConfig
MOD  /server.js                        ← +9 routes /api/ss/*
MOD  /tool.html                        ← Container Generator + UI Wizard
MOD  /package.json                     ← +"axios": "^1.7.0"
MOD  /.env.example                     ← +MASTER_ENCRYPTION_KEY (64 hex)
```

═══════════════════════════════════════════════════════════
## 🔌 Backend Routes (`/api/ss/*`)

كلها تستخدم `X-Client-Id` header + ss-rate-limiter:

```
POST   /api/ss/validate-url        → axios HEAD → {valid, latencyMs, version}
POST   /api/ss/save-config         → encrypt tokens → Firestore
GET    /api/ss/config              → return config (tokens redacted as "***")
POST   /api/ss/test-event          → POST to sGTM → {ok, status, ms}
POST   /api/ss/deploy-stape        → StapeProvider.deployContainer()
GET    /api/ss/gcp-instructions    → GCPProvider.deployContainer() → JSON guide
POST   /api/ss/gcp-confirm-url     → validateUrl(userPastedUrl)
DELETE /api/ss/config              → deleteSSConfig
GET    /api/ss/health              → getContainerStatus
```

═══════════════════════════════════════════════════════════
## 🗄️ Firestore Schema

```
Collection: ss_configs
Doc ID:     {clientId}
Fields:
  provider:        'stape' | 'gcloud' | 'selfhosted'
  serverUrl:       string
  platforms:       string[]
  encryptedTokens: { meta?, tiktok?, snapchat?, ga4?, mixpanel? }
                   كل واحدة: { ciphertext, iv, authTag } hex strings
  stapeApiKey:     { ciphertext, iv, authTag } | null
  createdAt, updatedAt: Timestamp
```

═══════════════════════════════════════════════════════════
## 🎨 UI Wizard (4 Steps)

```
① Provider (radio cards)  →  ② URL/Instructions  →  ③ Platforms+Tokens  →  ④ Test+Deploy
```

- Step 1: 3 cards (Stape/GCP/Self-hosted) — cards style زي platform selection الموجود
- Step 2:
  • Stape/Self-hosted: URL input + "اختبار الاتصال" button
  • GCP: panel فيه steps مع copy buttons + console deeplinks + URL paste في الآخر
- Step 3: لكل منصة toggle + token field + tooltip لينك للـ docs الرسمية
- Step 4: "إرسال Test Event" button + status badge (ok/fail + ms)
  ثم "حفظ وتفعيل" button

⚠️ SS disabled = الـ wizard مايظهرش + Container المولّد ما فيهوش transport_url

═══════════════════════════════════════════════════════════
## 🔥 CRITICAL: GTM Container Generator Integration

هذا أهم جزء — مش بس runtime engine. لما SS مفعّل:

### في `generate()` (سطر ~5880 tool.html):

1. **GA4 tags (type='gaawe')**: ضيف parameter جديد:
   ```js
   { type: 'TEMPLATE', key: 'serverContainerUrl', value: S.ssUrl }
   ```

2. **Meta/TikTok/Snap HTML tags**: في الـ HTML template، ضيف بعد
   الـ pixel call (fbq/ttq/snaptr) fetch ثاني للـ sGTM endpoint:
   ```js
   fetch('https://sgtm-url/collect', {
     method: 'POST',
     headers: {'Content-Type':'application/json'},
     body: JSON.stringify({event_id, user_data, ...})
   });
   ```

3. **Cookie للـ ET Engine**: في GTM Container ضيف cookie variable
   `et_ss_url` بقيمة الـ sGTM URL، عشان buildPlatformPayload() يقدر يقراه.

### في ET Engine (سطر 12849+):
ضيف لـ ET global object:
```js
ssEnabled: false,
ssUrl: ''
```

ضيف في buildPlatformPayload() قبل return:
```js
if (window.ET.ssEnabled && window.ET.ssUrl) {
  payload.transport_url = window.ET.ssUrl + '/g/collect';
  payload.ss_user_data  = getUserData(); // already hashed
}
```

═══════════════════════════════════════════════════════════
## ✅ Acceptance Criteria

- [ ] مفيش "Soon"/"Coming" في tool.html (خصوصاً الـ 3 مواقع المذكورة)
- [ ] الـ wizard بيشتغل end-to-end للـ 3 providers
- [ ] Stape: API call حقيقي (لو الـ API متاحة) أو guided fallback
- [ ] GCP: instructions JSON صح + URL paste flow بيشتغل
- [ ] Test Event يرجع status + response time خلال < 5 ثواني
- [ ] tokens مش بتظهر في DevTools network responses (redacted)
- [ ] Generated Container JSON فيه `transport_url` على GA4 tags لما SS مفعّل
- [ ] Generated Container JSON بدون `transport_url` لما SS معطّل
- [ ] `node --check` نظيف لكل ملفات JS الجديدة + server.js
- [ ] `node --test tests/crypto-vault.test.js` يعدّي
- [ ] existing Pixel Config flow شغّال بدون SS (regression test)
- [ ] Rate limiter: 101st request في الدقيقة → 429
- [ ] لا `console.log` فيها token (تأكّد بـ grep)

═══════════════════════════════════════════════════════════
## 🧪 Verification

```bash
node --check server.js
node --check lib/providers/*.js lib/*.js
node --test tests/
grep -rE "console\.(log|error|warn).*token" lib/ server.js  # لازم empty
npm install && npm start  # port 8080 يقوم بدون errors
```

═══════════════════════════════════════════════════════════
## 🚀 Execution Order

1. **WebFetch Stape API docs** → قول لي النتيجة قبل ما تكمل
2. `lib/crypto-vault.js` + tests
3. `lib/ss-rate-limiter.js`
4. `lib/providers/` (base → stape → gcloud → selfhosted)
5. `firestore-service.js` additions
6. `server.js` routes
7. `tool.html` — **ابدأ بـ Container Generator integration قبل الـ Wizard UI**
8. `docs/`, `package.json`, `.env.example`

═══════════════════════════════════════════════════════════
## 📋 Implementation Plan First

قبل ما تكتب أي كود:
1. اقرأ الملفات
2. ابعتلي خطة implementation فيها:
   - نتيجة Stape API research
   - أي اكتشافات جديدة من الكود مش متضمّنة فوق
   - الترتيب اللي هتنفّذ بيه
3. استنّى موافقتي قبل ما تبدأ التنفيذ

═══════════════════════════════════════════════════════════
## 📝 Manual Steps للمستخدم

1. توليد المفتاح:
   `node -e "require('crypto').randomBytes(32).toString('hex')"`
   ثم ضعه في `.env` كـ `MASTER_ENCRYPTION_KEY=...`
2. لـ Stape: API key من dashboard
3. لـ GCP: تنفيذ gcloud commands يدوياً (التعليمات في الـ UI)
4. `npm install` بعد إضافة axios
