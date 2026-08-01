# Managed sGTM Hosting — Deployment Checklist

Public-safe checklist. It lists environment-variable **names**, whether each is
required or optional, and **placeholder** examples only. **Do not** put real
project IDs, service-account emails, domains, routes, buckets, or keys in this
repository — set real values only in your deployment platform's secret store.

> Fill values into a git-ignored `.env` (copied from the root `.env.example`) for
> local runs, and into your host's environment for production.

## 1. Environment variables

### Core

| Name | Req? | Purpose | Placeholder |
|---|---|---|---|
| `PORT` | optional | HTTP port (usually injected by the host). | `8080` |
| `NODE_ENV` | optional | Set `production` in prod (enables fail-closed admin login). | `production` |
| `ALLOWED_ORIGIN` | recommended | Allowed browser CORS origin(s), comma-separated. | `https://<your-domain>` |

### Firestore / Firebase Admin (required)

| Name | Req? | Purpose | Placeholder |
|---|---|---|---|
| `FIREBASE_SA_KEY_JSON` | required | Firebase Admin service-account JSON (minified, single line). | `{"type":"service_account", ...}` |

### Google Tag Manager (required for container creation)

| Name | Req? | Purpose | Placeholder |
|---|---|---|---|
| `GTM_SA_KEY_JSON` | required | GTM service-account JSON (minified, single line). | `{"type":"service_account", ...}` |
| `GTM_ACCOUNT_ID` | required | Numeric GTM account ID that hosts managed containers. | `<numeric-account-id>` |
| `GTM_ACCOUNT_IDS` | optional | Additional account IDs (capacity rollover), comma-separated. | `<id1>,<id2>` |
| `GTM_CONNECT_TIMEOUT_MS` / `GTM_RESPONSE_TIMEOUT_MS` / `GTM_OVERALL_TIMEOUT_MS` | optional | GTM API timeouts. | `<milliseconds>` |

### Encryption & shared secrets

| Name | Req? | Purpose | Placeholder |
|---|---|---|---|
| `MASTER_ENCRYPTION_KEY` | required | 64-hex-char (256-bit) key for token/blob encryption. | `<64-hex-chars>` |
| `API_KEY_SECRET` | optional | HMAC secret for client API keys. | `<random-secret>` |
| `AUDIT_HASH_SECRET` | optional | HMAC secret for hashing identifiers in audit logs. | `<random-secret>` |
| `BEACON_SECRET` | optional | Secret for the health-beacon endpoint. | `<random-secret>` |

### Admin access

| Name | Req? | Purpose | Placeholder |
|---|---|---|---|
| `ADMIN_SECRET_KEY` | **required in prod** | Secret exchanged for an HttpOnly admin session. Missing in prod → admin login disabled (fail-closed). | `<random-secret>` |
| `ADMIN_TOKEN` | optional | Bearer token for server-to-server admin calls (back-compat). | `<random-secret>` |
| `ADMIN_EMAILS` | optional | Allowlisted admin emails (comma-separated) for token-claim auth. | `<email1>,<email2>` |

### Managed provider & shards (required for Cloud Run hosting)

| Name | Req? | Purpose | Placeholder |
|---|---|---|---|
| `MANAGED_DEPLOY_PROVIDER` | optional | Hosting provider. Default is the Cloud Run path. | `cloudrun` |
| `MANAGED_SHARDS` | required* | JSON map of shard ID → `{ gcpProjectId, region, saKeyEnv }`. | `{"<shard-id>":{"gcpProjectId":"<gcp-project-id>","region":"<region>","saKeyEnv":"GCP_SA_KEY_<SHARD>"}}` |
| `MANAGED_DEFAULT_SHARD` | required* | Shard ID used for new tenants (a key in `MANAGED_SHARDS`). | `<shard-id>` |
| `GCP_SA_KEY_<SHARD>` | required* | Per-shard GCP service-account JSON (name matches `saKeyEnv`). | `{"type":"service_account", ...}` |
| `SGTM_BASE_DOMAIN` | required* | Wildcard base domain for tenant servers. | `sgtm.<your-domain>` |
| `SGTM_CLOUD_RUN_IMAGE` | optional | Override the default sGTM container image. | `<image-ref>` |

\* required when `MANAGED_DEPLOY_PROVIDER` uses the Cloud Run path.

### Lifecycle & trial

| Name | Req? | Purpose | Placeholder |
|---|---|---|---|
| `CONTAINER_DELETION_ENABLED` | optional | Kill-switch for tenant teardown. **Keep `false`** unless a deliberate teardown is intended. | `false` |
| `TRIAL_LAUNCH_AT` | optional | ISO date clamping the trial window start for pre-existing accounts. | `<iso-date>` |

