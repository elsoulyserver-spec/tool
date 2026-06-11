# EasyTrac — Full Server-Side Tracking Architecture

**Version:** 3.0 | **Stack:** Node.js 18 + Server GTM + Cloud Run | **Mode:** Manual HTTP only (no official templates)

---

## Architecture Overview

```
Browser
  │
  │  dataLayer.push({ event, user_data, ecomm params })
  ▼
Web GTM Container
  │  Variables: DLV + URL + Cookie + Custom JS
  │  Tags: GA4 Config (transport_url) + GA4 Events + Client-Side Pixels
  │
  │  GA4 hit → transport_url → sGTM /g/collect
  ▼
Server GTM Container  (Cloud Run / Stape)
  │  GA4 Client receives hit
  │  Variables extract: ep.* + epn.* + up.* + HTTP headers
  │
  ├──► Meta Conversions API      (et_meta_capi_manual template)
  ├──► TikTok Events API         (et_tiktok_events_manual template)
  ├──► Snapchat Conversions API  (et_snapchat_capi_manual template)
  └──► Google Ads Enhanced Conv  (et_gads_ec_manual template)
```

All CAPI tags use **manual HTTP requests** (`sendHttpRequest` sGTM Sandbox API).
No official Meta / TikTok / Snapchat / Google Ads templates are used.

---

## 1. Web Container — Variable System

### Constants
| Variable | Value | Purpose |
|---|---|---|
| `ET - GA4 Measurement ID` | `G-XXXXXXXXXX` | GA4 stream ID |
| `ET - sGTM URL` | `https://gtm.yourdomain.com` | transport_url target |
| `ET - Meta Pixel ID` | `PIXEL_ID` | Client-side Meta Pixel |
| `ET - TikTok Pixel ID` | `PIXEL_CODE` | Client-side TikTok Pixel |
| `ET - Snapchat Pixel ID` | `SNAP_ID` | Client-side Snap Pixel |
| `ET - Google Ads ID` | `AW-XXXXXXXX` | Google Ads conversion ID |

### DataLayer Variables (DLV)
| Variable | DataLayer Key | Notes |
|---|---|---|
| `ET - DLV event_id` | `event_id` | **Required** — drives deduplication |
| `ET - DLV value` | `value` | Revenue amount |
| `ET - DLV currency` | `currency` | e.g. SAR, USD |
| `ET - DLV transaction_id` | `transaction_id` | Order ID |
| `ET - DLV content_ids` | `content_ids` | Product SKUs |
| `ET - DLV content_name` | `content_name` | Product name |
| `ET - DLV content_type` | `content_type` | Default: product |
| `ET - DLV items` | `items` | GA4 ecommerce items array |
| `ET - DLV quantity` | `quantity` | Item quantity |
| `ET - DLV num_items` | `num_items` | Total item count |
| `ET - DLV user_email` | `user_data.em` | Push pre-hashed or raw |
| `ET - DLV user_phone` | `user_data.ph` | E.164 format preferred |
| `ET - DLV user_first_name` | `user_data.fn` | Lowercase |
| `ET - DLV user_last_name` | `user_data.ln` | Lowercase |
| `ET - DLV user_city` | `user_data.ct` | Lowercase |
| `ET - DLV user_state` | `user_data.st` | ISO abbrev, lowercase |
| `ET - DLV user_zip` | `user_data.zp` | Digits only (US) |
| `ET - DLV user_country` | `user_data.country` | ISO alpha-2 lowercase |
| `ET - DLV external_id` | `external_id` | CRM / user ID |

### URL Variables — Click ID Capture System
| Variable | URL Param | Platform |
|---|---|---|
| `ET - URL fbclid` | `fbclid` | Meta |
| `ET - URL gclid` | `gclid` | Google Ads |
| `ET - URL wbraid` | `wbraid` | Google Ads (iOS App) |
| `ET - URL gbraid` | `gbraid` | Google Ads (cross-channel) |
| `ET - URL ttclid` | `ttclid` | TikTok |
| `ET - URL ScCid` | `ScCid` | Snapchat |
| `ET - URL utm_source` | `utm_source` | Attribution |
| `ET - URL utm_medium` | `utm_medium` | Attribution |
| `ET - URL utm_campaign` | `utm_campaign` | Attribution |

### Cookie Variables
| Variable | Cookie | Platform |
|---|---|---|
| `ET - Cookie _fbp` | `_fbp` | Meta browser ID |
| `ET - Cookie _fbc` | `_fbc` | Meta click ID (persisted) |
| `ET - Cookie _ttp` | `_ttp` | TikTok browser ID |
| `ET - Cookie _scid` | `_scid` | Snapchat browser ID |
| `ET - Cookie _ga` | `_ga` | GA client ID |

