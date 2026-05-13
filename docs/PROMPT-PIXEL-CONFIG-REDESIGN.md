# Prompt: Pixel Config — Server Side + Client Side Redesign

أنت Senior Tracking Engineer يشتغل على Easy Track (`tool.html`).
المطلوب تعمل **إعادة هيكلة لـ Pixel Config section** (`#view-pixels`) عشان تدعم:
1. **Server Side configuration** — قسم جديد بـ toggle
2. **Client Side (Web Container) configuration** — تطوير الـ flow الحالي

اقرأ الملفات دي بالترتيب قبل ما تبدأ:
- `tool.html` (الـ Pixel Config view من سطر ~3724، والـ SS wizard من سطر ~14271)
- `docs/PROMPT-SS-V2.md` — عشان تفهم الـ SS architecture الموجودة
- `docs/PLAN-CLIENT-SERVER-INTEGRATION.md` — لو موجود

---

## ═══════════════════════════════════════════
## 🎯 الهدف العام

إضافة **قسمين واضحين** في Pixel Config:

```
┌────────────────────────────────────────────┐
│  🖥️  Server Side                  [ OFF ▷ ] │
│      (يتفعّل لو الزبون عنده سيرفر)          │
├────────────────────────────────────────────┤
│  🌐  Client Side (Web Container)           │
│      (الـ Web GTM Container الأساسي)        │
└────────────────────────────────────────────┘
```

---

## ═══════════════════════════════════════════
## 🖥️ الجزء الأول: SERVER SIDE

### 1. Toggle التفعيل

- زر Toggle (OFF/ON) في header القسم
- لو **OFF**: الـ server-side form مايظهرش + الـ generate ميضيفش أي SS config
- لو **ON**: تظهر الخطوات التالية بالترتيب

### 2. خطوة: Server URL

```
حقل input:
  label: "رابط السيرفر (sGTM URL)"
  placeholder: "https://your-server.example.com"
  validation: يتحقق إن الرابط يبدأ بـ https://
  hint: "مثال: https://gtm.yourstore.com"
```

### 3. خطوة: GA4 Client Data

- يجيب تلقائياً **GA4 Measurement ID** من الـ state الموجود (`S.pixelIds['ga4']` أو من Step 1 في الـ client side)
- لو مش موجود: يعرض input صغير يكتب فيه الـ GA4 ID
- يعرضه كـ read-only مع label: "GA4 Measurement ID (من الـ Client Side)"
- الهدف إن الـ server side يعرف يربط events بـ GA4 property الصح

### 4. خطوة: اختيار المنصات على السيرفر

منصات الإعلانات المتاحة للـ Server Side:

| المنصة       | المفتاح  | البيانات المطلوبة              |
|--------------|----------|-------------------------------|
| Meta (CAPI)  | `meta`   | Pixel ID + CAPI Access Token  |
| Google Ads   | `gads`   | Conversion ID + Conversion Label لكل event |
| Snapchat     | `snap`   | Pixel ID + CAPI Token         |
| TikTok       | `tiktok` | Pixel ID + Events API Token   |

**UI:** بطاقات قابلة للاختيار (نفس style الـ `cbtn` الموجود) — ممكن يختار أكتر من منصة.

### 5. خطوة: اختيار Events لكل منصة (Server Side)

**لكل منصة مختارة** يظهر section منفصل بـ events chips:

```
قائمة الـ Events المتاحة:
- purchase          💰
- add_to_cart       🛒
- initiate_checkout 💳
- view_content      👁️
- page_view         📄
- lead              📋
- sign_up           ✍️
- search            🔍
```

**الـ UI:**
- Accordion أو tabs — منصة ← events
- كل event عليه chip قابل للتفعيل/الإلغاء
- الـ events المختارة في الـ client side تتحدد تلقائياً (pre-selected) بس يقدر يعدّل

### 6. خطوة: بيانات المنصات (Pixel IDs + Tokens) — Server Side

