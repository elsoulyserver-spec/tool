# EasyTrack Managed sGTM Hosting — Technical Feasibility Study

**Date:** 2026-07-05
**Question:** Can EasyTrack replace Stape by provisioning server-side GTM containers directly on Google Cloud?
**Short answer:** **Yes — technically straightforward, economically excellent.** Cloud Run + one wildcard load balancer gives you Stape-equivalent infrastructure at ~$1–4/store/month COGS vs Stape's $20/store retail. The provisioning code EasyTrack already has (server container creation + `CONTAINER_CONFIG` extraction in `gtm-service.js`) is ~40% of the work.

---

## 1. Google Cloud Run — capability verification

Every requirement checks out:

| Requirement | Verdict | How |
|---|---|---|
| Programmatically create services | ✅ | Cloud Run Admin API v2 — `POST https://run.googleapis.com/v2/projects/{p}/locations/{l}/services?serviceId={id}` |
| Deploy official GTM image | ✅ | `gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable` is Google's supported image; the manual-setup guide explicitly documents running it on any Docker platform (this is exactly what Stape/Taggrs do) |
| Pass env vars automatically | ✅ | `template.containers[].env` in the create request (`CONTAINER_CONFIG`, `PREVIEW_SERVER_URL`, etc.) |
| Hundreds of customer services | ✅ | Default quota is on the order of ~1,000 services/region/project (verify in your console; increasable). Shard across projects past ~400 customers (2 services/customer incl. preview) |
| Custom domains | ✅ but **not** via built-in Domain Mapping (preview-only, no wildcards, not production-recommended). Use a Global External ALB + serverless NEG with a **URL mask** — see §4 |
| Automatic SSL | ✅ | Google-managed wildcard certificate (`*.easytrack.io`) via Certificate Manager DNS authorization — one cert covers every customer |
| Auto-scaling | ✅ | Native; `scaling.maxInstanceCount` per service. Scale-to-zero supported |
| Suspend idle services | ✅ | Manual scaling with instance count 0, or set `ingress: INGRESS_TRAFFIC_INTERNAL_ONLY` (your "Smart Pause" equivalent) |
| Restart services | ✅ | No literal restart; deploy a no-op revision (update an annotation) — atomically replaces all instances |

**Auth:** one GCP service account with `roles/run.admin` + `roles/iam.serviceAccountUser`, key or (better) workload identity, used from the Node backend via `google-auth-library` — same pattern EasyTrack already uses for the GTM API.

**Node SDK example (`@google-cloud/run`):**

