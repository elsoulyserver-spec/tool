# Managed sGTM Hosting — Architecture

Generic overview of the managed hosting system. No environment-specific values.

## 1. Tracking data flow

```
Browser
  │  (web GTM container)
  ▼
GA4 tag  ──transport_url──►  Server-side GTM container (per tenant)
                                   │  GA4 Client receives /g/collect
                                   ▼
                            Native HTTP Request tags (type: "http")
                                   │
             ┌─────────────────────┼─────────────────────┐
             ▼                     ▼                     ▼
     Meta Conversions API   TikTok Events API     Snapchat CAPI
```

- The server container forwards platform events with **native Server GTM HTTP
  Request tags** (`type: "http"`). Each destination tag carries `url`, `method`
  (`POST`), `requestBody`, and a `headers` list; auth is supplied via GTM
  variables referenced inside the URL/headers.
- `containerVersion.customTemplate` is **empty** — the system does **not** embed
  or depend on any community custom template.
- An optional presence "beacon" HTTP tag emits lightweight signals used for
  health diagnostics.

## 2. Components

| Layer | Responsibility |
|---|---|
| **Shard registry / providers** | Selects the target infrastructure "shard" and hosting provider for a new tenant. Cloud Run is the default provider; a legacy provider path exists for rollback. Adding a shard is configuration-only. |
| **Provisioning runner + steps** | A resumable, idempotent job that builds and deploys a tenant's server container and wiring. |
| **Edge router** | A lightweight reverse proxy that maps tenant hostnames (under a wildcard domain) to the correct backend server. |
| **Monitoring / health** | Periodic health evaluation, diagnostics, metrics, and an activity timeline. |
| **Reliability** | A dead-letter queue (DLQ) worker retries failed deliveries; an SSRF guard constrains outbound requests; config blobs are encrypted at rest. |
| **Registry / admin services** | Persists provisioned resources and exposes an authenticated admin surface (client profiles, API keys, audit log). |
| **Trial / lifecycle** | Server-derived free-trial state and admin lifecycle controls (mark paid/unpaid, preview + teardown of tenant infrastructure). |

## 3. Provisioning steps

The runner executes an ordered, resumable sequence. Each step is idempotent so a
failed job can be retried without duplicating resources:

1. **create-gtm** — ensure the tenant's server GTM container exists.
2. **deploy-cloudrun** — deploy the tenant tagging service.
3. **deploy-preview** — deploy the preview/debug service.
4. **wire-transport** — point the web container's GA4 transport at the server.
5. **publish-route** — register the tenant hostname with the edge router.
6. **health-check** — verify the tenant server responds.
7. **finalize** — record the provisioned resources in the registry.

## 4. Admin authentication

- The admin dashboard authenticates by exchanging a configured secret for an
  **HttpOnly cookie session** (no token stored in browser JavaScript).
- State-changing admin requests require **CSRF protection** and a same-origin
  check.
- In production, admin login is **fail-closed**: if the admin secret is not
  configured, login is disabled rather than left open.

## 5. Fail-safe / non-destructive posture

- **Container deletion is disabled by default** and gated behind an explicit
  configuration flag. Even an authenticated admin cannot trigger teardown while
  the flag is off.
- **Cleanup preview is read-only** — it reports eligibility and the resources a
  teardown *would* remove, without modifying anything, and without exposing
  credentials or provider payloads.
- **Backend re-validates eligibility** (trial expired **and** unpaid **and** not
  already deleted) on every teardown request; the frontend preview is never
  trusted.
- **Provider-unavailable is non-destructive** — if the infrastructure provider
  needed to complete a teardown is not available, the operation aborts and
  nothing is marked deleted. Partial failures are reported honestly.
- **Trial dates are server-derived** from a trusted server timestamp; client-
  supplied dates are never trusted.

## 6. Configuration surface

Selection of provider, shards, domains, storage, and feature flags is entirely
via environment variables. See [`DEPLOYMENT-CHECKLIST.md`](./DEPLOYMENT-CHECKLIST.md)
for the variable matrix (names + placeholders).