**لكل منصة مفعّلة** يظهر card بـ inputs:

**Meta (CAPI):**
```
- Pixel ID       → input text
- Access Token   → input password + eye toggle
```

**Google Ads:**
```
- Conversion ID  → input text  (مثال: AW-1234567890)
- لكل event مختار → حقل Conversion Label منفصل
  مثال لو اختار purchase + lead:
    purchase  → [ Conversion Label input ]
    lead      → [ Conversion Label input ]
```

**Snapchat:**
```
- Pixel ID   → input text
- CAPI Token → input password + eye toggle
```

**TikTok:**
```
- Pixel ID          → input text
- Events API Token  → input password + eye toggle
```

---

## ═══════════════════════════════════════════
## 🌐 الجزء الثاني: CLIENT SIDE (Web Container)

### الـ Flow الحالي (الموجود):
`CMS → Platform → Events → Pixel IDs → Output`

### التطوير المطلوب:

**تقسيم Step 2 (Platform) إلى قسمين:**

#### أ) منصات الإعلانات (Advertising Platforms):
- Meta Pixel
- Google Ads
- Snapchat
- TikTok

#### ب) منصات التحليل (Analytics Platforms):
- Google Analytics 4 (GA4)
- Mixpanel

**UI:** section headers واضحة (`--mut` color) تفصل بين النوعين داخل نفس الـ Step.

---

### Step: اختيار Events (Client Side)

- نفس قائمة الـ events الموجودة
- **لكل منصة مختارة** → events chips خاصة بيها
- **GA4:** events منفصلة عن Google Ads عن Meta — الـ UI الموجود يكفي مع تحسين التنظيم

---

### Step: Pixel IDs (Client Side)

**لكل منصة مختارة** يظهر input:

**Meta Pixel:**
```
- Pixel ID → input text  (مثال: 1234567890123456)
```

**Google Ads:**
```
- Conversion ID  → input text  (مثال: AW-1234567890)
- لكل event مختار → Conversion Label منفصل:
    purchase  → [ Conversion Label ]
    add_to_cart → [ Conversion Label ]
    ...إلخ
```

**Snapchat:**
```
- Pixel ID → input text
```

**TikTok:**
```
- Pixel ID → input text
```

**GA4:**
```
- Measurement ID → input text  (مثال: G-XXXXXXXXXX)
```

**Mixpanel:**
```
- Project Token → input text
```

---

## ═══════════════════════════════════════════
## 🗂️ State Management

```js
// Server Side state (جديد)
var _pcSS = {
  enabled:    false,           // toggle
  serverUrl:  '',              // رابط السيرفر
  ga4Id:      '',              // GA4 ID (من client side أو manual)
  platforms:  [],              // ['meta', 'gads', 'snap', 'tiktok']
  events:     {},              // { meta: ['purchase','lead'], gads: ['purchase'], ... }
  pixelIds:   {},              // { meta: 'XXXXXX', snap: 'XXXXXX', tiktok: 'XXXXXX' }
  tokens:     {},              // { meta: 'EAAxx', snap: 'eyJx', tiktok: 'XXX' }
  gadsConvId: '',              // AW-XXXXXXXXXX
  gadsLabels: {},              // { purchase: 'AbCd_xxx', lead: 'XyZw_xxx' }
};

// Client Side state (موجود — نطوّره)
// S.platforms   → array ['meta','google','snapchat','tiktok','ga4','mixpanel']
// S.events      → array global أو per-platform
// S.pixelIds    → { meta, google, google_labels:{ev:label}, snapchat, tiktok, ga4, mixpanel }
```

---

## ═══════════════════════════════════════════
## 🔗 ربط SS Config بالـ GTM Generator

لما `_pcSS.enabled === true`، الـ `generate()` function تضيف:

1. **GA4 Config Tag:** parameter `serverContainerUrl = _pcSS.serverUrl`
2. **SS Relay Tag:** tag إضافي يبعت events للـ sGTM (POST fetch)
3. **الـ JSON output** يشمل `ss_config` section فيه المنصات والـ events المختارة