### Async provisioning worker (optional — enable as a group)

| Name | Req? | Purpose | Placeholder |
|---|---|---|---|
| `CLOUD_TASKS_PROJECT` / `CLOUD_TASKS_LOCATION` / `CLOUD_TASKS_QUEUE` | optional | Cloud Tasks queue coordinates (offloads long provisioning jobs). | `<project>` / `<region>` / `<queue-id>` |
| `WORKER_BASE_URL` | optional | This service's own base URL for the worker callback. | `https://<your-service-host>` |
| `CLOUD_TASKS_OIDC_SA` | optional | Service-account email for the task's OIDC token. | `<sa-email>` |
| `INTERNAL_WORKER_SECRET` | required if worker enabled | Shared secret the internal worker route requires. | `<random-secret>` |

### Full-fidelity CAPI import (optional)

| Name | Req? | Purpose | Placeholder |
|---|---|---|---|
| `MANAGED_IMPORT_SERVER_CONFIG` | optional | `1` enables importing a full server config; default/off uses the static path. | `0` |
| `PROVISIONING_BUCKET` | required if import on | Private, same-region storage bucket for staged (encrypted) config blobs. | `<private-bucket-name>` |

### Monitoring / limits / platform

| Name | Req? | Purpose | Placeholder |
|---|---|---|---|
| `CLOUD_MONITORING_PROJECT` | optional | Project for metrics export. | `<project>` |
| `SECRET_MANAGER_PROJECT` | optional | Project for Secret Manager lookups. | `<project>` |
| `MANAGED_MAX_CONCURRENCY` / `MANAGED_QUEUE_MAX` | optional | Provisioning concurrency/queue caps. | `<number>` |
| `MAX_CONCURRENT_SCANS` | optional | Cap on concurrent headless scans. | `<number>` |
| `GOOGLE_CLOUD_PROJECT` / `GCP_PROJECT` / `K_SERVICE` / `RAILWAY_ENVIRONMENT` | injected | Set by the platform — do not set manually. | — |

### Legacy / dev-only

| Name | Req? | Purpose | Placeholder |
|---|---|---|---|
| `STAPE_API_KEY` / `STAPE_REGION` | optional | Only used by the legacy provider rollback path. | `<key>` / `<region>` |
| `NEXT_UI_ENABLED` (+ `MIGRATED_ROUTES`, `NEXT_UPSTREAM`, `NEXT_PROXY_TIMEOUT_MS`, `NEXT_FALLBACK_ROUTE`) | optional | UI-migration proxy seam. Keep **off** unless the new UI is live. | `false` |
| `ALLOW_DRY_RUN` / `ALLOW_DEGRADED_START` | optional | Local/testing conveniences. Leave unset in prod. | — |

> The edge router runs as its own small service and reads only `PORT` plus the
> shared Firebase/registry configuration.

## 2. Go-live checklist (generic)

- [ ] Firebase project created; Firestore enabled; `FIREBASE_SA_KEY_JSON` set.
- [ ] GTM service account created and granted account-level access; `GTM_SA_KEY_JSON` + `GTM_ACCOUNT_ID` set.
- [ ] `MASTER_ENCRYPTION_KEY` generated (64 hex chars) and stored in the host secret store.
- [ ] `ADMIN_SECRET_KEY` set (required in production).
- [ ] One or more Cloud Run shard projects prepared; `MANAGED_SHARDS`, `MANAGED_DEFAULT_SHARD`, and each `GCP_SA_KEY_<SHARD>` set.
- [ ] Wildcard domain + certificate provisioned once; `SGTM_BASE_DOMAIN` set.
- [ ] `CONTAINER_DELETION_ENABLED` left unset/`false`.
- [ ] `MANAGED_IMPORT_SERVER_CONFIG` left off unless `PROVISIONING_BUCKET` + `MASTER_ENCRYPTION_KEY` are configured.
- [ ] `ALLOWED_ORIGIN` set to your public origin(s).
- [ ] `npm run verify:gcp` passes.
- [ ] `npm test` reviewed (timing benchmarks are advisory — see RELEASE_NOTES).
- [ ] Post-deploy smoke: admin session endpoint returns unauthenticated without a session; a provisioning dry run (in a non-production shard) completes.

## 3. Rollback (configuration-only)

- Switch the hosting provider back to the legacy path by changing
  `MANAGED_DEPLOY_PROVIDER`; re-enable the legacy provider's credentials as
  needed.
- Turn off full-fidelity import by setting `MANAGED_IMPORT_SERVER_CONFIG` to `0`
  — re-checked at job time, so in-flight jobs revert to the static path.
- Both changes are environment-only and require no code change or redeploy of
  application logic beyond restarting with the updated configuration.
