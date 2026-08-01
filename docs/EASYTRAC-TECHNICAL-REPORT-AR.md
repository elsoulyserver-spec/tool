# تقرير تقني شامل — أداة EasyTrac (Easy Track)

> **التاريخ:** 2026-06-20  
> **الفرع وقت كتابة التقرير:** `fix/sgtm-container-import`  
> **مصدر التقرير:** قراءة مباشرة للكود (`server.js`, `gtm-service.js`, `tool.html`, `lib/**`, ملفات النشر)  
> **مستوى الثقة:** كل نقطة فنية مربوطة بـ `ملف:سطر`. اللي مبني على استنتاج مكتوب صراحةً.

---

## 0. الملخص التنفيذي (TL;DR)

**EasyTrac** أداة تجهيز تتبّع (tracking) لأصحاب المواقع: بتولّد إعدادات Pixel/GTM، بتسكان الموقع، والأهم — بتعمل **provisioning تلقائي لحاويات Google Tag Manager** (Web + Server) على حساب GTM مُدار، وتنشرها على Stape وتربطها ببعض.

أهم 4 نتائج لازم تاخد بالك منها:

| # | النتيجة | الأثر | الأولوية |
|---|---------|-------|----------|
| 1 | **الـ `serverConfigJson` الغني اللي الـ frontend بيبنيه بيتـ"دروب" في الباك-إند افتراضياً.** الحاوية السيرفرية المُدارة بتطلع **GA4-only من غير أي CAPI** (Meta/TikTok/Snap) إلا لو الـ feature flag مفعّل + bucket متظبط. | العميل بياخد حاوية سيرفر ناقصة الوظيفة الأساسية اللي اتباعتله عليها | 🔴 P0 |
| 2 | **خط أنابيب الـ CAPI في `lib/server-side/*` كله dead code وقت التشغيل** — `server.js` مش بيعمله `require` أصلاً. إطلاق أحداث الـ CAPI الحقيقي مفروض يحصل **جوه حاوية sGTM المنشورة**، مش من الـ Node app. | كود كتير موجود ومش بيشتغل؛ متغيرات `ET_*` كلها للـ pipeline الميت | 🟠 P1 |
| 3 | **الموقع `tool.easytrac.io` واقف على صفحة تحقّق Cloudflare/Railway** ("Checking your browser") والتحقق بيفشل. دي مشكلة بنية تحتية (edge بتاع Railway)، **مش في الكود**. | المستخدمين ممكن يتبلكوا عن الدخول | 🟠 P1 |
| 4 | **تعارض في إعداد البناء:** `railway.json` بيفرض `NIXPACKS`، فالـ `Dockerfile` المعدّل على الفرع الحالي **مش بيتطبّق على Railway**. | أي إصلاح في الـ Dockerfile مش هيوصل للإنتاج | 🟡 P2 |

---

## 1. إيه هو التول ووظيفته

الاسم في `package.json`: *"Easy Track — Pixel Config Generator & Website Tracking Scanner"* (إصدار 2.0.0).

ثلاث وظائف رئيسية:

1. **مولّد إعدادات Pixel + باني حاويات GTM** — الواجهة الضخمة `tool.html` (SPA من ملف واحد، ~11,600 سطر) بتسمح للمستخدم يختار المنصات (Meta/TikTok/Snap/Google Ads/GA4) والأحداث، وتبني JSON كامل لحاوية GTM.
2. **Managed Provisioning** — بدل ما المستخدم يعمل كل ده بإيده، الباك-إند بينشئ حاويات GTM فعلية على **حساب GTM مملوك للمنصة**، وينشر السيرفر على Stape، ويبعت دعوة للمستخدم على إيميله.
3. **Website Tracking Scanner** — `POST /api/scan-url` بيفحص أي موقع ويستخرج البكسلات الموجودة (Puppeteer مع fallback لـ HTTP عادي).

الواجهات: `index.html` (لاندنج)، `tool.html` (الأداة)، `admin.html` (لوحة أدمن).

---

## 2. المعمارية الحقيقية

### 2.1 المكوّنات