لما `_pcSS.enabled === false`:
- مفيش `serverContainerUrl`
- مفيش SS relay tags
- الـ Container نظيف client-only

---

## ═══════════════════════════════════════════
## 🎨 UI / UX Guidelines

- استخدم **CSS variables الموجودة فقط:**
  `--acc`, `--acc2`, `--bdr`, `--bdr2`, `--sur`, `--sur2`, `--wht`, `--wht2`, `--mut`, `--bg`, `--bg2`, `--bg3`
- **RTL** بالكامل — الكلاس `dir="rtl"` موجود على الـ HTML
- Style الـ cards زي `cbtn` الموجود
- Style الـ inputs زي `ss-tok-input` الموجود
- الـ toggle: نفس style الـ `ss-px-toggle` الموجود
- الـ sections يكون فيهم `border-radius:12px; border:1px solid var(--bdr2);`
- **Accordion للمنصات** — كل منصة header قابلة للفتح/الإغلاق
- **لو Google Ads مختارة:** حقول الـ Conversion Labels تظهر داخل الـ accordion بعد قائمة الـ events

---

## ═══════════════════════════════════════════
## ⚠️ Constraints

- **مفيش كسر للـ flow الحالي** — الـ Pixel Config flow الموجود (CMS → Platform → Events → Pixel IDs → Output) لازم يكمّل شغّال بدون تغيير جوهري
- **الـ SS section منفصل تماماً** عن الـ server-side wizard الموجود في `#view-serverside`
- **مفيش dependency على backend** — الـ SS config يتخزّن في الـ state بس (مش Firestore)، وبيستخدم في الـ GTM JSON generation فقط
- **الـ SS toggle يكون في أعلى الـ Pixel Config view** قبل الـ stepper
- لو **SS مش مفعّل** → يعتبر الـ form مش موجود ومفيش حاجة بتتبعت منه
- كل input sensitive (tokens) = `type="password"` + eye icon toggle

---

## ═══════════════════════════════════════════
## 📋 Acceptance Criteria

- [ ] Toggle الـ Server Side يظهر/يخفّي القسم بسلاسة
- [ ] حقل Server URL فيه validation (https://)
- [ ] الـ GA4 ID بيتجيب تلقائي من الـ client side state
- [ ] منصات الـ Server Side قابلة للاختيار (multi-select)
- [ ] Events لكل منصة server-side قابلة للتعديل
- [ ] Google Ads في الـ server side: Conversion ID + Label لكل event
- [ ] Client Side: منصات الإعلانات منفصلة عن منصات التحليل بـ visual grouping
- [ ] Client Side: Google Ads Pixel IDs section يشمل Conversion ID + Labels لكل event
- [ ] الـ `generate()` تراعي `_pcSS.enabled` وتضيف أو تحذف الـ SS config
- [ ] الـ flow الحالي شغّال 100% بدون SS
- [ ] مفيش `--bg2` ولا `--bdr3` (غير موجودين في الـ CSS vars)
- [ ] Eye toggle شغّال على كل حقل password

---

## ═══════════════════════════════════════════
## 🚀 Execution Order

1. اقرأ `tool.html` من سطر 3724 لـ 4068 (الـ Pixel Config HTML)
2. اقرأ `tool.html` من سطر 6130 لـ 6450 (الـ goStep + generate logic)
3. اقرأ `tool.html` من سطر 14271 لـ 14600 (الـ SS wizard state — استلهم الـ style)
4. **ابعت خطة implementation** قبل ما تبدأ تكتب كود:
   - وين بالظبط هتضيف الـ SS toggle HTML
   - وين هتضيف الـ `_pcSS` state
   - كيف هتعدّل `generate()` تراعي الـ SS
   - أي تغيير في الـ client-side steps
5. استنّى موافقة قبل التنفيذ