### Custom JS Variables
| Variable | Logic |
|---|---|
| `ET - JS fbc_builder` | Returns `_fbc` cookie; if absent, builds `fb.1.{ts}.{fbclid}` from URL |
| `ET - JS email_normalised` | `lowercase().trim()` |
| `ET - JS phone_normalised` | Strip non-digit chars (keep `+`) |
| `ET - JS fn_normalised` | `lowercase().trim()` |
| `ET - JS ln_normalised` | `lowercase().trim()` |
| `ET - JS timestamp` | `Math.floor(Date.now()/1000)` |
| `ET - JS page_url` | `window.location.href` |
| `ET - JS page_referrer` | `document.referrer` |
| `ET - JS GA client_id` | Extracts client ID from `_ga` cookie |

---

## 2. Web Container — GA4 Configuration Tag

```
Tag: ET - GA4 Configuration
Type: gaawc (GA4 Config)
Fires: All Pages trigger

Key parameters:
  measurementId  → {{ET - GA4 Measurement ID}}
  transport_url  → {{ET - sGTM URL}}        ← routes all hits to sGTM
  sendPageView   → false                     ← handled by GA4 Event tags
  userId         → {{ET - DLV external_id}}

User Properties (relayed to sGTM as up.*):
  em          → {{ET - JS email_normalised}}
  ph          → {{ET - JS phone_normalised}}
  fn          → {{ET - JS fn_normalised}}
  ln          → {{ET - JS ln_normalised}}
  external_id → {{ET - DLV external_id}}
  fbp         → {{ET - Cookie _fbp}}
  fbc         → {{ET - JS fbc_builder}}
  ttp         → {{ET - Cookie _ttp}}
  scid        → {{ET - Cookie _scid}}
```

---

## 3. Web Container — GA4 Event Tag Structure

Every GA4 Event tag forwards these parameters as `ep.*` in the sGTM payload:

```
Event Parameters:
  event_id        → {{ET - DLV event_id}}        ← CAPI deduplication key
  value           → {{ET - DLV value}}
  currency        → {{ET - DLV currency}}
  transaction_id  → {{ET - DLV transaction_id}}
  items           → {{ET - DLV items}}
  content_ids     → {{ET - DLV content_ids}}
  content_name    → {{ET - DLV content_name}}
  content_type    → {{ET - DLV content_type}}
  num_items       → {{ET - DLV num_items}}
  fbclid          → {{ET - URL fbclid}}
  gclid           → {{ET - URL gclid}}
  wbraid          → {{ET - URL wbraid}}
  gbraid          → {{ET - URL gbraid}}
  ttclid          → {{ET - URL ttclid}}
  ScCid           → {{ET - URL ScCid}}
  _fbp            → {{ET - Cookie _fbp}}
  _fbc            → {{ET - JS fbc_builder}}
  _ttp            → {{ET - Cookie _ttp}}
  _scid           → {{ET - Cookie _scid}}
  utm_source      → {{ET - URL utm_source}}
  utm_medium      → {{ET - URL utm_medium}}
  utm_campaign    → {{ET - URL utm_campaign}}
  page_url        → {{ET - JS page_url}}
  page_referrer   → {{ET - JS page_referrer}}
  event_time      → {{ET - JS timestamp}}
```

---

## 4. Server Container — Variable System

### Variables Reading from GA4 Hit (ep.*)
In the GA4 server protocol, event parameters arrive as `ep.*` (string) and `epn.*` (numeric).

| Variable | Source | GA4 Key |
|---|---|---|
| `ET - ep event_id` | ep.* | `event_id` |
| `ET - ep transaction_id` | ep.* | `transaction_id` |
| `ET - ep currency` | ep.* | `currency` |
| `ET - ep content_ids` | ep.* | `content_ids` |
| `ET - ep content_name` | ep.* | `content_name` |
| `ET - ep content_type` | ep.* | `content_type` |
| `ET - ep items` | ep.* | `items` |
| `ET - ep num_items` | ep.* | `num_items` |
| `ET - ep fbclid` | ep.* | `fbclid` |
| `ET - ep gclid` | ep.* | `gclid` |
| `ET - ep wbraid` | ep.* | `wbraid` |
| `ET - ep gbraid` | ep.* | `gbraid` |
| `ET - ep ttclid` | ep.* | `ttclid` |
| `ET - ep ScCid` | ep.* | `ScCid` |
| `ET - ep _fbp` | ep.* | `_fbp` |
| `ET - ep _fbc` | ep.* | `_fbc` |
| `ET - ep _ttp` | ep.* | `_ttp` |
| `ET - ep _scid` | ep.* | `_scid` |
| `ET - epn value` | epn.* (numeric) | `value` |

