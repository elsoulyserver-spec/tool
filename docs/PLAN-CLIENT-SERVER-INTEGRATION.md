# Easy Track — Plan: دمج الـ Client-Side + Server-Side في flow واحد

> **الحالة:** Draft — pending review قبل التنفيذ.
> **الـ scope:** يحل مشكلة الـ 502 + يضيف خيار "Client + Server" يعمل containers الاتنين تلقائياً ويربطهم.

---

## 1. مشكلة الـ 502 — Root Cause + Fix

### السبب
ملف `lib/providers/base.js` بيـ `try { axios = require('axios') } catch (_) {}` — ده بـ "swallows" الـ require failure silently. لما `npm install` ما اتشغلش (أو `node_modules/axios` متمسوحة)، الـ `getAxios()` بـ throws **"axios is not installed"**. ده بـ يـ trigger الـ catch block في:

| Endpoint | السلوك |
|---|---|
| `POST /api/ss/test-event` | يدخل الـ catch ويرد `502 — فشل إرسال الحدث: axios is not installed` |
| `POST /api/ss/validate-url` | نفس الكلام |
| `POST /api/ss/deploy-stape` | نفس الكلام |

### Fix (مطبّق دلوقت)
1. ✅ `npm install axios` — الـ package دلوقت موجود في `node_modules/axios@1.15.2`
2. 🔜 **Startup warning**: نضيف log في `server.js` عند الـ boot لو `axios` مش loaded:
   ```js
   try { require('axios'); }
   catch (_) {
     console.warn('[STARTUP] ⚠️  axios is missing — /api/ss/* will return 502. Run: npm install');
   }
   ```
