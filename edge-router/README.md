# EasyTrack Edge Router

This Cloud Run service is the single wildcard backend for `*.sgtm.easytrac.io`.
It maps the host label to `managed_routes/{slug}` in Firestore, then proxies to
the tenant Cloud Run `run.app` URL.

## Required Env

- `SGTM_BASE_DOMAIN=sgtm.easytrac.io`
- `FIRESTORE_PROJECT_ID=<firebase-project-id>` or `GOOGLE_CLOUD_PROJECT`

The router uses the Cloud Run runtime identity and the metadata server for
Firestore REST auth. Do not ship service-account keys with this service.

## One-Time GCP Setup

1. Deploy the router to the shard project:
   `gcloud run deploy easytrack-edge-router --source edge-router --allow-unauthenticated --min-instances=1`
2. Grant the router service account `roles/datastore.viewer` on the Firebase project.
3. Reserve a global static IP.
4. Create DNS authorization and a Google-managed wildcard cert for `*.sgtm.easytrac.io`.
5. Create an external HTTPS load balancer:
   - serverless NEG pointing at `easytrack-edge-router`
   - backend service using that NEG
   - URL map with a single default backend
   - target HTTPS proxy with the wildcard cert
   - forwarding rule on the global static IP
6. Add wildcard DNS: `*.sgtm.easytrac.io -> <global static IP>`.

## Smoke Test

- `GET https://anyslug.sgtm.easytrac.io/__edge/healthz` should return `{ "ok": true }`.
- Create `managed_routes/{slug}` with:
  - `status: "active"`
  - `taggingRunUrl: "https://...run.app"`
  - `previewRunUrl: "https://...run.app"`
- `GET https://{slug}.sgtm.easytrac.io/healthy` should proxy to `taggingRunUrl`.
- `GET https://{slug}-preview.sgtm.easytrac.io/healthy` should proxy to `previewRunUrl`.

## Cache Behavior

- active routes are cached for 5 minutes
- missing/inactive routes are cached for 30 seconds
- max cache size is 10,000 route entries
