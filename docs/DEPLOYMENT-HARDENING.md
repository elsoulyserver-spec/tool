# EasyTrac — Cloud Run Deployment Hardening Guide

Production configuration reference for the EasyTrac server-side tracking infrastructure running on Google Cloud Run + Server GTM.

---

## Architecture recap

```
Browser
  └─► Web GTM (GA4 Config, transport_url)
        └─► Server GTM on Cloud Run  (/g/collect)
              └─► GA4 Client → ep.* / up.* extraction
                    └─► EasyTrac Dispatcher
                          ├─► Meta CAPI
                          ├─► TikTok Events API
                          ├─► Snapchat CAPI
                          └─► Google Ads Enhanced Conversions
```

---

## 1 — Cloud Run service configuration

### Recommended settings for sGTM container

```bash
gcloud run services update sgtm-easytrac \
  --region          me-central1 \
  --min-instances   2 \          # Always-warm: eliminates cold-start latency on first hit
  --max-instances   200 \        # Scale headroom for traffic spikes
  --concurrency     250 \        # Requests per container instance (sGTM is async-capable)
  --memory          512Mi \      # sGTM baseline; increase to 1Gi if handling large payloads
  --cpu             1 \
  --timeout         30 \         # Per-request timeout; CAPI calls are ~500ms–3s
  --cpu-throttling               # Only bill for actual CPU use (acceptable for tracking latency)
```

### Why `--min-instances 2` and not 1

- **1 instance** avoids cold starts only for the current instance. If Cloud Run scales down to 0 during low-traffic windows, the next request incurs a 1–3 s cold start which is unacceptable for purchase events.
- **2 instances** with `--cpu-throttling` costs roughly **$8–15/month** more than 1 but guarantees sub-50 ms response time continuity.
- For very high volume (>10k events/day), use `--no-cpu-throttling` and `--min-instances 3`.

### Request timeout reasoning

| Phase                    | Typical latency |
|--------------------------|-----------------|
| sGTM GA4 client claim    | < 5 ms          |
| Variable resolution      | < 10 ms         |
| CAPI fan-out (parallel)  | 200–800 ms      |
| Retry attempt 1 (+500ms) | 700–1300 ms     |
| Retry attempt 2 (+2000ms)| 2700–3300 ms    |
| **Total worst case**     | **~4 s**        |

Set `--timeout 30` on the sGTM Cloud Run service to allow the full retry window to complete. The GA4 Client itself acks the browser immediately — the browser does not wait for CAPI results.

---

## 2 — Autoscaling strategy

```bash
# For moderate traffic (1k–50k events/day)
--min-instances 2 --max-instances 50 --concurrency 250

# For high traffic (50k–500k events/day)
--min-instances 5 --max-instances 500 --concurrency 250

# For burst-heavy workloads (flash sales, product launches)
--min-instances 10 --max-instances 1000 --concurrency 100
# Lower concurrency = faster scale-out on burst
```

### Concurrency tuning

`--concurrency 250` is appropriate because:
- sGTM uses async I/O (sendHttpRequest is non-blocking within the sandbox)
- Each request's CAPI calls are parallelised via `Promise.allSettled`
- Memory per concurrent request is low (~5–15 KB)

Lower concurrency to 80–100 if you observe increased p99 latency under load — this forces earlier scale-out.

---

## 3 — Memory and CPU recommendations

| Scenario                         | Memory | CPU |
|----------------------------------|--------|-----|
| sGTM only (< 3 platforms)        | 512 Mi | 1   |
| sGTM + 4 CAPIs (current setup)   | 512 Mi | 1   |
| sGTM + heavy custom JS templates | 1 Gi   | 1   |
| EasyTrac Node.js backend service | 512 Mi | 1   |

Memory above 512 Mi rarely improves CAPI throughput — the bottleneck is network I/O to platform APIs, not memory.

---

## 4 — Cold-start mitigation

### Primary: `--min-instances`
Always keep at least 1 warm instance. For purchase-critical paths, use 2.

### Secondary: Startup probe
```bash
gcloud run services update sgtm-easytrac \
  --startup-cpu-boost              # Allocates extra CPU during container init
```

### Tertiary: Lightweight container
The Google-managed sGTM image (`gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable`) already starts in ~400–800 ms. Do not add unnecessary startup scripts.

### Keep-alive requests (optional)
For extreme cold-start sensitivity, configure Cloud Scheduler to hit `/healthz` every 30 seconds. This works around `--min-instances 0` if cost is a constraint.

```bash
gcloud scheduler jobs create http sgtm-keepalive \
  --schedule "*/1 * * * *" \
  --uri "https://gtm.yourdomain.com/healthz" \
  --http-method GET \
  --location me-central1
```

---

## 5 — Secret management for CAPI tokens

**Never** hardcode CAPI tokens in container JSON or environment variables set via `--set-env-vars`.

### Option A — Cloud Run native secret injection (recommended)

