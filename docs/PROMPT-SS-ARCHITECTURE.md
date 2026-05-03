# Server-Side Tracking Architecture — Build Prompt

## 🗂️ سياق المشروع (اقرأه أول حاجة)

أنت شغال على مشروع **EasyTrac** — أداة Tracking Setup مبنية بـ **Vanilla Node.js 18+ HTTP** (مفيش Express).

### الملفات الرئيسية
| الملف | الوصف |
|-------|-------|
| `server.js` | السيرفر الرئيسي — كل الـ API endpoints هنا (1759 سطر) |
| `tool.html` | الـ Frontend كاملة — Single HTML file (~14,000 سطر) |
| `lib/crypto-vault.js` | AES-256-GCM encryption للـ SS tokens |
| `lib/ss-rate-limiter.js` | Rate limiter للـ SS endpoints |
| `lib/providers/stape.js` | Stape.io provider |
| `lib/providers/gcloud.js` | Google Cloud Run provider |
| `lib/providers/selfhosted.js` | Self-hosted sGTM provider |
| `lib/providers/base.js` | Base class + SSRF guard |
| `gtm-service.js` | GTM API — إنشاء وإدارة Containers |
| `firestore-service.js` | Firestore — حفظ Client data + SS configs |

### الـ Stack
- **Backend:** Node.js 18+ HTTP (بدون Express)
- **Database:** Firestore (Firebase Admin SDK)
- **Scanner:** Puppeteer (headless Chrome)
- **HTTP client:** axios
- **Workspace:** `C:\Users\Yousef\Downloads\easytrac.io-main\easytrac.io-main`
- **Repo:** `https://github.com/youssefelsoulyaccess-hash/easytrac.io`
- **Deploy:** Railway

### Endpoints المهمة الموجودة
| Endpoint | الوظيفة |
|----------|---------|
| `POST /api/managed/create-container` | ينشئ Web + Server GTM Containers (`mode: "client_server"`) |
| `POST /api/ss/save-config` | يحفظ SS config مع تشفير الـ tokens |
| `POST /api/ss/validate-url` | يتحقق من sGTM URL |
| `POST /api/ss/test-event` | يبعت test event للسيرفر |
| `POST /api/ss/wire-transport` | يربط Web Container بـ sGTM URL |
| `GET /api/ss/config` | يرجع SS config للعميل (tokens مخفية) |

### حالة الـ Auth
- الـ `/api/ss/*` endpoints محمية بـ **Firebase ID Token** (`Authorization: Bearer <token>`)
- الـ Token بيتـ verify بـ `firebase-admin.auth().verifyIdToken()`
- الـ `uid` من الـ token هو الـ `clientId`

---

## الهدف العام
بناء فلو واضح ومتكامل للـ Server-Side Tracking داخل أداة EasyTrac بحيث يمر العميل بخطوات منطقية تنتهي بـ **GTM Container للـ Web + GTM Container للـ Server** كلاهما مترابطان ومضبوطان بشكل صحيح.

---

## أولاً: الـ Overview (أول ما يفتح التول)

في الـ Overview Section اللي بتظهر في أعلى الأداة، **لازم دايماً يتعرض**:

### 📦 GTM Snippets المثبتة
| النوع | الحالة | الكود |
|-------|--------|-------|
| **Web GTM** (Client-Side) | 🟢 مثبت / 🔴 غير مثبت | `GTM-XXXXXXX` |
| **Server GTM** (Server-Side) | 🟢 مثبت / 🔴 غير مثبت | `GTM-SXXXXXXX` |

### 📊 المنصات الإعلانية والتحليلية الشغالة
عرض كل منصة شغالة مع نوعها:
- ✅ **Meta Pixel** — Client-Side / Server-Side
- ✅ **GA4** — Client-Side (Data Layer)
- ✅ **Google Ads** — Client-Side فقط
- ✅ **TikTok** — Server-Side
- إلخ...

> **الهدف:** العميل يفهم دفعة واحدة إيه اللي شغال وفين.

---

## ثانياً: فلو إعداد الـ Server-Side Tracking

### الخطوة 1 — إنشاء Server Container Config

```
[زر: إنشاء Server Container]
```

الأداة تعمل **GTM Server Container** وتطلع للعميل الـ Container Config بالشكل ده:

```
✅ تم إنشاء الـ Server Container بنجاح!

Container Config الخاص بك:
┌─────────────────────────────────────────────────────┐
│  {"gtm_preview":"env-XX","gtm_auth":"XXXX",...}     │
└─────────────────────────────────────────────────────┘

📋 انسخ الكود ده وروح على:
Google Tag Manager → Admin → Install Google Tag Manager
واختار "Manually provision tagging server"
والصق الـ Container Config في الحقل المخصص.
```

---

### الخطوة 2 — العميل يحط Server URL

بعد ما العميل ينشر الـ sGTM Container على Stape / Cloud Run / Docker:

```
أدخل Server URL الخاص بك:
[ https://your-sgtm-server.com        ] [تحقق ✓]
```

الأداة تتحقق إن الـ URL شغال وبيرد بـ 200 قبل تكمل.

---

### الخطوة 3 — اختيار منصات الـ Server-Side

```
اختار المنصات اللي هتشتغل على السيرفر:

☑ Meta CAPI          ☑ TikTok Events API
☑ Snapchat CAPI      ☐ LinkedIn CAPI
☐ Twitter CAPI
```

