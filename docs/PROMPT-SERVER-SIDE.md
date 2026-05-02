# Mission: Build Production-Ready Server-Side Tracking for Easy Track

أنت Senior Tracking Engineer. مهمتك تبني Server-Side Tracking كامل في أداة Easy Track
بحيث تشيل status "Coming Soon" وتطلّع feature شغّال 100% production-ready.

═══════════════════════════════════════════════════════════
## 📂 Project Context (اقرأ الملفات دي قبل أي حاجة)

المشروع: Easy Track — Pixel Config Generator موجّه لمنصات سلة وزد.
بيولّد GTM Container JSON جاهز للـ import + بيعمل Direct Publish.

ملفات لازم تقراها بالترتيب ده:

1. `tool.html` (سطر 12849+ → ET Engine — DataLayer Normalizer)
   فيه: ET_PLATFORMS, ET_EVENT_MAP, normalizeSalla(), normalizeZid(),
   buildPlatformPayload(), dispatch(), _userIdentity, sha256, getUserData

2. `tool.html` (سطر 13391+ → SERVER-SIDE UI section)
   فيه placeholder UI: ssPlatforms, ss_initPlatformList, _ssPlatformConfig
   ⚠️ ده الـ UI الموجود حالياً وفاضي — لازم يتربط بـ backend

3. `server.js` (Node.js Express server — 47KB)
   فيه: Auth, Firestore, GTM publish endpoints
   لازم تضيف عليه الـ SS endpoints الجديدة

4. `gtm-service.js` (GTM API service — 20KB)
   فيه: createContainer, publishVersion, refreshAccessToken
   شوف pattern الـ JWT auth وطبّق نفسه

5. `firestore-service.js` و `package.json` لمعرفة الـ deps المتاحة

═══════════════════════════════════════════════════════════
## 🎯 Goal

خلّي خاصية Server-Side Tracking شغّالة بحيث المستخدم يقدر:

(a) يختار provider: **Stape** أو **Google Cloud Run** أو **Self-Hosted**
(b) يدخل URL تاع الـ sGTM container بتاعه + Container Config (CONFIG_BODY)
(c) يفعّل/يعطّل المنصات اللي عايز يبعتلها server-side: Meta CAPI · TikTok Events
    API · Snapchat CAPI · GA4 Measurement Protocol · Mixpanel Server-Side
(d) يدخل الـ Access Tokens لكل منصة (مشفّرة في Firestore)
(e) يعمل Test Connection و Send Test Event من الأداة قبل Deploy
(f) يحصل على generated GTM Container فيه Server Container Config + Client Tags
    معدّلة عشان تبعت لـ sGTM URL بتاعه (transport_url override)

═══════════════════════════════════════════════════════════
## 🏗️ Architecture Decisions

### Provider Strategy
عايز abstraction layer يدعم 3 providers — كل واحد ليه نموذج تشغيل مختلف:

```
ServerSideProvider (interface)
├─ StapeProvider       — FULL automation عبر Stape API
│                        (deploy container + manage URL + monitor health)
├─ GoogleCloudProvider — GUIDED stub (instructions-only)
│                        ⚠️ مفيش GCP credentials في الـ backend
│                        ⚠️ المستخدم بيعمل deploy يدوياً عبر Cloud Console أو gcloud
│                        ⚠️ بعدين بيـ paste الـ Cloud Run URL في الأداة
└─ SelfHostedProvider  — passive validator
                         user يدخل URL بتاعه، الأداة بتـ validate بس
```

كل provider بيوفّر:
- `deployContainer(config)` → returns serverUrl
   • Stape: يعمل API call حقيقي ويرجع URL
   • GCP:   يرجع `{ mode: 'guided', instructions: [...], cloudShellLink: '...' }`
   • Self-hosted: يرفض (`throw new Error('manual mode only')`)
- `validateUrl(url)` → returns {valid, latencyMs, version}   ← الـ 3 يدعموها
- `sendTestEvent(url, payload)` → returns {ok, response}      ← الـ 3 يدعموها
- `getContainerStatus(url)` → returns {healthy, requestCount24h}
   • Stape: real metrics من API
   • GCP/Self-hosted: HTTP HEAD + uptime check بس