```js
const { ServicesClient } = require('@google-cloud/run').v2;
const client = new ServicesClient(); // uses GOOGLE_APPLICATION_CREDENTIALS

async function createTaggingServer({ projectId, region, customerId, containerConfig }) {
  const [operation] = await client.createService({
    parent: `projects/${projectId}/locations/${region}`,
    serviceId: customerId,                       // becomes {customerId}.easytrack.io via URL mask
    service: {
      labels: { tenant: customerId, product: 'sgtm' },
      ingress: 'INGRESS_TRAFFIC_ALL',
      template: {
        containers: [{
          image: 'gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable',
          env: [
            { name: 'CONTAINER_CONFIG', value: containerConfig },
            { name: 'PREVIEW_SERVER_URL', value: `https://${customerId}-preview.easytrack.io` },
          ],
          resources: { limits: { cpu: '1', memory: '512Mi' } },
        }],
        scaling: { minInstanceCount: 0, maxInstanceCount: 3 }, // min 1 for paid "always-warm" tier
        timeout: { seconds: 60 },
      },
    },
  });
  return operation.promise(); // long-running op → resolved Service with .uri
}
```

The preview server is a second, near-identical service (`{customerId}-preview`) with `RUN_AS_PREVIEW_SERVER=true`, `maxInstanceCount: 1`, `minInstanceCount: 0` — costs ~nothing because it only runs during debug sessions.

**Key docs:**
- Cloud Run setup guide for sGTM: https://developers.google.com/tag-platform/tag-manager/server-side/cloud-run-setup-guide
- Manual (any-Docker) setup: https://developers.google.com/tag-platform/tag-manager/server-side/manual-setup-guide
- Admin API v2 services: https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.services
- Serverless NEG + URL masks: https://cloud.google.com/load-balancing/docs/negs/serverless-neg-concepts
- GTM API container create (`usageContext: ['server']`): https://developers.google.com/tag-platform/tag-manager/api/v2/reference/accounts/containers/create

---

## 2. Cost analysis

**Traffic model per small-to-medium store:** ~50–150k pageviews/mo → ~200k incoming sGTM requests/mo (pageviews + ecommerce events), each fanning out to 4 destinations (Meta, TikTok, Snapchat, GA4). Fan-out costs CPU-time and egress, not request fees.

**Cloud Run unit costs (Tier-1 region, 2026):** $0.000024/vCPU-s, $0.0000025/GiB-s, $0.40/M requests. Free tier: 180k vCPU-s + 360k GiB-s + 2M requests/mo.

**Per-store/month (min-instances=0):** requests $0.08 + CPU (~100ms/req incl. fan-out) $0.48 + egress ~$0.20 ≈ **$0.75–1.50**. Warm tier (min=1, CPU-throttled → idle billed memory-only): +~$3.30. Call it **$1–4/store**.

| Stores | Cloud Run (min=0 + LB $20) | Cloud Run (all warm) | Hetzner VPS self-managed | DigitalOcean | Railway | Stape resell ($20/store) |
|---|---|---|---|---|---|---|
| 10 | **~$25** (mostly free tier) | ~$55 | ~€8 (2× CX22) | ~$18 | ~$50–100 | $200 |
| 50 | **~$70** | ~$240 | ~€23 (6× CX22) | ~$48 | ~$250–500 | $1,000 |
| 100 | **~$130** | ~$460 | ~€45 | ~$90 | ~$500–1,000 | $2,000 |
| 500 | **~$570** | ~$2,200 | ~€200 + ops hire | ~$420 + ops | $2,500–5,000 | $10,000 |

Notes:
- **Hetzner** (CX22 2vCPU/4GB ≈ €3.79, ~10 sGTM containers each) is the cheapest raw compute but you inherit everything Cloud Run gives free: TLS, autoscaling, isolation, monitoring, zero-downtime deploys, patching. At 500 stores that's a full-time SRE — which erases the savings.
- **Railway** prices per-service with weak scale-to-zero economics; structurally wrong for 100s of small services (and per project memory: Railway is already a pain point for this repo).
- **Stape reselling** has zero infra work but zero margin structure: at $20/store COGS you can't undercut Stape's own retail price.
- **Margin math:** sell at $15–25/store → **85–95% gross margin** on Cloud Run.

Sources: [Cloud Run pricing](https://cloud.google.com/run/pricing), [Stape pricing](https://stape.io/price) (free 10k; Pro ~$20/mo 500k req; Business ~$83/mo 5M; Enterprise ~€167/mo 20M; April 2026 "Smart Pause" at 110% usage), [TAGGRS pricing](https://taggrs.io/prices/) (Free 10k; Basic €22/750k; Pro €57/3M; Ultimate €127/10M), [Hetzner](https://www.hetzner.com/cloud), [Stape vs Cloud Run analysis](https://analyzify.com/hub/google-cloud-run-vs-stape-pricing), [DIY threshold guide](https://seresa.io/blog/server-side-gtm/gcp-sgtm-vs-stape-when-diy-server-side-gtm-makes-sense).

---

## 3. Multi-tenant architecture: A (per-customer service) — and it's not really a choice

The official image binds **one GTM server container per process** via `CONTAINER_CONFIG`. There is no supported multi-tenant mode; a shared cluster would require a custom routing proxy in front of per-tenant sGTM processes anyway — you'd rebuild option A inside Kubernetes with more moving parts.

| Dimension | A: service per customer (Cloud Run) | B: shared cluster (GKE + custom router) |
|---|---|---|
| Cost | ~$1–4/store; scale-to-zero for idle | GKE base ~$75/mo + nodes; cheaper only past ~1,000 dense tenants |
| Isolation | Hard isolation per service (memory, crash, noisy-neighbor) | Process/namespace level; one bad tenant can degrade others |
| Security | Per-service identity, per-tenant env secrets | Shared attack surface, custom router is security-critical code |
| Scalability | Per-tenant autoscaling knobs = your pricing tiers | Cluster-level; per-tenant limits need custom work |
| Maintenance | None (managed); image updates = rolling redeploy script | You run Kubernetes |
| Billing attribution | Free via per-service metrics/labels | Custom metering required |

**Verdict: A.** Per-service request metrics also give you usage-based plan enforcement (Stape's core mechanic) for free.

---

## 4. Domain management: wildcard DNS + one load balancer + URL mask

The startup-friendly answer requires **zero per-customer domain work**:

1. **DNS:** one wildcard record `*.easytrack.io → A <LB IP>` (any DNS host; Cloud DNS optional).
2. **Cert:** one Google-managed wildcard certificate for `*.easytrack.io` (Certificate Manager, DNS authorization — one TXT record, auto-renews forever).
3. **LB:** one Global External Application Load Balancer with a single serverless NEG using URL mask `<service>.easytrack.io` — the LB extracts the subdomain and routes to the Cloud Run service of the same name. Creating a service named `acme` instantly makes `acme.easytrack.io` live. No LB config change per customer.
4. Cost: ~$18–25/mo total (forwarding rule + data processing) — amortized across all customers.

Rejected alternatives:
- **Cloud Run Domain Mapping:** preview status, no wildcards, per-domain cert wait, [not recommended for production](https://cloud.google.com/run/docs/mapping-custom-domains).
- **Caddy/Nginx on a VPS** (wildcard DNS-01 cert, host→`*.run.app` proxy): works, ~$5/mo, but it's a SPOF you patch and scale yourself, and it hides client IPs unless carefully configured (sGTM needs true client IP via `X-Forwarded-For` for geo/IP-based matching). Only worth it pre-revenue.
- **Customer's own domain** (`track.customerstore.com` — Stape's premium feature): add per-domain certs to the same LB via Certificate Manager (~$0.20/cert/mo after free allowance) + customer creates one CNAME. Ship this in phase 2.

---

## 5. Provisioning API design

All endpoints live in the existing Node backend, authenticated by EasyTrack session + tenant ownership check. Internally each wraps Cloud Run Admin API / Cloud Logging / Cloud Monitoring calls with the provisioner service account.

| Endpoint | Internals |
|---|---|
| `POST /api/servers` (create) | 1) GTM API: create server container (`usageContext:['server']` — **already implemented** in `gtm-service.js`), 2) read `containerConfig`, 3) `services.create` × 2 (main + preview), 4) poll LRO until ready, 5) store `{customerId, serviceName, region, uri}` in Firestore, 6) health-check `https://{sub}.easytrack.io/healthy` |
| `POST /api/servers/:id/restart` | `services.patch` with a bumped `restartedAt` annotation → new revision, zero-downtime replace |
| `DELETE /api/servers/:id` | `services.delete` (main + preview) + soft-delete Firestore doc; keep GTM container (customer's data) |
| `GET /api/servers/:id/health` | Hit `/healthy` on the service + read Cloud Monitoring `run.googleapis.com/request_count` & latency for last hour |
| `GET /api/servers/:id/logs` | Cloud Logging API `entries.list`, filter `resource.labels.service_name="{svc}"`, page + redact |
| `GET /api/servers/:id/usage` | Monitoring time series of `request_count` for the billing period → enforce plan quota; over-quota → suspend (manual scaling 0 / ingress internal) like Stape's Smart Pause |

Also needed (not in the original list): `POST /api/servers/:id/suspend`, `/resume`, and a nightly Cloud Scheduler job that (a) meters usage → Firestore, (b) redeploys N oldest services to pick up new `:stable` image (Cloud Run pins the digest at deploy time — updates are **not** automatic; a monthly rolling redeploy script is the standard fix).

---

## 6. GTM Server container verification

- **Safe on Cloud Run:** yes — Cloud Run is one of Google's two officially documented deployment targets for this exact image; it's stateless and health-checked at `/healthy`.
- **Automatic deployment:** yes — image is public on gcr.io, no auth needed to pull; `CONTAINER_CONFIG` is the only required config and EasyTrack already extracts it.
- **Automated updates:** yes, with the caveat above — `:stable` tag is resolved at deploy; schedule rolling redeploys (monthly is plenty; Google updates the image a few times a year).
- **Isolated environments per customer:** yes — separate GTM server container (own workspace/versions/preview) + separate Cloud Run service + separate preview server. Debug/preview works per customer via `PREVIEW_SERVER_URL`.

---

## 7. Competitive position

| | Stape | TAGGRS | EasyTrack (buildable) |
|---|---|---|---|
| Entry price | Free 10k / ~$20 Pro 500k | Free 10k / €22 Basic 750k | Can match or beat at 90% margin |
| Global anycast multi-region | ✅ (enterprise infra) | partial | ❌ MVP single-region (fine for KSA/GCC-focused stores; add region choice later) |
| Custom domain (`track.store.com`) | ✅ paid add-on | ✅ | Phase 2 (Certificate Manager per-domain cert) |
| Power-ups (cookie keeper, user-ID, geo headers, bot detection) | ✅ big moat | some | Partially — EasyTrack's `.tpl` template library (Meta/TikTok/Snap/GA4 CAPI + cookie-writer + beacon) is the same category of moat, and Arabic/GCC-localized |
| Auto sGTM config (tags pre-built) | ❌ manual/paid setup | ❌ | ✅ **EasyTrack's differentiator** — it already generates full container configs programmatically |
| Usage metering + pause | ✅ | ✅ | ✅ buildable (Monitoring API) |
| WAF/DDoS, SLAs, ISO/SOC2 | ✅ | partial | ❌ enterprise-tier; Cloud Armor later, compliance much later |

**Realistic in 3 months (MVP):** provisioning + wildcard domains + usage metering/quotas + suspend/resume + logs/health dashboard + auto-configured containers from existing templates + rolling image updates.
**Enterprise-only (don't attempt now):** multi-region anycast, SOC2/ISO, DDoS/WAF guarantees, 99.9% SLA, marketplace of 50+ power-ups.

*(TagHive: negligible public footprint — not a pricing reference; ignore.)*

---

## 8. Architectures

**MVP (0–500 stores, one GCP project):**

```
Customer store ──▶ *.easytrack.io (wildcard DNS)
                        │
              Global External ALB  ← one wildcard cert (*.easytrack.io)
                        │  serverless NEG, URL mask "<service>.easytrack.io"
        ┌───────────────┼────────────────┐
   Cloud Run svc    Cloud Run svc    Cloud Run svc ...   (1 per customer, min=0/1, max=3)
   [gtm-cloud-image + CONTAINER_CONFIG_n]   + tiny per-customer preview svc (min=0)
                        │ fan-out
              Meta CAPI / TikTok / Snapchat / GA4

   EasyTrack Dashboard ─▶ Node backend (existing) ─▶ Cloud Run Admin API / GTM API /
                          Logging / Monitoring      Firestore (tenant registry, usage)
                          Cloud Scheduler: nightly metering + monthly rolling redeploy
```

**Scale (1,000+ stores):** shard customers across GCP projects (~400/project for quota headroom), keep one LB (NEGs can point cross-project or run one LB per project + per-shard DNS), add second region + geo-DNS for EU/US customers, move metering to BigQuery export of request logs, add Cloud Armor. Nothing in the MVP has to be thrown away — sharding is additive.

---

## 9. Risks & limitations

1. **Cold starts on scale-to-zero** (~0.5–3s): first beacon after idle can be slow; browsers usually retry/`keepalive`, but some event loss is possible on dormant stores. Mitigation: min-instances=1 for paid tiers (+$3.30/mo — price it in), min=0 only for free/trial.
2. **Image updates not automatic** — must schedule rolling redeploys (solved with one Scheduler job).
3. **Quota ceilings** — services/project (~1,000 default) and Admin API write rates; plan project sharding at ~400 customers, request quota raises early.
4. **`CONTAINER_CONFIG` handling** — it's a credential-equivalent blob; store encrypted (crypto-vault already exists in this repo).
5. **Single region MVP** — GCC-focused traffic is fine from `europe-west` / `me-central`, but EU/US privacy-driven buyers will ask for region choice (Stape sells this).
6. **Google dependency** — same image, same cloud as Google's own recommended path; risk is low but pricing/API changes hit everyone (incl. Stape) equally.
7. **Support burden is the real product** — Stape's value is debugging customers' tagging, not hosting. The template auto-config reduces this but budget human time for it.
8. **⚠️ Existing repo issue:** the public deploy repo leaks `.env` admin keys (known issue) — must be fixed before holding hundreds of customers' `CONTAINER_CONFIG`s and GCP keys.

---

## 10. Final recommendation

**Build on Cloud Run now. Do not build VPS infra. Do not resell Stape.**

- **Cloud Run** — ✅ chosen: managed, isolated, scale-to-zero, ~$1–4/store COGS, all provisioning APIs verified, and EasyTrack's existing GTM-API/container-config code is the hard 40% already done.
- **VPS (Hetzner/DO)** — ❌ as primary: cheapest raw compute but you become an SRE shop (TLS, isolation, patching, scaling, monitoring) before you have revenue. Revisit only past ~5M req/store enterprise accounts where dedicated capacity wins.
- **Railway** — ❌ structurally wrong for many small services.
- **Stape temporarily** — ❌ even short-term: $20/store COGS kills pricing power, and migration later means re-pointing every customer's DNS. The Cloud Run MVP is ~2–4 weeks of work — cheaper than one quarter of reselling.

---

## 11. Operational limits & sharding (verified 2026-07)

### Verified quotas

| Limit | Value | Type | Impact |
|---|---|---|---|
| Cloud Run services per region per project | **1,000 — HARD limit, cannot be increased** (confirmed by Google staff on dev forums) | Hard | At 2 services/customer (main + preview): **max ~500 customers per project-region**; with headroom, plan 350–400 |
| Max instances per service | 1,000 default (increasable) | Soft | Irrelevant at our scale (max 3–10/tenant) |
| Concurrent requests per instance | 80 default / up to 1,000 | Config | One warm instance handles a small store trivially |
| Cloud Run Admin API rate | Per-60-second buckets, project-scoped; exact default varies — **check IAM & Admin → Quotas → `run.googleapis.com` in console** | Soft | Provisioning = 4–6 write calls/customer; even a conservative 60 writes/min supports ~10 provisions/min. Queue + exponential backoff on 429 |
| Domain mappings (built-in) | Preview feature, low quota, no wildcards | — | **Not used** in our architecture; irrelevant |
| Certificate map entries (Certificate Manager) | Thousands by default, scales to millions | Soft | Custom `track.customer.com` domains effectively unlimited; ~$0.20/cert/mo past free allowance |
| Wildcard `*.easytrack.io` | 1 cert covers all subdomains | — | Zero per-customer cert work |

### Scale-to-zero & cold starts (Q4/Q5)

- **Scale-to-zero runs fine** — the image is stateless; Cloud Run holds the incoming request while an instance boots, and idle instances linger up to ~15 min before shutdown, so bursty stores rarely cold-start.
- **But Google officially recommends min 2 instances** for production tagging servers "to reduce the risk of data loss in case of a server outage" (the official setup command ships `--min-instances 2 --max-instances 10`).
- **Cold starts ≠ automatic event loss.** `navigator.sendBeacon`/`fetch keepalive` requests survive page unload and Cloud Run queues them during startup (sGTM boots in ~0.5–3s, worst case ~10s). Loss happens at the margins: instance startup failures, startup slower than browser keepalive limits, or sharp bursts against a zero-warm fleet.
- **Policy:** free/trial tier min=0 (accept marginal loss, disclose it); paid tiers min=1 (~+$3.3/mo COGS); premium/"guaranteed" tier min=2 (~+$6.6/mo) matching Google's production guidance. Preview services always min=0 (debugger tolerates a 2s wait).

### What Stape and TAGGRS actually run (Q6)

- **Stape:** runs on **Google Cloud data centers** (their own docs/legal state GCP-hosted infrastructure, multiple selectable regions). Project topology is not public, but given the same 1,000-services hard cap applies to them, a multi-project sharded fleet is the only way to run their tens of thousands of containers — i.e., the sharding design below is the industry-standard one.
- **TAGGRS:** explicitly **not** on Google — their own 100% EU infrastructure (own racks, 2N power) running the sGTM Docker image, GDPR positioning. This validates the manual-setup/self-host path too, but at a much higher ops investment than a startup should take on.

### Project sharding strategy (Q7)

Control plane in all cases: Firestore registry `tenant → {projectId, region, serviceName, lbHostname}`; a provisioner that picks the least-full shard; per-shard service accounts; Cloud Monitoring/Logging aggregated per shard (BigQuery export at scale).

| Scale | Projects | Layout |
|---|---|---|
| **100 customers** | **1 project** | 200 services in one region = 20% of quota. One LB + wildcard cert + URL mask. No sharding code needed yet — but write the registry from day one so sharding is additive. |
| **1,000 customers** | **3–4 projects** (~300–350 customers each) | 2,000 services exceeds the hard cap → sharding is mandatory. One LB + wildcard cert **per shard project** (serverless NEGs must target same-project Cloud Run). DNS: stop relying on pure wildcard — provisioner creates a per-customer record via Cloud DNS API pointing the subdomain at its shard's LB IP (keep the wildcard as a fallback to shard 1). Projects created via Resource Manager API under one folder; request billing-account project-limit raise early. |
| **10,000 customers** | **~25–30 projects**, multi-region | Same pattern, industrialized: Terraform/Config-Controller-managed shard projects; provisioning queue smooths Admin API write rates; per-customer DNS fully automated; usage metering via Logging → BigQuery instead of per-service Monitoring reads; dedicated projects for whale tenants; quota-increase relationship with Google account team. At this size, re-evaluate GKE for the *dense low-traffic* cohort (thousands of min=1 instances is where Kubernetes bin-packing starts beating Cloud Run pricing) — but that's a margin optimization, not a blocker. |

**Design rule:** the only thing that must exist on day 1 to make all of this painless later is the **tenant→shard registry**. Everything else (more projects, more LBs, per-customer DNS records) bolts on without migrating existing customers.

### Preview server requirement — verified (2026-07)

Question: does each customer really need 2 Cloud Run services (tagging + preview)?

**Facts established from official docs (manual setup guide, Cloud Run setup guide, private-preview-server guide, Simo Ahava's walkthrough):**

1. **Preview is NOT required for production traffic.** `PREVIEW_SERVER_URL` only tells the tagging server where to forward requests carrying the preview cookie / `X-Gtm-Server-Preview` header. Non-preview events are processed and fanned out normally whether or not a preview server exists. No preview server = debugging doesn't work; tracking is unaffected.
2. **Preview and production cannot share a multi-instance service.** The image runs in one mode per process (`RUN_AS_PREVIEW_SERVER=true` vs `PREVIEW_SERVER_URL=...`), and the manual guide mandates "exactly 1 preview server" because debug sessions are held in that single instance's memory.
3. **Single-service dual mode exists but is testing-grade only.** Google's own App Engine "testing" deployment is one server doing both preview and production — it works only while there is exactly one instance. On Cloud Run that means `max-instances=1`: no autoscaling headroom, preview breaks whenever a second instance appears (including during deploys). Not acceptable for a paid product.
4. **The preview service costs ~nothing and needs no LB/DNS slot.** Official pattern: preview at `min=0 / max=1` (idle = $0). The GTM debug UI enters through the *production* URL; the tagging server forwards to the preview service's deterministic `run.app` URL. So preview consumes only a **quota slot**, never LB config.
5. **Stape/TAGGRS internals are not public.** Stape (on GCP, same image, same constraints) and TAGGRS (own EU infra) both expose instant preview on the production URL — consistent with running a per-container preview process behind header/cookie routing, i.e., the same architecture. Neither documents an escape from the 1-preview-process-per-container requirement, because the image doesn't offer one.

**Minimum services per customer:**

| Mode | Services/customer | Notes |
|---|---|---|
| Documented production pattern | 2 (preview min=0) | Default at launch — simple, preview always instant |
| Preview GC (recommended at scale) | ~1.05–1.2 steady state | Delete preview services idle >30 days; recreate on demand with the **same service name** → same run.app URL → tagging service env needs no patch. First debug after GC waits ~30–60s for recreation. |
| Single service max=1 ("testing mode") | 1 | Only for free/trial tier if ever; capped capacity, fragile preview |

**Corrected shard density:** launch at 2 svc/customer → plan 350–400 customers/shard (500 hard). With preview GC → **~800–900 customers/shard** planned. This roughly halves the number of shard projects at 1k/10k customers (Q7 table becomes: 1,000 customers → 2 projects; 10,000 → ~12–15), but keep the original conservative numbers for planning until preview GC is actually built.

---

## 12. 48-hour launch plan (target: 2026-07-07)

**Principle:** the *structure* (routing, SSL, naming, registry) is built right on day 1 because it can't be retrofitted without customer-visible migration. The *labor* (deploys, custom domains, monitoring) is manual behind an async "provisioning…" status, because labor can be automated later with zero customer impact.

### Launch architecture

```
customer.easytrack.io ─▶ wildcard DNS ─▶ Global ALB (wildcard cert, URL-mask NEG)
                                             └▶ Cloud Run svc "<customer>"  (min=1, max=3)
                                                 gtm-cloud-image + CONTAINER_CONFIG
                                                 └▶ preview svc "<customer>-preview" (min=0, max=1)
Dashboard "Create server" ─▶ existing GTM flow (server container + Meta/TikTok/Snap/GA4
   config from .tpl templates) ─▶ Firestore doc {status:'provisioning', shard:'prod-1'}
   ─▶ Telegram/email ping to operator ─▶ operator runs scripts/provision-sgtm.js <id>
   ─▶ script deploys 2 services, health-checks /healthy, flips status:'active'
   ─▶ dashboard polls → shows customer.easytrack.io + green badge
```

Customer promise: "server ready within 60 minutes." Operator reality: ~10 minutes of script time. Fully-managed appearance, zero Cloud Run Admin API integration needed for launch.

### Build order & estimates (~20h)

| # | Task | Est | Notes |
|---|---|---|---|
| 1 | GCP project `<gcp-project-id>`, enable APIs, provisioner SA | 0.5h | **Start tonight** |
| 2 | Wildcard cert `*.easytrack.io` (Cert Manager, DNS authz TXT) | 0.5h + wait | Validation can take hours — first task |
| 3 | Global ALB: static IP → cert map → serverless NEG, URL mask `<service>.easytrack.io` | 2h | One-time; makes every future service instantly routable |
| 4 | Wildcard DNS `*.easytrack.io → LB IP` (+ `edge.easytrack.io` A record for custom-domain CNAMEs) | 0.25h | |
| 5 | `scripts/provision-sgtm.js` — Firestore read → deploy preview + tagging svc → poll `/healthy` → status flip | 4h | Shell out to gcloud; SDK later |
| 6 | E2E test: real store → container config with all 4 platforms → live events in Meta Test Events / TikTok / GA4 DebugView | 3h | **Launch blocker check** — verifies the `fix/sgtm-container-import` work; managed containers previously shipped GA4-only |
| 7 | Dashboard: create-server → 'provisioning' status UI → poll → show URL + health badge | 4h | Reuse existing /api/ss/* + health-service |
| 8 | Operator alert on new provisioning request (Telegram webhook) | 1h | |
| 9 | Custom-domain runbook + one dry run (per-domain managed cert → cert-map entry; customer CNAMEs to `edge.easytrack.io`) | 1h | Manual per customer (~15 min + cert wait) |
| 10 | Billing alert on GCP project + buffer/polish | 3h | |

### Manual at launch (fine) vs automated at launch (required)

**Manual:** running the provision script; custom-domain onboarding; suspension (`gcloud ... --ingress=internal`); usage watching (billing alert); image updates (irrelevant for weeks).
**Automated/structural:** container config generation with 4 platforms (exists); wildcard routing + SSL (URL mask = zero per-customer config); dashboard status flow (hides the manual labor); `/healthy` check behind the badge; **Firestore registry with a `shard` field from day 1** (constant `prod-1` now — this one field is what makes Phase 3 additive).

### Postponed

Phase 2 (weeks 1–2): backend-triggered provisioning (move script code behind a queue worker — same code, new trigger), custom-domain automation, usage metering + plan quotas, suspend/resume endpoints, log viewer.
Phase 3 (first shard ≥ ~300 customers): shard picker + project #2, per-customer DNS records, preview GC, multi-region.
Not before product-market fit: WAF/Cloud Armor, SOC2, power-up marketplace, GKE bin-packing.

### Launch risks

1. **Cert/LB propagation** — infra tonight, not launch morning.
2. **CAPI tags in managed containers** — task 6 is the only true blocker; everything else degrades gracefully.
3. **Provisioner credentials** — operator machine / Railway env only; NEVER the public deploy repo (known .env leak).
4. **min-instances=1 on tagging services** at launch (~$3/customer/mo) — no cold-start complaints in week 1; tune later.