> ⚠️ **تنبيه مهم يظهر للعميل:**
> كل Request على السيرفر بيكلف — اختار الـ Events بحكمة.
> **Purchase هو الأهم** لأنه أعلى قيمة مقابل تكلفة الـ Request.

---

### الخطوة 4 — اختيار Events للـ Server-Side

```
اختار الـ Events اللي هتتبعت على السيرفر:

⭐ [Purchase]     ← موصى به بشدة (أعلى ROI)
☑  [AddToCart]
☐  [ViewContent]
☐  [InitiateCheckout]
☐  [Lead]
☐  [PageView]    ← تجنبه على السيرفر (تكلفة عالية، قيمة منخفضة)
```

---

### الخطوة 5 — إعداد Client-Side (Web GTM)

#### 5A — GA4 Measurement ID الجديد

```
⚠️ مهم: لازم تنشئ GA4 Property جديدة مخصصة للـ Server-Side.
ده هيكون الـ Data Layer اللي بيجمع الداتا وبيبعتها للسيرفر.

أدخل GA4 Measurement ID:
[ G-XXXXXXXXXX ]

💡 ليه تعمل واحدة جديدة؟
لأن الـ sGTM هيستقبل الداتا من GA4 ويوزعها على المنصات،
وعشان كده محتاج GA4 Property نظيفة مخصوصة للسيرفر.
```

#### 5B — منصات الـ Client-Side

```
اختار المنصات اللي هتشتغل على الـ Web (Client-Side):

☑ Google Ads (Conversion Tracking)
☑ GA4 (Data Layer → sGTM)
☐ Microsoft Ads
☐ Pinterest
```

> 🚨 **قاعدة صارمة — لا تخلط Google Ads بـ GA4:**
>
> - **Google Ads** = Conversion Tags مستقلة بالكامل
>   - بتتبع: Purchase, Lead, SignUp فقط
>   - **لا تستخدم** GA4 Events كـ trigger لـ Google Ads
>   - كل Conversion Action عندها Tag مستقل
>
> - **GA4** = Data Layer بيبعت كل الـ Events للسيرفر
>   - بيشتغل كـ transport layer بس
>   - **لا تحط** GA4 Tag في نفس الـ Trigger بتاع Google Ads

#### 5C — Events للـ Client-Side

```
اختار Events الـ Client-Side:

Google Ads Events:
☑ Purchase (Conversion)
☑ Lead (Conversion)
☐ SignUp (Conversion)

GA4 Events (Data Layer):
☑ purchase
☑ add_to_cart
☑ view_item
☑ begin_checkout
☑ page_view
```

---

### الخطوة 6 — مراجعة وتأكيد

```
📋 ملخص الإعداد:

Server-Side (sGTM):
  URL: https://your-sgtm-server.com ✅
  المنصات: Meta CAPI, TikTok Events API
  Events: Purchase, AddToCart

Client-Side (Web GTM):
  Web GTM ID: GTM-XXXXXXX
  Server GTM ID: GTM-SXXXXXXX
  GA4 ID: G-XXXXXXXXXX
  Google Ads: Conversion Tags مستقلة (Purchase, Lead)

[تأكيد وإنشاء الـ Containers ✓]
```

---

### النتيجة النهائية

بعد التأكيد، الأداة تعمل:

1. ✅ **Web GTM Container** يحتوي على:
   - GA4 Configuration Tag (مع transport_url → sGTM)
   - GA4 Event Tags (purchase, add_to_cart, ...)
   - Google Ads Conversion Tags (مستقلة تماماً)
   - DataLayer Variables

2. ✅ **Server GTM Container** يحتوي على:
   - GA4 Client (يستقبل من Web GTM)
   - Meta CAPI Tag
   - TikTok Events API Tag
   - Triggers للـ Events المختارة

3. ✅ **Snippet Section تتحدث** في الـ Overview:
   - يظهر كود Web GTM للـ `<head>` و `<body>`
   - يظهر Container Config للـ Server GTM
   - حالة كل منصة

---

## ثالثاً: قواعد عامة لا تُكسر

| القاعدة | التفاصيل |
|---------|----------|
| **Google Ads مستقل** | لا Triggers مشتركة مع GA4 أبداً |
| **Purchase أولوية قصوى** | دايماً موصى به في Server-Side |
| **PageView على السيرفر = تكلفة** | حذّر العميل منه |
| **GA4 جديدة للسيرفر** | مش نفس الـ GA4 القديمة |
| **GTM Snippets في الـ Overview** | دايماً ظاهرة، Web + Server |
| **تحقق من Server URL** | قبل أي خطوة تانية |

---

## ملاحظات للـ Developer

- الـ endpoint `POST /api/managed/create-container` مع `mode: "client_server"` هو اللي بيعمل الاتنين (Web + Server Container) في رحلة واحدة.
- الـ `transport_url` في GA4 Configuration Tag لازم يتوير تلقائياً على الـ sGTM URL بعد التأكيد.
- الـ Google Ads Tags لازم تتعمل بـ Trigger منفصل (Custom Event Trigger = "purchase" مش من GA4).
- الـ Container Config اللي بيتعرض للعميل مش هو نفس الـ snippet — هو الـ JSON config اللي بيتحمل على الـ sGTM hosting.