3. 🔜 **Better error message**: الـ catch في الـ /api/ss/* routes يفصل بين أنواع الأخطاء (lib missing vs network vs SSRF) فالـ user يفهم لازم يعمل إيه.

### Side note: production deploy
Railway / Cloud Run بـ يشغّلوا `npm install` تلقائياً قبل `npm start`. لو الـ user عنده deployment فاشل، لازم نتأكد إن `package.json` شامل `axios` (وهي شاملة فعلاً).

---

## 2. الـ Architecture — Client-Side فقط vs Client + Server

```
┌──────────────────┐        ┌─────────────────────┐
│  CLIENT-ONLY     │        │  CLIENT + SERVER    │
│                  │        │                     │
│  Browser         │        │  Browser            │
│    │             │        │    │                │
│    │  GTM web    │        │    │  GTM web       │
│    │  (Pixels    │        │    │  (GA4 +        │
│    │   fire      │        │    │   transport_url│
│    │   here)     │        │    │   = sGTM URL)  │
│    ▼             │        │    ▼                │
│  Meta / TikTok / │        │  sGTM container     │
│  Snap / GA4      │        │  (Stape / GCP /     │
│  endpoints       │        │   Self-hosted)      │
│                  │        │    │                │
│                  │        │    │  Server-side    │
│                  │        │    │  routes data    │
│                  │        │    │  to platforms   │
│                  │        │    ▼                │
│                  │        │  Meta CAPI /        │
│                  │        │  TikTok Events API /│
│                  │        │  GA4 Measurement    │
└──────────────────┘        └─────────────────────┘
```

### مميزات الـ "Client + Server"
- ✅ بيتجاوز ad blockers (الطلبات بتروح من أو لـ نفس domain الـ user)
- ✅ بيدعم Conversions APIs (Meta CAPI / TikTok Events API)
- ✅ Cookie/session enrichment على الـ server
- ✅ Privacy: PII filtering قبل ما يطلع للـ ad networks
- ❌ بيحتاج deployment + monthly cost لـ sGTM

### ❌ "Server only" مش وجود فعلي
sGTM ما بيـ generate events لوحده — الـ events لازم تيجي من الـ browser. فأي "server-only" mode = "client + server" بـ wizard مختصر.

> **القرار**: نخلّيه **2 modes** بس: `client` و `client_server`. ده يبسّط الـ UI ويجنّب الـ user الالتباس.

---

## 3. Backend Changes

### 3.1 `gtm-service.js` — إضافات جديدة

```js
// NEW — إنشاء server-side container
async function createServerContainer(name) {
  return gtmRequest('POST', `/accounts/${getAccountId()}/containers`, JSON.stringify({
    name,
    usageContext: ['server'],   // ← الفرق الوحيد عن web container
  }));
}

// NEW — جلب containerConfig blob (للـ Stape / Cloud Run deploy)
// الـ containerConfig هو الـ "Config" string اللي بتلاقيه في
// GTM admin → Container Settings → "Config".
async function getContainerConfig(containerId) {
  const c = await gtmRequest('GET',
    `/accounts/${getAccountId()}/containers/${containerId}`);
  return c.containerConfig || null;
}

// NEW — wire الـ web container's GA4 tag إلى الـ sGTM URL
// بعد ما الـ user يعمل deploy ويأكد الـ URL، بنطبّقه كـ transport_url
// على الـ GA4 Configuration tag في الـ web container.
async function setGA4TransportUrl(webContainerId, webWorkspaceId, sgtmUrl) {
  const acc = getAccountId();
  const tagsResp = await gtmRequest('GET',
    `/accounts/${acc}/containers/${webContainerId}/workspaces/${webWorkspaceId}/tags`);
  const tags = tagsResp.tag || [];

  // GA4 Configuration: gaawc (legacy) | googtag (new unified Google tag)
  const ga4 = tags.find(t => t.type === 'gaawc' || t.type === 'googtag');
  if (!ga4) throw new Error('No GA4 Configuration tag in web container');

  // Replace any existing transport_url param, then PUT the tag back
  const params = (ga4.parameter || []).filter(p => p.key !== 'transport_url');
  params.push({ type: 'template', key: 'transport_url', value: sgtmUrl });

  await gtmRequest('PUT',
    `/accounts/${acc}/containers/${webContainerId}/workspaces/${webWorkspaceId}/tags/${ga4.tagId}`,
    JSON.stringify({ ...ga4, parameter: params }));

  // Re-version + republish so the change goes live
  const ver = await createVersion(webContainerId, webWorkspaceId, 'wire sGTM transport_url');
  const versionId = ver.containerVersion.containerVersionId;
  await publishVersion(webContainerId, versionId);
  return { versionId };
}

// NEW — orchestration: web container + server container in one call
async function provisionForClientWithServer(opts) {
  // 1. Web container — existing flow, لكن بدون publish (نعمل publish بعد wiring)
  const web = await provisionForClient({ ...opts, publishLive: false });

  // 2. Server container
  const serverCt = await createServerContainer((opts.projectName || 'Easy Track') + ' (Server)');
  const serverWs = await getDefaultWorkspace(serverCt.containerId);

  // 3. Import default sGTM config (GA4 client + base setup)
  //    config json bundle — هنخزّنه في lib/sgtm-default-config.json
  const sgtmConfig = require('./lib/sgtm-default-config.json');
  await importContainerJSON(serverCt.containerId, serverWs.workspaceId, sgtmConfig);

  // 4. Version + publish (نشغّل الـ server publish قبل الـ deploy)
  const ver = await createVersion(serverCt.containerId, serverWs.workspaceId, 'sGTM initial');
  const serverVersionId = ver.containerVersion.containerVersionId;
  if (opts.publishLive) await publishVersion(serverCt.containerId, serverVersionId);

  // 5. الـ containerConfig string (للـ deploy على Stape/GCP)
  const containerConfig = await getContainerConfig(serverCt.containerId);

  return {
    web,
    server: {
      containerId:     serverCt.containerId,
      publicId:        serverCt.publicId,        // GTM-XXXXXX
      workspaceId:     serverWs.workspaceId,
      versionId:       serverVersionId,
      containerConfig,                            // → الـ Stape / GCP يحتاجه
    },
  };
}
```

### 3.2 `server.js` — routes جديدة / متعدلة

#### `POST /api/managed/create-container` (modified)
يستقبل field جديد: `mode: 'client' | 'client_server'`. لو `client_server`، يستدعي `provisionForClientWithServer`. الـ response يحتوي على `server: { ... }` لو الـ mode دي.

#### `POST /api/ss/wire-transport` (NEW)
```
Body: { webContainerId, webWorkspaceId, sgtmUrl }
Auth: Firebase ID token (مثل باقي /api/ss/*)
Action: يعدّل الـ web container's GA4 tag, يعمل version جديد, ويعمل publish
Returns: { ok: true, versionId }
```

### 3.3 Firestore schema additions

في `managed_containers/<gtmPublicId>` (web container):
```js
{
  // existing fields...
  mode: 'client' | 'client_server',     // NEW
  serverContainerPublicId: string|null, // NEW — link to companion server container
}
```

في `ss_configs/<clientId>` (سيرفر-side config):
```js
{
  // existing fields...
  mode: 'client_server',                // NEW
  webContainerId:  string,              // NEW
  webPublicId:     string,              // NEW
  serverContainerId: string,            // NEW
  serverPublicId:    string,            // NEW
  serverVersionId:   string,            // NEW
  containerConfig:   string,            // NEW — cached for re-deploy / migration
  transportUrlWired: boolean,           // NEW — set after /api/ss/wire-transport
  transportUrlWiredAt: Timestamp|null,
}
```

---

## 4. Frontend (tool.html) Changes

### 4.1 Mode-picker step (جديد، أول خطوة في الـ provisioning wizard)
```
┌─────────────────────────────────────────────────┐
│  اختار طريقة التتبّع                              │
├─────────────────────────────────────────────────┤
│  ○ 🌐 Client-side فقط                            │
│      تتبّع من المتصفح مباشرةً للـ pixels            │
│      مناسب: مواقع صغيرة، setup سريع              │
│                                                 │
│  ● 🚀 Client + Server (موصى به)                  │
│      sGTM container على Stape / Cloud Run        │
│      يتجاوز ad blockers + Conversions APIs       │
│      مناسب: e-commerce جدّي، lead-gen مكلّف        │
└─────────────────────────────────────────────────┘
```

### 4.2 Wizard adjustment (when mode = client_server)

| Step | Client-only | Client + Server |
|---|---|---|
| 1. Mode | Pick | Pick |
| 2. Pixels & events | Same | Same |
| 3. GTM provisioning | Creates web container | Creates web + server containers |
| 4. **Provider** | (skip) | Stape / GCP / Self-hosted |
| 5. **Deploy sGTM** | (skip) | Auto-passes `containerConfig` from server container |
| 6. **Confirm URL** | (skip) | User pastes/confirms sGTM URL |
| 7. **Wire transport_url** | (skip) | Auto: `POST /api/ss/wire-transport` |
| 8. Done | Snippet to paste | Snippet + sGTM URL + verification button |

### 4.3 Auto-wiring (no copy/paste)
في الـ flow الجديد، الـ user **مش هيـ copy/paste** الـ container config — الـ frontend بيـ pull الـ `containerConfig` من الـ create-container response ويحطه مباشرة في الـ deploy-stape body.

### 4.4 New UI elements
- **Mode picker** card (step 0)
- **Server container info banner** بعد الـ provisioning ("✅ Server container `GTM-YYYYYY` created")
- **Auto-wiring spinner** خلال الـ `wire-transport` call
- **Verification button**: "تحقق من sGTM" — بيستدعي `/api/ss/health` ويعرض latency

---

## 5. الـ default sGTM config

نحتاج JSON pre-built لـ:
- `GA4 Client` (الـ entry point للـ sGTM)
- `GA4 tag` (forwards to GA4 Measurement Protocol)
- (Optional) Meta CAPI tag stub
- (Optional) TikTok Events API tag stub

محتاجين نـ generate ده من GTM templates، نخزنه في `lib/sgtm-default-config.json` ونستوردها كـ Phase 1. الـ Phase 2 ممكن نضيف pixels-specific tags بناءً على اختيار الـ user.

---

## 6. الـ Implementation Phases

### Phase 1 — Hot-fixes (مهم — قبل أي feature)
- [x] `npm install axios` (تم)
- [ ] Startup warning للـ deps المفقودة
- [ ] تحسين الـ catch messages في /api/ss/* routes

### Phase 2 — GTM service extensions
- [ ] `createServerContainer()`
- [ ] `getContainerConfig()`
- [ ] `setGA4TransportUrl()`
- [ ] `provisionForClientWithServer()`
- [ ] Build `lib/sgtm-default-config.json` (GA4 Client + GA4 tag)

### Phase 3 — Server routes
- [ ] Extend `/api/managed/create-container` to accept `mode`
- [ ] New `/api/ss/wire-transport` route
- [ ] Update Firestore schema (additive — no migration needed)

### Phase 4 — Frontend wizard
- [ ] Mode-picker step
- [ ] Auto-pass `containerConfig` to deploy step
- [ ] Auto-wire transport_url after URL confirmation
- [ ] Verification UI

### Phase 5 — Tests
- [ ] Unit test: `createServerContainer` → mocks GTM API
- [ ] Unit test: `setGA4TransportUrl` → idempotency (calling twice doesn't duplicate param)
- [ ] Integration test: full provisioning flow on a sandbox GTM account

---

## 7. الـ risks + mitigations

| Risk | Mitigation |
|---|---|
| Default sGTM config is generic, doesn't fit all platforms | Phase 2: per-pixel server tags (Meta CAPI gets meta tag, TikTok gets TikTok tag) |
| GTM write quota for 2 containers (~50 writes vs 25) | الـ existing burst-with-pause strategy already handles this |
| Stape's `config_body` format changes | Wrapper layer in stape provider, log raw payload on failure |
| User manually edits the web container later, breaks transport_url | `transportUrlWired` flag in Firestore + scheduled re-check |
| Self-hosted users won't get auto-wiring | UI shows manual wiring instructions when provider=selfhosted |
| Server container creation fails after web succeeds | Roll-back option: delete the orphan web container, OR present a "retry server only" button |

---

## 8. الـ Out-of-scope (للـ session لاحقة)

- Per-platform server-side tags (Meta CAPI, TikTok Events API templates)
- sGTM custom mappings UI
- Auto-renewal of Stape subscriptions
- Multi-region failover

---

## 9. القرارات اللي محتاجة مراجعة منك

1. **Mode count**: 2 modes (`client` / `client_server`) — موافق؟ ولا تحب نضيف `server-only` كـ alias لـ `client_server`؟
2. **Default Provider**: لو الـ user اختار `client_server`، نخلي الـ default selection على Stape ولا نخليه يختار من البداية؟
3. **Auto-publish**: لما نعمل wire transport_url، نعمل auto-publish للـ web container ولا نخلي الـ user يـ approve؟
4. **Stape API key encryption**: هل الـ user هيدخل key جديدة كل مرة، ولا نحتفظ بيها (encrypted في Firestore — already supported بـ AAD = `clientId:stape`)؟
5. **Server container template**: هل عندك نسخة جاهزة من sGTM config (export من GTM admin)؟ أو محتاج أصمّمها من الصفر؟

---

**جاهز للـ implementation فور موافقتك على الخطوط العريضة.**
