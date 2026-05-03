# EasyTrac — Server-Side Tracking Wizard · Full Flow v3

## الهدف
إعادة بناء قسم Server-Side Tracking ليكون wizard متكامل يجمع Client-Side + Server-Side في فلو واحد سلس، يشمل الـ Container، الـ Platforms، الـ Pixels+Tokens، الـ Events، والـ Deploy الكامل مع Deduplication.

---

## الفلو الكامل — 8 خطوات

---

### STEP 1 — GTM Containers (Web + Server)
**ما يحصل:**
- زرار "إنشاء Web + Server Containers" يستدعي `/api/ss/create-containers`
- يُنشئ Web Container + Server Container في GTM تلقائياً
- يعرض النتيجة:
  - `WEB GTM ID` → مثال: GTM-XXXXXX
  - `SERVER GTM ID` → مثال: GTM-YYYYYY
  - `Container Config` (الـ string الطويل) → يُنسخ ويُحط في Stape/Cloud Run

**UI:**
```
[ Web GTM: GTM-XXXXXX ]   [ Server GTM: GTM-YYYYYY ]
Container Config: [ eyJhY2NvdW50SWQi... ] [نسخ]
```

**المتطلبات:**
- لو الـ containers موجودين قبل كده → يعرضهم من Firestore مباشرة (مش ينشئ جدد)
- الـ Container Config لازم يتحفظ في Firestore مع بيانات الـ client

---

### STEP 2 — Server URL (sGTM)
**ما يحصل:**
- العميل يدخل الـ URL بتاع السيرفر بتاعه (Stape/Cloud Run/Docker)
- النظام يـ ping الـ URL ويتأكد إنه شغال (`/api/ss/validate-url`)
- لو تمام → يحفظ الـ URL في Firestore

**UI:**
```
أدخل URL الخادم:
[ https://gtm.yourdomain.com ] [التحقق ←]
✅ الخادم يستجيب — زمن الاستجابة: 234ms
```

**Validation:**
- HTTPS فقط
- لازم يرد بـ status 200
- timeout: 10 ثانية

---

### STEP 3 — Google Analytics 4 (GA4)
**ما يحصل:**
- العميل يدخل:
  - **Measurement ID** → مثال: `G-XXXXXXXXXX`
  - **API Secret** (للـ Measurement Protocol) → مثال: `xxxxxxxxxxxx`
- النظام يحفظهم encrypted في Firestore
- يُستخدموا لاحقاً في إرسال Server-Side events لـ GA4

**UI:**
```
Google Analytics 4 — Measurement Protocol
Measurement ID:  [ G-XXXXXXXXXX ]
API Secret:      [ ************ ] [👁️]
```

**ملاحظة:**
- الـ API Secret يتحفظ encrypted بـ AES-256-GCM
- يُعرض للعميل كـ `****` دايماً بعد الحفظ

---

### STEP 4 — Platform Selection (نفس فلو Pixel Config)
**ما يحصل:**
- العميل يختار المنصة/المنصات:
  - `سلة (Salla)`
  - `زد (Zid)`
  - (مستقبلاً: Shopify, WooCommerce, إلخ)
- لكل منصة مختارة → يظهر section خاص بيها في الـ STEP التالي

**UI:**
```
اختر منصتك:
[✓] سلة    [ ] زد    [ ] أخرى
```

---

### STEP 5 — Pixels + Tokens (لكل منصة)
**لكل منصة اختارها العميل، يظهر section منفصل:**

#### Meta (Facebook) Pixel:
```
Meta Pixel:
Pixel ID:    [ 1234567890 ]
Access Token: [ EAAxxxxx... ] [👁️]
Test Event Code (اختياري): [ TEST12345 ]
```

#### Google Ads:
```
Google Ads:
Conversion ID:    [ AW-XXXXXXXXX ]
Conversion Label: [ xxxxxxxxxxxx ]
```

#### Snapchat Pixel:
```
Snapchat Pixel:
Pixel ID:    [ xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx ]
Access Token: [ xxxxxxxxxxxxxxxx ] [👁️]
```

#### TikTok Pixel:
```
TikTok Pixel:
Pixel ID:    [ XXXXXXXXXXXXXXXXXX ]
Access Token: [ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx ] [👁️]
```

**المتطلبات:**
- كل الـ tokens تتحفظ encrypted في Firestore
- يُعرض validation فوري للـ Pixel ID (format check)
- "اختبر الاتصال" → يبعت test event ويرد بـ ✅ أو ❌

---

### STEP 6 — Events Selection
**ما يحصل:**
- يعرض قائمة الـ events المتاحة مع توصيات بناءً على المنصة:

```
اختر الأحداث التي تريد تتبعها:
[✓] ⭐ PageView        — كل زيارة صفحة
[✓] ⭐ ViewContent     — مشاهدة منتج
[✓] ⭐ AddToCart       — إضافة للسلة
[✓] ⭐ InitiateCheckout — بدء الدفع
[✓] ⭐ Purchase        — إتمام الشراء
[ ]    AddToWishlist   — إضافة للمفضلة
[ ]    Search          — بحث
[ ]    Lead            — عميل محتمل
```

