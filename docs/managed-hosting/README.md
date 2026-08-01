# Managed sGTM Hosting

This directory documents the **managed server-side GTM (sGTM) hosting** feature:
the platform provisions and operates a server-side Google Tag Manager container
for each tenant, so customers get server-side tracking without running their own
infrastructure.

> **Scope & safety.** These documents are intentionally generic. They describe
> *how the system is structured* and *which configuration is required*, using
> variable **names** and **placeholder** examples only. They contain no real
> project IDs, service-account emails, domains, routes, credentials, or
> operational runbooks. Keep it that way — this repository is public.

## Contents

| File | Purpose |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Data flow, components, provisioning steps, fail-safe posture. |
| [`RELEASE_NOTES.md`](./RELEASE_NOTES.md) | What shipped in the managed-hosting release, and the test posture. |
| [`DEPLOYMENT-CHECKLIST.md`](./DEPLOYMENT-CHECKLIST.md) | Required/optional environment variables (names + placeholders) and a generic go-live checklist. |

## At a glance

- **Tracking model:** Web GTM forwards GA4 hits (via `transport_url`) to a
  server-side GTM container, which fans out to advertising platforms using
  **native Server GTM HTTP Request tags** (`type: "http"`). No community custom
  templates are embedded.
- **Hosting:** each tenant server runs on Cloud Run behind a wildcard edge
  domain. Provisioning is a resumable, step-based job.
- **Operations:** health/monitoring, a dead-letter retry path, a registry of
  provisioned resources, and an authenticated admin surface (secure cookie
  sessions) for trial and lifecycle controls.
- **Fail-safe defaults:** destructive teardown is **disabled by default**; the
  cleanup preview is read-only; when a required provider is unavailable, the
  teardown aborts without destroying anything.

## Configuration

All runtime configuration is via environment variables. The repository ships an
annotated `.env.example` at the project root; see
[`DEPLOYMENT-CHECKLIST.md`](./DEPLOYMENT-CHECKLIST.md) for the required/optional
matrix. Copy `.env.example` to a local, git-ignored `.env` and fill in values —
**never commit real values**.

## Verifying a build

```bash
npm run verify:gcp   # checks GCP/service-account configuration
npm test             # runs the test suite (see RELEASE_NOTES on timing benchmarks)
```