### GCP Guided Provider — Specifics

ممنوع تخزّن GCP service account creds في الـ backend. بدل كده:

```
POST /api/ss/gcp-instructions
  → returns deployment guide:
    1. Enable Cloud Run API (gcloud services enable run.googleapis.com)
    2. Deploy command (gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable)
    3. Set CONFIG_BODY env var (user pastes from sGTM Admin)
    4. Create custom domain (سيناريو optional)
    5. Paste Cloud Run URL back into tool

العنصر الأخير: "I've deployed — here's my URL" input → 
  يـ trigger validateUrl() عشان يتأكد إن الـ URL شغّال فعلاً قبل save.
```

كل instruction step فيه:
- وصف عربي بسيط
- Copy-paste command (لو في)
- Screenshot link أو video link (optional)
- Link مباشر للـ Cloud Console مع الـ project pre-selected (deeplink)

### Data Flow

```
[Browser]
   ↓ user_data (hashed SHA-256)
   ↓ event_id (deduplication key)
   ↓ external_id (cookie)
[Web GTM Container]
   ↓ transport_url → sGTM URL
[Server GTM Container (Stape/GCP)]
   ↓ fans out to:
[Meta CAPI] [TikTok API] [Snap CAPI] [GA4 MP] [Mixpanel /import]
```

