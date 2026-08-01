# تفعيل تسليم الـ Server-Side CAPI (Runbook)

> **الأولوية:** 🔴 #1 — من غير ده الحاوية السيرفرية المُدارة بتطلع **GA4-only من غير CAPI**، والـ value prop المعلَن مكسور.  
> **الحالة:** الكود **مكتمل ومتيست** بالفعل (مسار `versions:import` خلف flag). اللي ناقص = **تفعيل تشغيلي (ops)** + تأكيد.

---

## 1. إيه اللي بيعمله التفعيل

| | الـ flag مطفّي (الافتراضي) | الـ flag مفعّل + bucket متظبط |
|---|---|---|
| مصدر إعداد الحاوية السيرفرية | `lib/sgtm-default-config.json` | `serverConfigJson` اللي الـ frontend بناه |
| المحتوى | GA4 forward بس | GA4 + **Meta/TikTok/Snap CAPI** (customTemplate) |
| المسار في الكود | `importContainerJSON` (per-entity) | `importServerContainerVersion` → `versions:import` |

> ⚠️ **شرط مزدوج:** الـ CAPI بيتسلّم **بس لو** `MANAGED_IMPORT_SERVER_CONFIG=1` **و** `PROVISIONING_BUCKET` متظبط. لو الـ flag مفعّل والـ bucket ناقص → بيرجع لـ GA4-only **بصمت** (دلوقتي بقى فيه تحذير وقت الإقلاع — انظر §4).

---

## 2. المتطلبات قبل التفعيل

1. **GCS bucket** (لأن الـ `serverConfigJson` ممكن يعدّي حد الـ 1MB بتاع Firestore، وبيحوي توكنات CAPI):
   - خاص (private)، نفس الريجن، **TTL قصير** (مثلاً يوم واحد)، و access-logging مفعّل.
   - الـ blob سرّي → لازم lifecycle rule يمسحه (خط دفاع أخير فوق المسح البرمجي في `server.js`).
2. **`FIREBASE_SA_KEY_JSON`** لخدمة حساب عندها صلاحية الكتابة/القراءة على الـ bucket (الـ `config-blob-store` بيستخدم نفس الـ Admin app بتاع Firestore).
3. **`GTM_SA_KEY_JSON` + `GTM_ACCOUNT_ID`** (موجودين أصلاً للـ provisioning).
4. **`MASTER_ENCRYPTION_KEY`** (جديد): الـ blob دلوقتي بيتشفّر بـ AES-256-GCM قبل ما يترفع (نفس الـ vault المستخدم لتوكنات الـ BYO flow) — لو المفتاح ده مش متظبط، `configBlobStore.put()` هيرمي error والـ job هيرجع GA4-only تلقائيًا (نفس سلوك أي فشل تاني هنا).

---

## 3. خطوات التفعيل على Railway

```bash
# على Railway → Variables (أو railway CLI)
MANAGED_IMPORT_SERVER_CONFIG=1
PROVISIONING_BUCKET=easytrac-provisioning   # اسم الـ bucket الخاص بتاعك
FIREBASE_SA_KEY_JSON={...}                  # لازم صلاحية Storage
```

> **ملاحظة:** التفعيل دلوقتي **آمن للـ rollback** — الـ flag بيتعاد قراءته وقت الـ worker، فلو رجّعته `0` الـ jobs الجارية بترجع للمسار القديم فوراً.

---

## 4. إزاي تتأكد إنه اشتغل (الجديد في الكود)

### أ. وقت الإقلاع (deploy logs)
السيرفر دلوقتي بيطبع سطر واضح:
- `Server-side CAPI import: 🟢 ENABLED ...` → تمام، هيتسلّم CAPI.
- `Server-side CAPI import: 🔴 FLAG ON but staging bucket NOT configured ...` → الـ flag شغّال بس الـ bucket ناقص؛ هيرجع GA4-only. **اظبط الـ bucket.**
- `Server-side CAPI import: ⚪ disabled ...` → الافتراضي (GA4-only).

### ب. أي وقت عبر الـ health endpoint
```bash
curl https://tool.easytrac.io/api/managed/health
```
دوّر على البلوك الجديد:
```json
"serverConfigImport": {
  "enabled": true,
  "bucketConfigured": true,
  "deliversCapi": true        // ← لازم تكون true
}
```
`deliversCapi: true` معناها الشرط المزدوج متحقق وكل حاوية جديدة هتطلع بالـ CAPI.

### ج. على أول حاوية فعلية بعد التفعيل
- في رد الـ job: `serverConfigSource: "versions_import"` ولازم `importedTagCount` يكون أكبر من حالة الـ GA4-only.
- في GTM admin للحاوية السيرفرية: لازم تلاقي tags الـ Meta/TikTok/Snap + الـ customTemplate (Universal HTTP Forwarder).

---

## 5. الـ Rollback

```bash
MANAGED_IMPORT_SERVER_CONFIG=0
```
يتعاد قراءته وقت الـ worker → رجوع فوري للمسار الـ GA4-only (byte-identical للسلوك القديم).

---

## 6. الخطوة التالية (Phase 2 — مهمة أمنياً)

**تحديث:** الـ blob المُخزّن في الـ GCS دلوقتي **متشفّر** (AES-256-GCM، `lib/config-blob-store.js` schemaVersion 2) — ده بيقفل مخاطرة إن حد يقرا الـ bucket مباشرة (misconfiguration، صلاحيات زيادة، TTL اتعطل) ويلاقي التوكنات نص صافي. ده defense-in-depth فوق خصائص الـ bucket (private/TTL/audit) مش بديل عنها.

**اللي لسه ناقص:** توكنات الـ CAPI لسه بتيجي **من العميل** (client-side, `buildSSContainer()` في `tool.html`) وتتـembed جوه الـ tag config (URL/authHeader) قبل ما توصل للـ blob أصلاً. الـ SSOT الآمن بالكامل = السيرفر يبني الـ config ويحقن التوكنات من الـ vault (نفس التوكنات المُشفّرة المحفوظة عبر `/api/ss/save-config`) بدل ما يثق في توكنات جاية من الطلب نفسه. ده تصميم أكبر (لازم unify بين الـ managed flow والـ BYO flow في تخزين التوكنات) وليس مجرد تعديل تشفير.

---

## ملحق — مراجع الكود

| الموضوع | الموقع |
|---------|--------|
| الـ flag | `server.js` → `_serverConfigImportEnabled()` |
| نقطة الـ staging + الشرط المزدوج | `server.js` → handler الـ `create-container` |
| تحميل الـ blob في الـ worker | `server.js` → `_runManagedProvisionJob` |
| قرار import الكامل vs static | `gtm-service.js` → `provisionForClientWithServer` |
| الـ versions:import | `gtm-service.js` → `importServerContainerVersion` |
| مخزن الـ blob | `lib/config-blob-store.js` |
| التيستات (3 حالات قرار) | `tests/provisionForClientWithServer.import-decision.test.js` |
| تيستات تشفير الـ blob | `tests/config-blob-store.encryption.test.js` |
| الـ observability الجديد | `server.js` → `/api/managed/health` + لوج الإقلاع |