| الطبقة | الملف/الخدمة | الدور |
|--------|--------------|-------|
| Frontend | `tool.html` | SPA كامل؛ بيبني الـ GTM configs (web + server) ويـ POST للباك-إند |
| HTTP Server | `server.js` (~2,460 سطر، Node خام بدون framework) | راوتنج، scan، managed provisioning، endpoints الـ SS، الأدمن |
| GTM API | `gtm-service.js` | كل تعاملات GTM API v2 (إنشاء/استيراد/نشر/دعوة/transport_url) |
| Persistence | `firestore-service.js` | Firestore: العملاء، الحاويات، الـ jobs، إعدادات SS |
| تشفير | `lib/crypto-vault.js` | AES-256-GCM لتوكنات الـ CAPI (`MASTER_ENCRYPTION_KEY`) |
| نشر sGTM | `lib/providers/{stape,gcloud,selfhosted}.js` | نشر الحاوية السيرفرية على مزوّد |
| staging | `lib/config-blob-store.js` | رفع الـ serverConfig المؤقت على GCS (`PROVISIONING_BUCKET`) |
| jobs | `lib/cloud-tasks.js` | enqueue على Cloud Tasks (لو على GCP) |
| **CAPI pipeline** | **`lib/server-side/*`** | **⚠️ غير مستخدَم وقت التشغيل — انظر §7.2** |

### 2.2 النقطة الجوهرية: الـ Node app = "موفِّر" (Provisioner) مش "معالِج أحداث"

ده أهم مفهوم في المعمارية كلها:

```
المتصفح ──► حاوية GTM الـ Web (GA4 Config + transport_url)
                   │
                   ▼
        حاوية sGTM المنشورة على Stape  ◄── هنا الأحداث بتتطلق فعلياً (Meta/TikTok/Snap CAPI)
                   │                         عن طريق الـ customTemplate tags
                   ▼
            منصّات الإعلانات (CAPI)

الـ Node app (server.js على Railway)  ──►  بيـ"جهّز" الحاويات دي مرة واحدة وقت الإنشاء.
                                            بعد كده مش بيشوف ولا حدث تتبّع واحد.
```

الـ runtime لإطلاق الأحداث بيعيش **جوه حاوية sGTM**، مش في الـ Node app. الـ Node app دوره ينشئ ويربط الحاويات وخلاص. (التأكيد: `server.js` مفيش فيه أي `require('./lib/server-side/...')` — شوف §7.2).

---

## 3. رحلة الإنشاء (Managed Provisioning Flow)

نقطة الدخول: `POST /api/managed/create-container` (`server.js:1526`).

```
1. الـ frontend (tool.html) يبني serverConfigJson عن طريق buildSSContainer()   [tool.html:11562]
   فيه: GA4 Client + customEvent triggers + customTemplate[] لكل منصات الـ CAPI  [tool.html:7850]

2. POST /api/managed/create-container { configJson, serverConfigJson, mode, ... }

3. الباك-إند:
   - يتحقق إن GTM + Firestore متظبطين                                            [server.js:1533]
   - ⚠️ يـ stage الـ serverConfigJson على GCS فقط لو:                            [server.js:1571]
        mode==='client_server' && serverConfigJson && _serverConfigImportEnabled()
     (يعني الـ flag MANAGED_IMPORT_SERVER_CONFIG لازم يكون شغّال + bucket متظبط)
   - يحفظ job doc في Firestore، ويرجّع 202 + jobId فوراً                          [server.js:1613]

4. الـ worker في الخلفية (_runManagedProvisionJob)                               [server.js:230]
   - capacity check (سقف 490/500 حاوية)                                          [server.js:258]
   - يحمّل الـ serverConfig المرحّل لو موجود ref فقط                              [server.js:284]
   - gtmService.provisionForClientWithServer(): web + server containers          [gtm-service.js:587]
   - يحفظ الحاوية في Firestore                                                   [server.js:316]
   - ينشر على Stape تلقائياً (لو STAPE_API_KEY موجود)                            [server.js:357]
   - يربط transport_url للـ GA4 في حاوية الـ web وينشرها live                    [server.js:384]

5. الـ frontend يـ poll: GET /api/managed/job/:jobId لحد status==='completed'    [server.js:1621]
```