### Security Requirements
- Access tokens مخزّنة في Firestore بـ AES-256-GCM encryption (مفتاح في .env)
- API key per-user generated عشان البراوزر يكلّم الـ backend بأمان
- Rate limiting على /api/ss/* endpoints (max 100 req/min per user)
- HMAC signature على test event payloads
- لا تطبع access tokens في console أو logs أبداً

═══════════════════════════════════════════════════════════
## 📋 Detailed Requirements

### A. Frontend Changes (tool.html)

A1. **شيل "Coming Soon" badge** من قسم Server-Side Tracking في الـ UI
    موقعه: ابحث عن "ssPlatforms" container و"server-side" في tool.html

A2. **استبدل الـ placeholder UI** بـ wizard 4 steps:
   - Step 1: Choose Provider (Stape / GCP / Self-hosted) — radio cards
   - Step 2: Enter Server URL + validate latency live
   - Step 3: Enable platforms + paste Access Tokens — مع tooltip لكل token
            لينك مباشر للـ docs (Meta Business Manager, TikTok Events Manager, إلخ)
   - Step 4: Test & Deploy — button "Send Test Event" + status badge realtime

A3. **اعدّل buildPlatformPayload()** عشان يضيف:
   ```js
   if (window.ET.ssEnabled) {
     payload.transport_url = window.ET.ssUrl + '/g/collect';
     payload.ss_user_data = getUserData(); // hashed
   }
   ```

A4. **اعدّل GTM Container generator**: لو SS مفعّل، بدل tag الـ HTML العادي
    استخدم GTM tag type `gaawe` مع `serverContainerUrl` parameter لـ GA4 events،
    وللـ Meta/TikTok/Snap اعمل HTML tag بيبعت fetch لـ sGTM endpoint مباشرة.

### B. Backend Changes (server.js)

أضف routes جديدة كلها تحت prefix `/api/ss/*`:

```
POST   /api/ss/providers           → list available providers + features
POST   /api/ss/validate-url        → ping sGTM URL, check version + latency
POST   /api/ss/save-config         → encrypt + save tokens to Firestore
GET    /api/ss/config              → return user's SS config (tokens redacted)
POST   /api/ss/test-event          → send test event through sGTM, return trace
POST   /api/ss/deploy-stape        → call Stape API to provision container
GET    /api/ss/gcp-instructions    → return guided deployment steps (no API call)
POST   /api/ss/gcp-confirm-url     → user pastes deployed Cloud Run URL → validate
DELETE /api/ss/config              → wipe SS config
GET    /api/ss/health              → check sGTM uptime + 24h request count

⚠️ ملاحظة: مفيش `/api/ss/deploy-gcp` — الـ GCP provider guided/manual فقط.
   السبب: حماية الـ backend من تخزين GCP service account credentials.
```

كل route لازم:
- Auth via existing Firebase auth middleware
- Rate limit: 100/min per user (express-rate-limit)
- Input validation: Joi or zod schemas
- Error handling: try/catch + structured error responses
- Logging: winston/pino مع redaction للـ tokens

### C. Token Encryption (new file: lib/crypto-vault.js)

```
encrypt(plaintext, masterKey) → returns { ciphertext, iv, authTag }
decrypt(payload, masterKey)   → returns plaintext
rotateKey(oldKey, newKey)     → re-encrypts all stored tokens
```

استخدم Node built-in `crypto` module (AES-256-GCM، 12-byte IV، 16-byte auth tag).
ضيف `MASTER_ENCRYPTION_KEY` في `.env.example` بـ comment يقول لازم يكون 32 hex chars.

### D. Provider Adapters (new folder: /lib/providers/ at project root)

⚠️ مكان الـ folder: في root المشروع (جنب `server.js` و `gtm-service.js`)
   مش في src/ ولا app/ — المشروع flat structure.

ملف لكل provider:
- `/lib/providers/base.js`       — abstract class مع common methods
- `/lib/providers/stape.js`      — REAL API integration (https://stape.io/api)
- `/lib/providers/gcloud.js`     — GUIDED stub: يرجع instructions JSON بس
                                    ⚠️ ممنوع import @google-cloud/run هنا
                                    ⚠️ ممنوع تخزّن service account JSON
                                    ⚠️ deployContainer() يرجع instructions
- `/lib/providers/selfhosted.js` — passive validator (URL paste + ping)

كل provider class بيـ implement الـ interface المذكور فوق.
استخدم axios للـ HTTP calls. retry logic مع exponential backoff (3 attempts).

### gcloud.js Implementation Spec

```js
class GoogleCloudProvider extends BaseProvider {
  async deployContainer(config) {
    // ⚠️ guided mode — returns instructions, doesn't actually deploy
    return {
      mode: 'guided',
      provider: 'google-cloud-run',
      instructions: [
        {
          step: 1,
          title: 'تفعيل Cloud Run API',
          command: 'gcloud services enable run.googleapis.com',
          consoleUrl: 'https://console.cloud.google.com/apis/library/run.googleapis.com'
        },
        {
          step: 2,
          title: 'Deploy sGTM image على Cloud Run',
          command: `gcloud run deploy sgtm \\
  --image=gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable \\
  --platform=managed \\
  --region=me-central1 \\
  --allow-unauthenticated \\
  --set-env-vars=CONFIG_BODY=${config.configBody},CONTAINER_CONFIG=${config.containerConfig}`,
          notes: 'هتاخد ~3 دقائق. الناتج هيكون URL زي https://sgtm-xxx.run.app'
        },
        {
          step: 3,
          title: 'الصق الـ URL هنا',
          inputField: 'serverUrl',
          validation: 'https://*.run.app or custom domain'
        }
      ],
      cloudShellLink: 'https://shell.cloud.google.com/?show=terminal',
      estimatedTime: '5-10 minutes',
      cost: '~$0-5/month for low traffic (free tier)'
    };
  }

  async validateUrl(url) {
    // standard health check — same as base class
    return super.validateUrl(url);
  }
  // ... باقي الـ methods زي base
}
```

### E. Test Event Endpoint (الأهم)

`POST /api/ss/test-event` لازم يبعت test event حقيقي:

```js
{
  event_name: 'purchase',
  event_id: 'test_' + uuid(),
  user_data: { external_id: 'test_user', em: '<hashed>', ph: '<hashed>' },
  custom_data: { currency: 'SAR', value: 100, transaction_id: 'TEST_' + ts },
  test_event_code: 'TEST12345' // Meta-specific
}
```

ويرجّع response فيه:
- HTTP status من sGTM
- response time (ms)
- مؤشر هل وصل لـ Meta/TikTok/etc (لو الـ sGTM container بيعمل log forwarding)

### F. Documentation

أضف ملف `docs/SERVER-SIDE-SETUP.md` فيه:
- خطوات إنشاء Stape account + API key
- خطوات Google Cloud Run deployment (مع gcloud commands)
- Self-hosted setup مع Docker compose example
- Troubleshooting common errors

═══════════════════════════════════════════════════════════
## ✅ Acceptance Criteria

التعديلات تعتبر مكتملة لما كل النقط دي تتحقق:

- [ ] لما المستخدم يختار "Server-Side Tracking" مفيش كلمة "Soon" أو "Coming"
- [ ] الـ wizard بيشتغل end-to-end لكل provider من الـ 3
- [ ] Stape provider بيقدر يدبلواي container جديد عبر API call واحد
- [ ] GCP provider بيرجع instructions JSON صح (مفيش API call فعلي)
- [ ] GCP UI بيعرض الـ steps بشكل واضح مع copy buttons للـ commands
- [ ] بعد ما المستخدم يـ paste الـ Cloud Run URL، الـ validateUrl بيشتغل صح
- [ ] Test Event بيرجع status code + response time خلال أقل من 5 ثواني
- [ ] Access tokens مش بتتطبع في console / logs / network responses
- [ ] Generated GTM Container فيه `transport_url` صح في tags GA4
- [ ] `node --check` بيعدي على كل ملفات JS من غير syntax errors
- [ ] Unit tests لـ crypto-vault.js بتعدي (encrypt → decrypt round-trip)
- [ ] لو URL غلط الـ UI بيعرض رسالة عربية واضحة مش stack trace
- [ ] Rate limiter شغّال (test: 101st request في الدقيقة بيرجع 429)
- [ ] الـ existing functionality (Pixel Config Generator العادي) لسه شغّال

═══════════════════════════════════════════════════════════
## 🧪 Verification Steps

بعد ما تخلّص، نفّذ الخطوات دي بالترتيب:

1. `npm install` — لو ضيفت deps جديدة (axios, joi, express-rate-limit) لازم
   تتسجّل في package.json. ⚠️ ممنوع تضيف `@google-cloud/run` لأن GCP guided
   mode فقط بدون GCP SDK في الـ backend.

2. `node --check server.js` — لازم يعدّي بدون errors
3. `node --check lib/providers/*.js` — كلهم لازم يعدّوا
4. شغّل `npm start` ووتأكد إن الـ server بيقوم على port 8080 من غير errors
5. open `tool.html` في المتصفح وشوف الـ UI الجديد
6. جرّب الـ wizard كامل بـ Stape (لو عندك API key) أو Self-hosted (URL وهمي)
7. Open DevTools Network tab — تأكد إن مفيش access tokens في الـ responses
8. شغّل `grep -r "console.log.*token" lib/ server.js` — لازم يرجع فاضي
9. عمل commit واحد per logical change (provider adapter, encryption, UI, إلخ)

═══════════════════════════════════════════════════════════
## ⚠️ Constraints

- ممنوع تكسر أي functionality قائمة. الـ Pixel Config Generator العادي لازم
  يفضل شغّال 100% بدون SS مفعّل.
- ممنوع تستخدم localStorage لتخزين access tokens — بس Firestore + encryption.
- ممنوع تطبع tokens في أي مكان (لا في UI ولا في logs ولا في error messages).
- خلّي الـ UI عربي (RTL) ومتسق مع التصميم القائم — استخدم نفس CSS variables
  (--acc, --bdr, --bg2, إلخ) ونفس الفونتات (Cairo, JetBrains Mono).
- لو محتاج تضيف npm package جديد، استخدم versions مستقرة مش beta/alpha.
- اكتب الـ code بـ vanilla JS — مفيش TypeScript ولا React في المشروع ده.

═══════════════════════════════════════════════════════════
## 🚀 Output Expected

في النهاية اعطيني:
1. قائمة بكل الملفات اللي اتعدلت / اتضافت
2. Diff summary لكل تعديل كبير
3. خطوات يدوية لازمة من المستخدم (مثلاً: ضيف MASTER_ENCRYPTION_KEY في .env)
4. حالات failed/pending لو في حاجة معطّلة (مثلاً: GCP needs service account JSON)

ابدأ من قراءة الملفات اللي ذكرتها فوق، وبعدين اطّلع لي بـ implementation plan
قبل ما تبدأ تكتب أي كود — عشان نتفق على الـ approach الأول.
