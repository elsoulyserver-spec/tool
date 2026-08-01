# Managed sGTM Hosting — Release Notes

## Managed hosting (initial release)

### Highlights

- **Native HTTP server-config tags.** The server-side container generates native
  Server GTM HTTP Request tags (`type: "http"`) for Meta, TikTok, and Snapchat,
  each with `url` / `method` / `requestBody` / `headers`. `customTemplate` is
  emitted empty — the retired community-custom-template path is no longer part of
  the generated container.
- **Cloud Run hosting provider + shard selection.** Tenants are placed on a
  configurable shard; adding capacity is configuration-only. A legacy provider
  path is retained for rollback.
- **Resumable provisioning runner** with idempotent steps (GTM container, Cloud
  Run tagging + preview services, transport wiring, route publication, health
  check, finalize/registry).
- **Edge router** mapping tenant hostnames under a wildcard domain to backends.
- **Monitoring & reliability:** health evaluation, diagnostics, metrics, activity
  timeline, and a dead-letter retry worker.
- **Registry & admin services:** provisioned-resource registry, client profiles,
  API keys, and an audit log.
- **Secure admin surface:** secret-key login exchanged for an HttpOnly cookie
  session; CSRF + same-origin protection on state-changing requests; production
  fail-closed when the admin secret is unset.
- **Server-derived free trial:** trial state is computed from a trusted server
  timestamp; client-supplied dates are ignored.
- **Safe lifecycle controls:** container teardown is **disabled by default**,
  offers a **read-only cleanup preview**, re-validates eligibility on the
  backend, and is **non-destructive when the provider is unavailable**.

### Server-config test alignment

The server-config contract tests were aligned to the native HTTP architecture:
they assert native `http` destination tags, per-destination endpoints, request
bodies, JSON header lists, `ONCE_PER_EVENT` firing, and an empty
`customTemplate`. Assertions tied to the retired custom-template contract were
retired. A legacy provisioning helper test was migrated from a third-party test
framework to the built-in Node test runner.

### Test posture

- **All correctness tests pass.**
- The suite includes **performance/throughput benchmarks** with wall-clock
  budgets. These are **hardware- and load-sensitive** and may report a timing
  failure on a busy or resource-constrained runner. They are **not** correctness
  failures and do not gate the release. Treat the benchmark suite as advisory in
  CI.

### Configuration & rollback

- Feature selection is entirely via environment variables (see
  [`DEPLOYMENT-CHECKLIST.md`](./DEPLOYMENT-CHECKLIST.md)).
- The hosting provider and the full-fidelity import path are each controlled by
  a single flag, so rollback is configuration-only and takes effect for new/
  in-flight jobs without a code change.

### Known non-blocking items

- Timing benchmarks as noted above.
- Some infrastructure-facing helper scripts and a few historical documents
  predate the native-HTTP change and still reference the retired custom-template
  wording; these are non-runtime and are tracked for a follow-up docs pass.
