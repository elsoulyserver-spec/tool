# Server-Side GTM Setup Guide

This document covers all three supported hosting providers for Easy Track's
Server-Side Tracking feature.

---

## Option A — Stape.io (Recommended)

Stape handles provisioning automatically via API. No manual CLI steps.

1. Sign up at [app.stape.io](https://app.stape.io)
2. Go to **Settings → API** and copy your API Key
3. In the Easy Track tool → Server-Side → Step 1 → select **Stape.io**
4. Paste your API Key in Step 2
5. Click **نشر على Stape** in Step 4 — the container is created automatically
6. The server URL is filled in and validated for you

**Stape API reference:** https://api.app.stape.io/api/doc

---

## Option B — Google Cloud Run (Guided)

No GCP credentials are stored by Easy Track. You run the commands yourself.

### Prerequisites
- A Google Cloud project with billing enabled
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed

### Steps

**1. Enable Cloud Run API**
```bash
gcloud services enable run.googleapis.com --project=YOUR_PROJECT_ID
```

**2. Get your GTM Server Container Config**

In Google Tag Manager:
- Open your **Server** container → Admin → **Install manually**
- Copy the **"Container config"** string (long base64 string)

**3. Deploy the container**
```bash
gcloud run deploy sgtm \
  --image=gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable \
  --platform=managed \
  --region=me-central1 \
  --project=YOUR_PROJECT_ID \
  --allow-unauthenticated \
  --min-instances=1 \
  --set-env-vars=CONFIG_BODY=YOUR_CONTAINER_CONFIG_STRING
```

The deploy takes ~3 minutes. The output will include a URL like
`https://sgtm-xxxx-xx.a.run.app`.

**4. Paste the URL**

Back in the Easy Track tool → Step 2 → paste the Cloud Run URL → click
**اختبر الاتصال** to confirm it's reachable.

**Cost estimate:** ~$0–5/month for low traffic (within the free tier).

---

## Option C — Self-Hosted (Docker / VPS / K8s)

Easy Track validates your URL but does not deploy anything.

### Docker Compose

```yaml
version: "3.9"
services:
  sgtm:
    image: gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable
    ports:
      - "8080:8080"
    environment:
      - CONFIG_BODY=YOUR_CONTAINER_CONFIG_STRING
      - PORT=8080
    restart: unless-stopped
```

```bash
docker compose up -d
```

Point a subdomain at your server (e.g. `sgtm.yourdomain.com`) with HTTPS via
nginx + Certbot or Caddy, then paste the URL into the Easy Track tool.

### Nginx reverse proxy snippet

```nginx
server {
    listen 443 ssl;
    server_name sgtm.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/sgtm.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sgtm.yourdomain.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

---

## Token Encryption

Platform access tokens (Meta CAPI, TikTok Events API, etc.) are encrypted with
**AES-256-GCM** before being stored in Firestore.

### Setting MASTER_ENCRYPTION_KEY

Generate a 32-byte random key:

```bash
# Node
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# OpenSSL
openssl rand -hex 32
```

Add to your `.env` file:
```
MASTER_ENCRYPTION_KEY=<64 hex chars output from above>
```

**Important:** if this key is lost, encrypted tokens cannot be recovered.
Back it up in a password manager or secrets vault.

### Key rotation

Use the admin endpoint to re-encrypt all tokens with a new key:

```bash
curl -X POST https://your-app.com/api/ss/rotate-key \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"newKey":"<new 64-char hex key>"}'
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `❌ فشل الاتصال` on URL test | Confirm the URL is publicly reachable (no VPN/firewall blocking it) |
| `429 Too Many Requests` | Wait 60 seconds — rate limiter resets every minute |
| `503 Firestore not configured` | Set `FIREBASE_SA_KEY_JSON` env var |
| `500 Encryption key not configured` | Set `MASTER_ENCRYPTION_KEY` to a 64-char hex string |
| Stape deploy fails with 401 | Regenerate your API Key in app.stape.io → Settings → API |
| Cloud Run URL returns 404 | The container may still be starting — wait 2 minutes and retry |