**التشغيل على Railway تحديداً:** `_dispatchProvisionJob` (`server.js:592`) لو Cloud Tasks مش متظبط (وهو مش متظبط على Railway) بيشغّل الشغل **in-process** بـ `Promise.resolve().then(...)` بعد الـ 202 (fire-and-forget). ده شغّال تمام على Railway لأنها مبتعملش CPU throttling بعد الرد — على عكس Cloud Run (شوف §7.5).

---

## 4. الـ API Surface

| Method | Path | الوظيفة | الحماية |
|--------|------|---------|---------|
| POST | `/api/scan-url` | فحص بكسلات موقع | — |
| POST | `/api/gtm/import` | استيراد JSON لحاوية | — |
| GET | `/api/managed/health` | جاهزية GTM/Firestore + السعة | — |
| POST | `/api/managed/create-container` | بدء provisioning (202 + jobId) | — |
| GET | `/api/managed/job/:id` | poll حالة الـ job | id عشوائي غير قابل للتخمين |
| GET | `/api/managed/container/:publicId` | بيانات حاوية | — |
| GET | `/api/managed/client/:clientId` | حاويات عميل | — |
| POST | `/api/internal/run-provision-job` | راوت الـ Cloud Tasks worker | `INTERNAL_WORKER_SECRET` |
| `/api/ss/*` | متعدد | تدفّق الإعداد السيرفري (wire-transport…) | Firebase ID token |
| GET/POST/DELETE | `/api/admin/*` | export/إدارة عملاء | `ADMIN_TOKEN` (bearer، مقارنة ثابتة الزمن) |

---

## 5. التخزين والأمان

- **Firestore** (`firestore-service.js`): مجموعات للعملاء، الحاويات، `provisioning_jobs` (مع TTL على `expiresAt`)، وإعدادات الـ SS.
- **حالة الـ Job في Firestore مش في الذاكرة** عمداً — عشان أي instance يقدر يرد على الـ poll (مهم لـ `max-instances > 1`).
- **التوكنات** متشفّرة AES-256-GCM في `crypto-vault.js` (مفتاح `MASTER_ENCRYPTION_KEY`).
- **الـ serverConfig المرحّل** سرّي (بيحوي توكنات CAPI) — بيتمسح فور وصول الـ job لحالة نهائية (`server.js:472`)، والـ bucket TTL هو خط الدفاع الأخير.
- **مفتاح Stape** اعتماد منصّة (`STAPE_API_KEY`)، العميل عمره ما يشوفه.

---

## 6. النشر والتشغيل + متغيّرات البيئة

**المنصّة:** Railway (الدليل: الـ footer `railway-hikari/cdg1.e9jw` في الـ screenshot + `railway.json`).  
**البناء:** `railway.json` → `NIXPACKS`، أمر التشغيل `node server.js`، إعادة تشغيل عند الفشل 3 مرات.

### متغيّرات البيئة المطلوبة (للمسار الحقيقي على Railway)

| المتغيّر | لـ | إلزامي؟ |
|----------|-----|---------|
| `GTM_SA_KEY_JSON` | حساب خدمة GTM | ✅ للـ provisioning |
| `GTM_ACCOUNT_ID` | حساب GTM المُدار | ✅ |
| `FIREBASE_SA_KEY_JSON` | Firestore | ✅ |
| `MASTER_ENCRYPTION_KEY` | تشفير التوكنات | ✅ للـ SS |
| `STAPE_API_KEY` / `STAPE_REGION` | نشر sGTM تلقائي | لو عايز auto-deploy |
| `MANAGED_IMPORT_SERVER_CONFIG` | **الـ flag بتاع §7.1** | ⚠️ مطفّي افتراضياً |
| `PROVISIONING_BUCKET` | staging الـ serverConfig على GCS | لازم مع الـ flag |
| `ADMIN_TOKEN` | endpoints الأدمن | لو هتستخدمها |
| `ALLOWED_ORIGIN` | CORS | اختياري (افتراضي `*`) |
| `INTERNAL_WORKER_SECRET` | راوت Cloud Tasks | على GCP بس |
| `ALLOW_DRY_RUN` | محاكاة بدون GTM فعلي | تطوير فقط |