### Variables Reading from User Properties (up.*)
| Variable | Source | GA4 Key |
|---|---|---|
| `ET - up em` | up.* | `em` (normalised email) |
| `ET - up ph` | up.* | `ph` (normalised phone) |
| `ET - up fn` | up.* | `fn` (first name) |
| `ET - up ln` | up.* | `ln` (last name) |
| `ET - up ct` | up.* | `ct` (city) |
| `ET - up st` | up.* | `st` (state) |
| `ET - up zp` | up.* | `zp` (zip) |
| `ET - up country` | up.* | `country` |
| `ET - up external_id` | up.* | `external_id` |
| `ET - up fbp` | up.* | `fbp` |
| `ET - up fbc` | up.* | `fbc` |
| `ET - up ttp` | up.* | `ttp` |
| `ET - up scid` | up.* | `scid` |

### HTTP Header Variables
| Variable | Header | Notes |
|---|---|---|
| `ET - Header client_ip` | `x-forwarded-for` | Set by Cloud Run ingress |
| `ET - Header user_agent` | `user-agent` | Browser UA string |

### Computed Variables
| Variable | Logic |
|---|---|
| `ET - client_ip_clean` | First IP from `x-forwarded-for` (strips proxy chain) |
| `ET - event_time_unix` | `ep.event_time` if present, else `Date.now()/1000` |
| `ET - resolved_fbc` | `up.fbc` → `ep._fbc` → build from `ep.fbclid` |
| `ET - resolved_fbp` | `up.fbp` → `ep._fbp` |

---

## 5. Server Container — Trigger Mappings

| Trigger | Type | Fires When |
|---|---|---|
| `ET - All Events` | Always | Every hit received by GA4 Client |
| `ET - sGTM Event page_view` | Custom Event | `event_name = page_view` |
| `ET - sGTM Event view_item` | Custom Event | `event_name = view_item` |
| `ET - sGTM Event add_to_cart` | Custom Event | `event_name = add_to_cart` |
| `ET - sGTM Event begin_checkout` | Custom Event | `event_name = begin_checkout` |
| `ET - sGTM Event purchase` | Custom Event | `event_name = purchase` |

---

## 6. Per-Platform Payload Mapping

### Meta Conversions API
```
POST https://graph.facebook.com/v22.0/{PIXEL_ID}/events?access_token={TOKEN}

{
  "data": [{
    "event_name":       Meta event name (e.g. "Purchase")
    "event_time":       {{ET - event_time_unix}}     ← Unix seconds
    "event_id":         {{ET - ep event_id}}          ← deduplication
    "action_source":    "website"
    "event_source_url": {{ET - page_location}}

    "user_data": {
      "em":                 SHA-256({{ET - up em}})
      "ph":                 SHA-256({{ET - up ph}})
      "fn":                 SHA-256({{ET - up fn}})
      "ln":                 SHA-256({{ET - up ln}})
      "ct":                 SHA-256({{ET - up ct}})
      "st":                 SHA-256({{ET - up st}})
      "zp":                 SHA-256({{ET - up zp}})
      "country":            SHA-256({{ET - up country}})
      "external_id":        SHA-256({{ET - up external_id}})
      "fbp":                {{ET - resolved_fbp}}   ← NOT hashed
      "fbc":                {{ET - resolved_fbc}}   ← NOT hashed
      "client_ip_address":  {{ET - client_ip_clean}}
      "client_user_agent":  {{ET - Header user_agent}}
    }

    "custom_data": {
      "value":        {{ET - epn value}}
      "currency":     {{ET - ep currency}}
      "order_id":     {{ET - ep transaction_id}}
      "content_ids":  [{{ET - ep content_ids}}]
      "content_type": {{ET - ep content_type}}
      "num_items":    {{ET - ep num_items}}
      "contents":     [{id, quantity, price}]
    }
  }]
}
```

### TikTok Events API
```
POST https://business-api.tiktok.com/open_api/v1.3/event/track/
Header: Access-Token: {TOKEN}

{
  "pixel_code": {{ET - TikTok Pixel ID}}
  "event":      TikTok event name (e.g. "PlaceAnOrder")
  "event_time": {{ET - event_time_unix}}
  "event_id":   {{ET - ep event_id}}

  "user": {
    "email":       SHA-256({{ET - up em}})
    "phone_number":SHA-256({{ET - up ph}})
    "external_id": SHA-256({{ET - up external_id}})
    "ttclid":      {{ET - ep ttclid}}
    "ttp":         {{ET - up ttp}}
    "ip":          {{ET - client_ip_clean}}
    "user_agent":  {{ET - Header user_agent}}
  }

  "properties": {
    "value":    {{ET - epn value}}
    "currency": {{ET - ep currency}}
    "order_id": {{ET - ep transaction_id}}
    "contents": [{content_id, content_type, quantity, price}]
  }

  "page": {
    "url":      {{ET - page_location}}
    "referrer": {{ET - page_referrer}}
  }
}
```

