# EasyTrac — Cloud Run & sGTM Deployment Guide

---

## Prerequisites

- Google Cloud project with billing enabled
- `gcloud` CLI authenticated (`gcloud auth login`)
- Docker installed (for local testing)
- A Server GTM container created at [tagmanager.google.com](https://tagmanager.google.com)

---

## Step 1 — Create the Server GTM Container

1. Go to [tagmanager.google.com](https://tagmanager.google.com)
2. Create a new container → choose **Server** type
3. Copy the **Container Config** string (starts with `eyJ...`)

---

## Step 2 — Deploy sGTM to Cloud Run

### Option A — Cloud Run (recommended for production)

```bash
# 1. Enable required APIs
gcloud services enable run.googleapis.com \
  containerregistry.googleapis.com \
  cloudresourcemanager.googleapis.com

# 2. Deploy sGTM container (Google-managed image)
gcloud run deploy sgtm-easytrac \
  --image gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable \
  --platform managed \
  --region me-central1 \
  --min-instances 1 \
  --max-instances 10 \
  --memory 512Mi \
  --cpu 1 \
  --port 8080 \
  --set-env-vars CONTAINER_CONFIG="YOUR_CONTAINER_CONFIG_STRING_HERE" \
  --allow-unauthenticated

# 3. Note the Cloud Run URL
# e.g. https://sgtm-easytrac-abc123-uc.a.run.app
```

### Option B — Custom Domain (for transport_url)

```bash
# Map a custom domain (needed so transport_url doesn't expose Cloud Run URL)
gcloud run domain-mappings create \
  --service sgtm-easytrac \
  --domain gtm.yourdomain.com \
  --region me-central1

# Add the CNAME record shown to your DNS provider
# CNAME gtm.yourdomain.com → ghs.googlehosted.com
```

### Option C — Stape.io (no-infrastructure option)

1. Go to [stape.io](https://stape.io) → Create new sGTM instance
2. Paste your Container Config string
3. Use the provided `*.stape.io` URL as your `sgtmUrl`
4. For custom domain: add it in Stape dashboard + update DNS

---

## Step 3 — Import sGTM Custom Templates

**Do this BEFORE importing the container JSON.**

For each `.tpl` file in `lib/server-side/sgtm-templates/`:

1. Open your **Server GTM workspace**
2. Go to **Templates** → **Tag Templates** → **New**
3. Click the **⋮ menu** → **Import**
4. Select the `.tpl` file:
   - `meta-capi.tpl` → creates `ET - Meta CAPI (Manual HTTP)`
   - `tiktok-events.tpl` → creates `ET - TikTok Events API (Manual HTTP)`
   - `snapchat-capi.tpl` → creates `ET - Snapchat CAPI (Manual HTTP)`
   - `google-ads-ec.tpl` → creates `ET - Google Ads Enhanced Conversions (Manual HTTP)`
5. Click **Save** on each

---

## Step 4 — Import GTM Container JSONs

### Web Container
1. Generate JSON via EasyTrac tool (or call `buildWebConfig()` directly)
2. Go to your **Web GTM workspace**
3. Admin → Import Container → Choose file
4. Select **Merge** (to keep existing tags) or **Overwrite** (fresh start)
5. Click **Confirm**

### Server Container
1. Generate JSON via EasyTrac tool (or call `buildServerConfig()`)
2. Go to your **Server GTM workspace**
3. Admin → Import Container → Choose file
4. **Important:** Select **Overwrite** if starting fresh, or **Merge** if adding to existing
5. Verify that all 4 custom template types resolve (no "unknown template" warnings)

---

## Step 5 — Configure transport_url

After import, verify the GA4 Configuration tag in your Web GTM:

```
Tag: ET - GA4 Configuration
Parameter: transport_url = https://gtm.yourdomain.com
```

This routes all GA4 hits through your sGTM instance instead of directly to Google.

To update programmatically (via the wire-transport endpoint):
```
POST /api/ss/wire-transport
{
  "clientId": "...",
  "serverUrl": "https://gtm.yourdomain.com"
}
```

---

## Step 6 — Validate the Setup

### Quick health check
```bash
curl https://gtm.yourdomain.com/healthz
# Expected: 200 OK with {"status":"ok"} or similar
```

### Send a test GA4 hit
```bash
curl -X POST "https://gtm.yourdomain.com/g/collect" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "v=2&tid=G-XXXXXXXXXX&cid=test123&en=purchase&ep.event_id=test_001&ep.value=299&ep.currency=SAR"
```

Watch sGTM logs in **Cloud Logging**:
```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=sgtm-easytrac" \
  --limit=50 \
  --format="table(timestamp,textPayload)"
```

---

## Step 7 — Environment Variables & Secrets

Store CAPI tokens securely. Never hardcode them in container JSON.

### Cloud Run environment variables (for the EasyTrac backend)
```bash
gcloud run services update easytrac \
  --set-env-vars \
    ET_LOG_LEVEL=info,\
    FIRESTORE_PROJECT_ID=your-project-id

# For secrets (recommended for tokens):
gcloud secrets create meta-capi-token --data-file=- <<< "EAA..."
gcloud run services update easytrac \
  --set-secrets META_CAPI_TOKEN=meta-capi-token:latest
```

### sGTM — store tokens as Constant variables
In your Server GTM container, CAPI tokens are stored as **Constant variables**:
- `ET - Meta CAPI Token` → `EAA...`
- `ET - TikTok Events Token` → `...`
- `ET - Snapchat CAPI Token` → `...`

These are encrypted inside GTM's server-side storage and are never exposed to the browser.

---

## Step 8 — Cloud Run Scaling Configuration

For production sGTM with high traffic:

```bash
gcloud run services update sgtm-easytrac \
  --min-instances 2 \        # avoid cold starts
  --max-instances 100 \      # scale on traffic spikes
  --concurrency 250 \        # requests per container instance
  --timeout 30 \             # request timeout (seconds)
  --memory 512Mi \
  --cpu 1
```

### Cost optimisation
- Use `--min-instances 1` for always-warm (no cold start latency on first hit)
- Use `--cpu-throttling` for lower traffic sites (cheaper but slightly higher latency)
- Enable Cloud CDN for the sGTM domain to cache static assets

---

## Step 9 — Monitoring & Alerting

### Cloud Logging query for CAPI errors
```
resource.type="cloud_run_revision"
resource.labels.service_name="sgtm-easytrac"
textPayload=~"ET:.*❌"
```

### Cloud Monitoring alert policy
```bash
# Alert when error rate > 1% over 5 minutes
gcloud alpha monitoring policies create \
  --policy-from-file=monitoring-policy.json
```

### Key metrics to watch
| Metric | Threshold | Action |
|---|---|---|
| sGTM request latency p99 | > 2000ms | Scale up instances |
| CAPI error rate | > 5% | Check platform token expiry |
| GA4 Client hit loss | > 0% | Check transport_url routing |
| Cloud Run instance count | at max | Increase max-instances |

---

## Troubleshooting

### "No client found" in sGTM
The GA4 Client is not claiming the incoming request. Verify:
- The request path is `/g/collect`
- The `transport_url` in Web GTM GA4 Config tag matches your sGTM URL exactly

### Variables show empty values in sGTM Preview
- Confirm Web GTM GA4 Event tags are forwarding `ep.*` parameters
- Check that user properties are set in GA4 Config tag `userProperties` list

### Meta CAPI returns 400 / invalid_parameter
- Check that `event_time` is a Unix timestamp (not ISO string)
- Verify `action_source` = "website"
- Confirm `fbp` format: `fb.1.{timestamp}.{random}` — must match exactly

### TikTok Events API returns code != 0
- Verify the `Access-Token` header is set correctly (not `Authorization: Bearer`)
- Confirm `pixel_code` matches the Pixel ID (not the Ad Account ID)

### Snapchat CAPI returns 401
- Token must be the **Conversions API Token** from Snap Ads Manager → Assets → Snap Pixel
- Not the same as OAuth2 / Marketing API token

### Google Ads EC: partial failure
- Verify `gclid`/`wbraid`/`gbraid` is present and was set within the last 90 days
- Confirm conversion action resource name format: `customers/{CID}/conversionActions/{ID}`
- Check that the OAuth2 token has `https://www.googleapis.com/auth/adwords` scope