> **ملاحظة:** كل متغيّرات `ET_*` (زي `ET_META_CAPI_TOKEN`...) موجودة **حصرياً** في `lib/server-side/config-manager.js` — يعني تخصّ الـ pipeline الميت (§7.2). لو حد ظبّطها متوقّع إن الـ CAPI يتطلق من الـ Node app، مش هيحصل.

---

## 7. الفجوات والمشاكل المعروفة (مرتّبة بالأولوية)

### 🔴 7.1 — P0: الـ `serverConfigJson` بيتـدروب → الحاوية السيرفرية GA4-only

ده أخطر فرق بين "اللي الأداة بتوعد بيه" و"اللي بيحصل فعلاً".

- الـ frontend **بيبني config سيرفري كامل** فيه كل منصات الـ CAPI كـ `customTemplate[]` ويبعته (`tool.html:7850`, `tool.html:11601`).
- الباك-إند بيرحّله لـ GTM **فقط** لو الشرط ده اتحقق (`server.js:1571`):
  ```js
  !dryRun && mode === 'client_server' && serverConfigJson && _serverConfigImportEnabled()
  ```
  و `_serverConfigImportEnabled()` = `MANAGED_IMPORT_SERVER_CONFIG ∈ {1, true}` (`server.js:121`)، **مطفّي افتراضياً**.
- لو الـ flag مطفّي (أو الـ bucket مش متظبط، أو الـ guard رفض الـ config): الـ worker يروح للـ **static fallback** (`gtm-service.js:651`) اللي بيستورد `lib/sgtm-default-config.json`.
- محتوى الـ static config: GA4 Measurement ID variable + "All Pages" trigger + "GA4 — Forward to Google" (نوع `sgtmgaaw`) + "GA4 Client" — **مفيش ولا تاج CAPI واحد، ولا customTemplate**.

**النتيجة:** في الوضع الافتراضي، العميل ياخد حاوية سيرفر بتعمل forward لـ GA4 بس — من غير Meta/TikTok/Snap CAPI، اللي هي غالباً السبب الأساسي اللي جابه للأداة.

**الحل:** فعّل `MANAGED_IMPORT_SERVER_CONFIG=1` + ظبّط `PROVISIONING_BUCKET` على بيئة بها GCS، وتأكد إن الـ guard (`_validateServerConfig`, `server.js:129`) بيعدّي الـ config. ولو ده هو السلوك المقصود دايماً → اعمله الافتراضي بدل ما يكون خلف flag.

### 🟠 7.2 — P1: خط أنابيب CAPI كامل = dead code وقت التشغيل

- المجلد `lib/server-side/` فيه: `event-dispatcher.js`, `payload-builder.js`, `capi-senders/{meta,tiktok,snapchat,google-ads}.js`, `retry-queue.js`, `event-enricher.js`, `config-manager.js`... كله مكتوب كأنه بيستقبل أحداث ويبعتها للمنصّات.
- **بس `server.js` مبيعملش `require` لأي حاجة منهم** (الـ requires كلها: `gtm-service`, `firestore-service`, `crypto-vault`, `ss-rate-limiter`, `providers/*`, `cloud-tasks`, `config-blob-store` — `server.js:48-66`).
- ده **مقصود معمارياً** مش باگ: إطلاق الـ CAPI الحقيقي بيحصل جوه حاوية sGTM (§2.2). بس الكود ده ممكن يخدع أي حد يفكّره runtime شغّال.

**الحل/التوصية:** يا إما يتوثّق بوضوح كـ "reference implementation / مش متشغّل"، أو يتنقل لمجلد منفصل (مثلاً `reference/`) عشان ميـلخبطش الصورة، أو يتشال لو فعلاً مش مستخدم.

### 🟠 7.3 — P1: صفحة تحقّق Cloudflare/Railway بتبلك الوصول

- اللي ظهر في الـ screenshot ("Checking your browser" / "Trouble verifying you — retrying") **مش من الكود** (البحث في الريبو كله ملقاش النص).
- دي حماية الـ edge بتاعة Railway (Cloudflare Turnstile)، بتتفعّل لما Railway يحس بـ traffic عالي/مشبوه.
- "Trouble verifying" غالباً سببها client-side: ad-block/privacy extension بيبلك `challenges.cloudflare.com`، third-party cookies مقفولة، متصفح قديم، أو VPN.