### Snapchat Conversions API
```
POST https://tr.snapchat.com/v2/conversion
Header: Authorization: Bearer {TOKEN}

{
  "pixel_id":         {{ET - Snapchat Pixel ID}}
  "event_type":       Snap event type (e.g. "PURCHASE")
  "event_time":       {{ET - event_time_unix}} * 1000  ← milliseconds!
  "event_source_url": {{ET - page_location}}
  "client_dedup_id":  {{ET - ep event_id}}

  "user_data": {
    "em":          [SHA-256({{ET - up em}})]       ← array
    "ph":          [SHA-256({{ET - up ph}})]       ← array
    "external_id": [SHA-256({{ET - up external_id}})]
    "sc_click_id": {{ET - ep ScCid}}
    "sc_cookie1":  {{ET - up scid}}
    "ip_address":  {{ET - client_ip_clean}}
    "user_agent":  {{ET - Header user_agent}}
  }

  "custom_data": {
    "currency":       {{ET - ep currency}}
    "price":          {{ET - epn value}}
    "transaction_id": {{ET - ep transaction_id}}
    "item_ids":       [{{ET - ep content_ids}}]
    "num_items":      {{ET - ep num_items}}
  }
}
```

### Google Ads Enhanced Conversions
```
POST https://googleads.googleapis.com/v17/customers/{CID}:uploadClickConversions
Headers:
  Authorization: Bearer {OAUTH2_TOKEN}
  developer-token: {DEV_TOKEN}

{
  "conversions": [{
    "gclid":                {{ET - ep gclid}}    ← at least one required
    "wbraid":               {{ET - ep wbraid}}
    "gbraid":               {{ET - ep gbraid}}
    "conversion_action":    "customers/{CID}/conversionActions/{ID}"
    "conversion_date_time": "2025-01-15 12:00:00+00:00"
    "conversion_value":     {{ET - epn value}}
    "currency_code":        {{ET - ep currency}}
    "order_id":             {{ET - ep transaction_id}}
    "user_identifiers": [
      { "hashedEmail":       SHA-256({{ET - up em}}) }
      { "hashedPhoneNumber": SHA-256({{ET - up ph}}) }
      { "addressInfo": {
          "hashedFirstName": SHA-256({{ET - up fn}})
          "hashedLastName":  SHA-256({{ET - up ln}})
          "postalCode":      {{ET - up zp}}
          "countryCode":     {{ET - up country}}
        }
      }
    ]
  }],
  "partial_failure": true
}
```

---

## 7. Deduplication Strategy

The architecture uses **event_id** as the single deduplication key across all platforms.

### How it works

**Web side (dataLayer push):**
```javascript
window.dataLayer = window.dataLayer || [];
window.dataLayer.push({
  event: 'purchase',
  event_id: 'order_' + orderId + '_' + Date.now(), // unique per event
  transaction_id: orderId,
  value: 299.00,
  currency: 'SAR',
  // ...
});
```

**Client-side pixel** receives `event_id` via the `{eventID: '...'}` parameter:
```javascript
fbq('track', 'Purchase', { ... }, { eventID: '{{ET - DLV event_id}}' });
```

**CAPI tag** sends the same `event_id` in the `event_id` field. Meta, TikTok and Snapchat each deduplicate pixel + CAPI events when `event_id` matches within a 48-hour window.

### event_id generation rules
- Must be unique per event instance, NOT per event type
- Must match exactly between pixel and CAPI call
- Recommended format: `{eventType}_{orderId}_{timestamp}` e.g. `purchase_ORD-123_1736000000`
- Store and read from `dataLayer.event_id` on every event push

### Platform deduplication windows
| Platform | Window | Field |
|---|---|---|
| Meta | 48 hours | `event_id` |
| TikTok | 24 hours | `event_id` |
| Snapchat | 24 hours | `client_dedup_id` |
| Google Ads | 24 hours | `order_id` + gclid combination |

---

## 8. Testing Flow