```bash
# Create secrets in Secret Manager
gcloud secrets create et-meta-capi-token    --replication-policy=automatic
gcloud secrets create et-tiktok-events-token --replication-policy=automatic
gcloud secrets create et-snap-capi-token    --replication-policy=automatic
gcloud secrets create et-gads-access-token  --replication-policy=automatic
gcloud secrets create et-gads-dev-token     --replication-policy=automatic

# Store token values (pipe from stdin to avoid shell history)
echo -n "EAABsbCS..." | gcloud secrets versions add et-meta-capi-token --data-file=-
echo -n "..."         | gcloud secrets versions add et-tiktok-events-token --data-file=-
echo -n "..."         | gcloud secrets versions add et-snap-capi-token --data-file=-
echo -n "..."         | gcloud secrets versions add et-gads-access-token --data-file=-
echo -n "..."         | gcloud secrets versions add et-gads-dev-token --data-file=-

# Inject into Cloud Run at deploy time — tokens appear as env vars
gcloud run services update easytrac \
  --set-secrets \
    ET_META_CAPI_TOKEN=et-meta-capi-token:latest,\
    ET_TIKTOK_EVENTS_TOKEN=et-tiktok-events-token:latest,\
    ET_SNAPCHAT_CAPI_TOKEN=et-snap-capi-token:latest,\
    ET_GADS_ACCESS_TOKEN=et-gads-access-token:latest,\
    ET_GADS_DEVELOPER_TOKEN=et-gads-dev-token:latest
```

### Option B — Runtime Secret Manager fetch

Use `security.loadSecretsFromSecretManager()` in your Cloud Run startup code:

```javascript
const { loadSecretsFromSecretManager } = require('./lib/server-side/security');
const { resetConfig }                  = require('./lib/server-side/config-manager');

// Called once during Cloud Run instance startup
async function init() {
  const result = await loadSecretsFromSecretManager();
  console.log('Secrets loaded:', result.loaded);
  resetConfig(); // flush config cache so new env vars are picked up
}
```

Set environment variables pointing to secret names:
```bash
gcloud run services update easytrac \
  --set-env-vars \
    ET_META_CAPI_TOKEN_SECRET=et-meta-capi-token,\
    ET_TIKTOK_EVENTS_TOKEN_SECRET=et-tiktok-events-token,\
    ET_SNAP_CAPI_TOKEN_SECRET=et-snap-capi-token,\
    ET_GADS_ACCESS_TOKEN_SECRET=et-gads-access-token,\
    ET_GADS_DEVELOPER_TOKEN_SECRET=et-gads-dev-token
```

### IAM — grant secret access to the service account

```bash
# Get the Cloud Run service account
SA=$(gcloud run services describe easytrac --format='value(spec.template.spec.serviceAccountName)')

gcloud secrets add-iam-policy-binding et-meta-capi-token \
  --member "serviceAccount:${SA}" \
  --role "roles/secretmanager.secretAccessor"
# Repeat for all secrets
```

### Token rotation

1. Add a new secret version: `gcloud secrets versions add et-meta-capi-token --data-file=-`
2. Cloud Run picks up `:latest` on next instance start.
3. Trigger a rolling restart: `gcloud run services update easytrac --region me-central1`
4. Disable the old version after confirming traffic: `gcloud secrets versions disable et-meta-capi-token --version=1`

---

## 6 — Structured logging configuration

### Set log level via environment variable

```bash
gcloud run services update easytrac \
  --set-env-vars ET_LOG_LEVEL=info,ET_ENVIRONMENT=production
```

| `ET_LOG_LEVEL` | What is logged                                    | Recommended for      |
|----------------|---------------------------------------------------|----------------------|
| `debug`        | Full payloads, all retry attempts, variable values | Local dev only       |
| `info`         | Dispatch results, CAPI responses, warnings         | Staging              |
| `warning`      | Only warnings and errors                           | Production (default) |
| `error`        | Only errors                                        | High-volume prod     |

**Do not use `debug` in production.** It logs full payloads including PII fields (pre-hash) which would violate data processing agreements.

### Cloud Logging query examples

```
# All EasyTrac logs for a specific event
resource.type="cloud_run_revision"
jsonPayload.requestId="your-uuid-here"

# All CAPI failures in the last hour
resource.type="cloud_run_revision"
jsonPayload.success=false
jsonPayload.platform=("meta" OR "tiktok" OR "snap" OR "gads")
timestamp>="2024-01-01T00:00:00Z"

# High-latency dispatches (> 5 seconds)
resource.type="cloud_run_revision"
jsonPayload.totalLatencyMs>5000

# Retry attempts
resource.type="cloud_run_revision"
jsonPayload.message=~"Retry"
```

---

## 7 — Rate limiting strategy

The EasyTrac dispatcher includes an in-memory `RateLimiter` (sliding window) for process-local protection. For multi-instance Cloud Run deployments, use an external rate limiter.