**الحل الفوري:** حدّث المتصفح، جرّب incognito من غير إضافات، اسمح بالـ cookies. **لو بيظهر لكل الزوار:** راجع Railway dashboard/metrics + status.railway.app؛ ولو traffic حقيقي عالي، ضع Cloudflare بتاعك مع WAF قدّام الدومين للتحكّم بنفسك (مذكور في `docs/DEPLOYMENT-HARDENING.md:281`).

### 🟡 7.4 — P2: تعارض الـ Dockerfile مع NIXPACKS

- `railway.json` بيحدد `"builder": "NIXPACKS"` → Railway **بيتجاهل الـ `Dockerfile`**.
- الفرع الحالي `fix/sgtm-container-import` فيه `Dockerfile` معدّل (`M Dockerfile`) — التعديل ده **مش هيتطبّق على Railway** طول ما الـ builder NIXPACKS.

**الحل:** لو التعديل في الـ Dockerfile مقصود للإنتاج، غيّر الـ builder لـ `DOCKERFILE` في `railway.json`؛ غير كده الـ Dockerfile بيخص بس Cloud Run/VPS.

### 🟡 7.5 — P2: ملاحظة CPU throttling خاصة بـ Cloud Run (مش منطبقة على Railway)

- الشغل الثقيل بيتعمل بعد الـ 202. على **Cloud Run** الـ CPU بيتخنق لـ ~0 بعد الرد إلا مع `--no-cpu-throttling` أو Cloud Tasks (تحذير موثّق في `server.js:153`).
- على **Railway** ده مش مشكلة (مفيش throttling بعد الرد) — فالمسار الحالي شغّال. بس لو اتنقل لـ Cloud Run من غير Cloud Tasks، الـ jobs ممكن تتجمّد.

### 🟢 7.6 — P3: عدم idempotency

- كل تشغيل لـ job بينشئ حاويات GTM جديدة (مش idempotent). لو اتنقل لـ Cloud Tasks **لازم** `--max-attempts=1` عشان retry ميعملش حاويات مكررة (موثّق `server.js:226`).

---

## 8. التوصيات (مرتّبة بالأولوية)

1. **(P0)** قرّر سلوك الـ `serverConfigJson`: فعّل `MANAGED_IMPORT_SERVER_CONFIG=1` + `PROVISIONING_BUCKET`، أو خلّي الاستيراد الكامل هو الافتراضي. النهارده العميل بياخد حاوية سيرفر ناقصة الـ CAPI. **ده أهم إصلاح.**
2. **(P1)** ثبّت الوصول: اتأكد إن صفحة التحقّق دي بتظهرلك انت بس ولا لكل الزوار. لو للكل → Railway dashboard + فكّر في Cloudflare/WAF خاص بيك.
3. **(P1)** وضّح مصير `lib/server-side/*` (توثيق "مش متشغّل" أو نقل أو حذف) عشان ميـضلّلش.
4. **(P2)** احسم الـ Dockerfile vs NIXPACKS في `railway.json` عشان تعديلاتك توصل للإنتاج.
5. **(P2)** نظّف متغيّرات `ET_*` من التوثيق التشغيلي أو اربطها بوضوح بالـ reference pipeline.
6. **(تشغيلي)** ظبّط `--min-instances` و keep-alive حسب `docs/DEPLOYMENT-HARDENING.md` لو فيه أحداث شراء حسّاسة للـ cold start.

---

## ملحق أ — ملفّات يُرجَع إليها بسرعة

| الموضوع | الملف:السطر |
|---------|-------------|
| الـ feature flag | `server.js:121` |
| guard الـ serverConfig | `server.js:129` |
| worker الـ provisioning | `server.js:230` |
| نقطة دروب الـ serverConfig | `server.js:1571` |
| handler الـ create-container | `server.js:1526` |
| dispatch (in-process vs Cloud Tasks) | `server.js:592` |
| قرار الاستيراد (full vs static) | `gtm-service.js:630` |
| الـ static GA4-only config | `lib/sgtm-default-config.json` |
| باني الـ serverConfig في الـ frontend | `tool.html:11562` |
| تحذير Cloud Run CPU | `server.js:153` |
| الـ CAPI pipeline الميت | `lib/server-side/` |