**لكل Event:**
- اسم الـ event في كل منصة (Meta, GA4, Snapchat, TikTok)
- هل يدعم Enhanced Conversions / Advanced Matching
- هل يدعم الـ Event Deduplication

---

### STEP 7 — Client-Side Code Generation
**ما يحصل:**
- النظام يولّد كود GTM Container Config مخصص يشمل:
  - Tags لكل pixel مختار
  - Triggers للـ events المختارة
  - Variables للـ user data
  - DataLayer push code للمنصة (Salla/Zid)

**يتضمن الكود:**
```javascript
// GTM DataLayer Push — مولّد تلقائياً لـ [اسم المنصة]
window.dataLayer = window.dataLayer || [];
window.dataLayer.push({
  event: 'purchase',
  event_id: '{{order_id}}_{{timestamp}}',  // Deduplication ID
  value: '{{order_total}}',
  currency: 'SAR',
  transaction_id: '{{order_id}}',
  user_data: {
    email_address: hashEmail('{{customer_email}}'),  // SHA-256
    phone_number:  hashPhone('{{customer_phone}}'),
    first_name:    '{{customer_first_name}}',
    last_name:     '{{customer_last_name}}',
  }
});
```

**UI:**
```
كود GTM للـ Web Container:
[كود JSON للـ Container Config]  [نسخ] [تحميل .json]

كود DataLayer للمنصة:
[كود JavaScript]  [نسخ]
```

---

### STEP 8 — Server-Side Deploy + Review
**ما يحصل:**
- النظام يعمل wire-transport: يربط الـ Web Container بالـ Server Container تلقائياً (`/api/ss/wire-transport`)
- يعرض ملخص كامل لكل حاجة اتعملت:

**UI:**
```
✅ Web Container:    GTM-XXXXXX
✅ Server Container: GTM-YYYYYY  
✅ Server URL:       https://gtm.yourdomain.com
✅ GA4:              G-XXXXXXXXXX
✅ Meta Pixel:       123456789 (Token: محفوظ 🔒)
✅ Events:           Purchase, AddToCart, ViewContent

Deduplication: ✅ مفعّل (Event ID = order_id + timestamp)
User Data:     ✅ Hashed (SHA-256) — email, phone
Enhanced Conversions: ✅ مفعّل

[ ← إعداد جديد ]   [ اذهب إلى Overview → ]
```

---

## البيانات المطلوبة لكل Event (Server-Side)

### Purchase (الأهم):
| Field | المصدر | Hashed؟ |
|-------|--------|---------|
| event_id | `order_id + "_" + timestamp` | لا |
| value | سعر الطلب | لا |
| currency | SAR/AED/KWD | لا |
| transaction_id | order_id | لا |
| email | customer email | ✅ SHA-256 |
| phone | customer phone | ✅ SHA-256 |
| first_name | customer name | لا |
| last_name | customer name | لا |
| city | عنوان التوصيل | لا |
| country | SA/AE/KW | لا |
| items[] | المنتجات | لا |

### ViewContent / AddToCart:
| Field | المصدر |
|-------|--------|
| event_id | `product_id + "_" + timestamp` |
| content_ids | [product_id] |
| content_name | اسم المنتج |
| value | سعر المنتج |
| currency | SAR |

---

## Deduplication Strategy
```
event_id = platform_order_id + "_" + Math.floor(Date.now()/1000)
مثال: "ORD-12345_1714987654"
```
- يُرسل في Client-Side (DataLayer)
- يُرسل في Server-Side (Conversions API)
- المنصة تتجاهل الـ event التاني تلقائياً

---

## Data Flow Architecture
```
Browser → GTM Web Container (tags client-side)
              ↓
         sGTM Server Container (forwards to APIs)
              ↓
    ┌─────────────────────────────────┐
    │  Meta CAPI  │  GA4 MP  │  Snap  │  TikTok  │
    └─────────────────────────────────┘
```

---

## API Endpoints المطلوبة

| Method | Path | الغرض |
|--------|------|--------|
| POST | /api/ss/create-containers | إنشاء Web + Server GTM |
| POST | /api/ss/validate-url | التحقق من Server URL |
| POST | /api/ss/save-config | حفظ كل الإعدادات |
| POST | /api/ss/wire-transport | ربط Web ↔ Server |
| POST | /api/ss/test-event | اختبار إرسال event |
| GET  | /api/ss/full-status | عرض الحالة الكاملة |
| GET  | /api/ss/generate-code | توليد كود GTM + DataLayer |

---

## ملاحظات تقنية مهمة
1. **كل الـ tokens** تتحفظ encrypted (AES-256-GCM) في Firestore — لا تُرسل للـ frontend أبداً
2. **Deduplication** إلزامي في كل الـ purchase events
3. **User Data Hashing** يتم في الـ client-side (SHA-256) قبل الإرسال
4. **Enhanced Conversions** (Google) تتطلب email أو phone هاشد
5. **Advanced Matching** (Meta) تتطلب email أو phone أو FBP/FBC
6. الـ sGTM يتحقق من الـ CONTAINER_CONFIG قبل ما يشتغل