### Process-local (included — use for single-instance dev)

```javascript
const { RateLimiter } = require('./lib/server-side/security');

// Max 1000 events per client per minute
const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1000 });

function handleRequest(clientId, payload) {
  const { allowed, remaining } = limiter.check(clientId);
  if (!allowed) throw new Error('Rate limit exceeded');
  return dispatch(payload);
}
```

### Cloud Memorystore Redis (recommended for production multi-instance)

```bash
gcloud redis instances create et-rate-limiter \
  --size=1 \
  --region=me-central1 \
  --redis-version=redis_7_0 \
  --tier=BASIC
```

Use `ioredis` + a sliding window Lua script, or a library like `rate-limiter-flexible` (Redis backend).

### sGTM-level rate limiting

sGTM itself has no built-in rate limiter. For protection at the edge, use:
- **Cloud Armor** on the load balancer in front of sGTM
- **Cloudflare WAF** if using a custom domain via Cloudflare

---

## 8 — Monitoring and alerting

### Key Cloud Monitoring alert policies

```bash
# Alert: CAPI error rate > 5% over 5 min
gcloud alpha monitoring policies create --policy-from-file=monitoring/capi-error-rate.json

# Alert: sGTM request latency p99 > 3s
gcloud alpha monitoring policies create --policy-from-file=monitoring/latency-p99.json

# Alert: Cloud Run instance count at max
gcloud alpha monitoring policies create --policy-from-file=monitoring/max-instances.json
```

### Alert thresholds

| Metric                        | Warning     | Critical    | Action                              |
|-------------------------------|-------------|-------------|-------------------------------------|
| CAPI error rate               | > 2%        | > 10%       | Check platform token expiry         |
| Meta CAPI 400 rate            | > 1%        | > 5%        | Check payload format / fbp          |
| TikTok Events API code != 0   | > 1%        | > 5%        | Check pixel_code / access token     |
| sGTM request latency p99      | > 2000 ms   | > 5000 ms   | Scale up min-instances              |
| Retry rate                    | > 5%        | > 20%       | Check platform API status pages     |
| Duplicate dispatch rate       | > 0.1%      | > 1%        | Check event_id generation           |
| Cloud Run instance count      | at 80% max  | at max      | Increase max-instances              |

### Cloud Logging log-based metric for CAPI errors

```bash
gcloud logging metrics create et-capi-errors \
  --description="EasyTrac CAPI platform errors" \
  --log-filter='resource.type="cloud_run_revision" AND jsonPayload.success=false'
```

---

## 9 — Multi-client deployment patterns

### Pattern A — Single Cloud Run service, multi-client config in Firestore

**Recommended.** One sGTM + one EasyTrac service, client config in Firestore.

```
Client A → sGTM  →  EasyTrac Dispatcher  →  Firestore: et_clients/client-a
Client B → sGTM  →  EasyTrac Dispatcher  →  Firestore: et_clients/client-b
```

- CAPI tokens encrypted at rest in Firestore (AES-256-GCM)
- Platform enable/disable per client without redeployment
- Event map overrides per client

### Pattern B — Separate Cloud Run revisions per client tier

For large clients with strict isolation requirements:

```bash
# Deploy a dedicated revision with client-specific env vars
gcloud run services update easytrac \
  --tag client-a-prod \
  --set-secrets ET_META_CAPI_TOKEN=client-a-meta-token:latest
```

Use traffic splitting to route client-a requests to the dedicated revision.

### Pattern C — Separate Cloud Run services per client

Maximum isolation. Requires infrastructure automation (Terraform / Pulumi). Use only when contractual isolation is required.

---

## 10 — Pre-production checklist

```
[ ] sGTM Cloud Run service deployed with correct CONTAINER_CONFIG
[ ] Custom domain mapped and DNS CNAME verified
[ ] transport_url in Web GTM GA4 Config tag matches sGTM domain
[ ] All 4 .tpl template files imported into Server GTM workspace
[ ] Server container JSON imported (Merge mode)
[ ] All 4 custom template types resolve (no "unknown template" warnings)
[ ] CAPI tokens stored in Secret Manager (not hardcoded)
[ ] Secret Manager IAM binding for Cloud Run service account
[ ] ET_LOG_LEVEL=warning in production
[ ] ET_ENVIRONMENT=production set
[ ] min-instances >= 2
[ ] Cloud Monitoring alerts configured for CAPI error rate
[ ] Meta test_event_code validated via Events Manager Test Events tab
[ ] TikTok pixel test event confirmed in TikTok Events Manager
[ ] Snapchat CAPI test event confirmed in Snap Ads Manager
[ ] Google Ads conversion confirmed in Conversions dashboard (24–48 h delay)
[ ] End-to-end purchase event tested with real order
[ ] Deduplication confirmed: same event_id sent twice → only 1 CAPI hit per platform
```