### Step 1 — Meta Test Events
```
1. Go to Meta Events Manager → Test Events
2. Copy your test_event_code (e.g. "TEST12345")
3. In sGTM container, edit your Meta CAPI tag
4. Set testEventCode field to "TEST12345"
5. Publish sGTM container
6. Fire a purchase event from your website
7. Watch events appear in Meta Test Events dashboard in real time
8. Remove testEventCode before going live
```

### Step 2 — sGTM Preview Mode
```
1. Open your sGTM container → Preview
2. Copy the Preview header value (x-gtm-server-preview: ...)
3. In your browser, add this header to requests (use ModHeader extension)
4. Fire events from your website
5. Watch in sGTM Preview: Tags Fired / Not Fired, Variable Values, Requests
6. Inspect each tag's input/output
```

### Step 3 — GA4 DebugView
```
1. Add ?_dbg=1 to your site URL
   OR add gtag('config', 'G-XXXXXX', {'debug_mode': true})
2. Open GA4 → Configure → DebugView
3. Events appear in real-time with full parameter inspection
4. Confirm all ep.* and up.* variables are populated correctly
```

### Step 4 — TikTok Events Test
```
1. TikTok Ads Manager → Assets → Events → Web Events → Test Events
2. Set your domain and fire test events
3. TikTok shows matched events with user data match rate
```

### Step 5 — Snapchat Pixel Validator
```
1. Snap Ads Manager → Assets → Snap Pixel → Pixel Details
2. Use Pixel Helper Chrome extension for client-side validation
3. For CAPI: check Snap Ads Manager Pixel Activity log
```

### Step 6 — End-to-End Checklist
```
□ dataLayer.push includes event_id on every event
□ GA4 Config tag has transport_url set to sGTM URL
□ sGTM Preview shows GA4 Client receiving the hit
□ sGTM variables: ep.event_id, up.em, ET - client_ip_clean are populated
□ Meta test_event_code shows events in Events Manager
□ TikTok test shows events in Event Manager
□ No duplicate events (pixel + CAPI both fired with same event_id)
□ Purchase events show correct value + currency
```

---

## 9. Scalable Architecture for Multiple Clients

EasyTrac is designed to serve multiple clients from one codebase. Each client gets:

```
Firestore document: clients/{uid}/ssConfig
  {
    webContainerId:    "GTM-XXXXXX",
    serverContainerId: "GTM-YYYYYY",
    serverUrl:         "https://gtm.clientdomain.com",
    ga4MeasurementId:  "G-XXXXXXXXXX",
    pixelIds: {
      meta:       "PIXEL_ID",
      tiktok:     "PIXEL_CODE",
      snap:       "SNAP_ID",
      gads:       "AW-XXXXXXXXXX",
      gads_label: "AbCdEfGh"
    },
    capiTokens: {           ← AES-256-GCM encrypted via crypto-vault.js
      meta:   "EAA...",
      tiktok: "...",
      snap:   "..."
    },
    events:    ["page_view","view_content","add_to_cart","purchase"],
    platforms: ["meta","tiktok","snap","gads"]
  }
```

When generating a container JSON for a client, call:
```javascript
const { buildWebConfig, buildServerConfig } = require('./lib/gtm-config-builder');

const webJson    = buildWebConfig({ ga4MeasurementId, sgtmUrl, pixelIds, events });
const serverJson = buildServerConfig({ ga4MeasurementId, sgtmUrl, platforms, events, pixelIds, capiTokens });
```

The output is a GTM import-ready JSON that the client imports at:
GTM → Admin → Import Container → Choose file → Overwrite/Merge

---

## 10. File Structure

```
lib/
├── gtm-config-builder.js          ← Web + Server container JSON generators
├── crypto-vault.js                ← AES-256-GCM token encryption
├── ss-rate-limiter.js             ← API rate limiting
└── server-side/
    ├── hash-utils.js              ← SHA-256 hashing + PII normalisation
    ├── payload-builder.js         ← GA4 event parser + payload builder
    ├── event-dispatcher.js        ← Fan-out orchestrator + retry + logging
    ├── capi-senders/
    │   ├── meta-capi.js           ← Meta Conversions API (manual HTTP)
    │   ├── tiktok-events.js       ← TikTok Events API (manual HTTP)
    │   ├── snapchat-capi.js       ← Snapchat Conversions API (manual HTTP)
    │   └── google-ads-ec.js       ← Google Ads Enhanced Conversions (manual HTTP)
    └── sgtm-templates/
        ├── meta-capi.tpl          ← sGTM Custom Template (import to sGTM workspace)
        ├── tiktok-events.tpl      ← sGTM Custom Template
        ├── snapchat-capi.tpl      ← sGTM Custom Template
        └── google-ads-ec.tpl      ← sGTM Custom Template
```
