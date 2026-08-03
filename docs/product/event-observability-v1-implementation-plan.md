# Event Observability V1 — Locked Decisions and Implementation Plan

**Status:** Backend Phase 1 implemented (uncommitted). **Amended after implementation**: failure-sample ingestion was found to be unbuildable as originally planned and was removed from V1 — see "Amendment — failure-sample ingestion removed from V1" below. Builds on the approved decision brief (`docs/product/event-observability-v1.md`, Option B).

## Amendment — failure-sample ingestion removed from V1

Post-implementation verification found the planned "Event Failure - GA4 purchase" sGTM tag could never fire, and separately had an invalid-JSON defect. Both are architectural, not implementation bugs, and neither is fixable within this container's constraints:

1. **No producer for the trigger's data.** The failure tag's trigger required a custom event field (`event_observability.reason_code`) to be non-empty. Nothing in the generated container — no tag, client, or trigger — ever wrote to that field. Unlike `user_data.em` or `ep.ttclid` (populated by the client's own request data), a "did the GA4 tag just fail to deliver" signal does not exist anywhere the failure tag could read it from.
2. **No real mechanism to produce it, given this project's own hard constraints.** GTM Server-Side exposes tag-execution success/failure to another tag in exactly one way: a custom sandboxed JS template's own `gtmOnSuccess`/`gtmOnFailure` callback, reachable only via `setupTag`/`teardownTag` sequencing on the tag being observed. This container's GA4 delivery tag (`ET - GA4 Forward to Google Analytics`) is Google's own native `sgtmgaaw` tag type — not a custom template EasyTrac authors, so there's no template to add a callback to even if sequencing were allowed. And sequencing itself is independently forbidden (fail-open, hard requirement — telemetry must never be a blocking dependency of GA4 delivery). The existing regression suite (`tests/sgtm-template.contract.test.js`) also asserts zero custom (`cvt_`) templates in any generated container, which a custom-template-based observer would violate. There is no remaining path to a real signal without breaking an existing, deliberate constraint.
3. **Invalid JSON on realistic inputs.** Independent of (1)–(2), the failure tag's `requestBody` interpolated `httpStatus`/`attemptCount` unquoted into a JSON template string. Simulating GTM variable substitution showed that whenever either was empty (the common case — e.g. `TIMEOUT`/`TRANSPORT_ERROR` failures have no HTTP status), the resulting body was not valid JSON.

**Decision:** the failure tag, its trigger, and its 4 dead variables were removed from `lib/gtm-config-builder.js`. V1 ships **accepted-at-ingestion telemetry only** (see amended Write path below) — an honest "purchase event reached the container" counter, not a "GA4 confirmed delivery" signal, since the latter is not currently obtainable. `POST /api/v1/internal/event-failure` now unconditionally returns `501` regardless of rollout flags; no generated container calls it. The failure-sample service/storage code (`event-observability-service.js`'s `ingestFailure`/`buildFailureSample`, `firestore-service.js`'s `reserveEventFailureSample`, the `event_failure_samples` collection, its caps/PII-allowlist/TTL logic, and its owner/admin read endpoints) is **retained and still tested**, but has no producer and is not reachable for ingestion — kept in place in case a future container-architecture change (e.g. a first-party GTM feature, or a revisit of the native-template constraint) provides a real signal to wire it to. Re-enabling it must not fabricate failure data from any other source in the meantime.

## Locked decisions

Resolving the brief's five open decisions plus the four hardening items from its guardrails section — each stated as a decision, not a menu.

**1. Owner-scoped read authorization.** Customer-facing, per-`clientId` — the same tier as `/api/ss/*` (`server.js:3408-3454`: Firebase ID token, `decoded.uid` is the canonical `clientId`). Not admin-only. The entire App Shell/Dashboard/Destinations UI already built and committed (`7c18466`) assumes a signed-in store owner is the viewer; Events Explorer must match that, not inherit the Operations Console's admin-only posture.

**2. Per-client API-key-bound ingestion.** Reuse the beacon's Path A exactly (`server.js:4281-4303`): `apiKeyService.parse()`/`verify()` against `firestoreService.getApiKey(parsed.keyId)`, reject unless `keyDoc.clientId === bClientId` and `keyDoc.status === 'active'`. The new ingestion endpoint does **not** offer an HMAC/shared-secret path at all — not "discouraged," simply not implemented, so the weak path can't be reached by mistake.

**3. Sharded aggregate counters.** 10 shards per `(clientId, eventName, destination, bucketStart)` key, `shardId = random 0-9` chosen per write. Each shard is its own document; reads sum across the 10. Ten is deliberately modest — it's the standard Firestore distributed-counter starting point, sized for realistic per-tenant concurrent-writer counts, not the deployment's theoretical 100-instance ceiling (no single tenant's traffic plausibly hits all 100 instances writing the same key in the same second). Documented as a later per-tenant tuning knob, not built now.

**4. Bucket granularity.** 5-minute fine-grained buckets, daily rollup documents for 13-month trends. 5 minutes matches the existing `event_type_last_seen` beacon debounce window (`_BEACON_BUCKET_MS`, `server.js:4349`) — reusing an interval this codebase has already chosen once, not inventing a new one.

**5. Numeric failure-sample caps.** 20 retained samples per `(clientId, eventName, destination, reasonCode)` per rolling 24h window; 500 total failure samples/day per `clientId` as a global ceiling (bounds a multi-destination, multi-reason storm). Once a key's cap is hit, new samples for that exact key are dropped until older ones age out via TTL — aggregates keep counting regardless. No true random reservoir sampling in V1; accept-until-cap is simpler, cheaper, and sufficient for "bounded representative samples."

**6. Firestore TTL provisioning.** Add explicit `fieldOverrides` entries to `firestore.indexes.json` — the file this deployment's tooling already manages and deploys — for `expiresAt` on both new collections, `"ttl": true`. Not a manual one-off `gcloud` command (unreproducible, the exact gap that left `dlq_events`' TTL unverified).

**7. TTL backstop sweep.** Build it. A scheduled function modeled directly on `lib/dlq-worker.js`'s existing pattern (`setInterval` started at boot, same shape as `dlqWorker.start(firestoreService, 60*1000)`), running every 6 hours, deleting documents where `expiresAt < now` in capped batches (500/run). Defense-in-depth only — native TTL is primary.

**8. Relationship with `dlq_events`.** Unchanged, kept separate. `dlq_events` continues exactly as today — retry-only, unsafe schema, not customer-facing. The new `event_failure_samples` collection is independent, with its own stricter allowlisted schema. The sGTM container's existing `_fireDLQ()` → `/api/v1/internal/dlq` call is untouched; a **separate, new** tag reports to the new endpoint. No migration or consolidation in V1.

**9. Rollout order.** By risk, not alphabetically: **Phase 1** — GA4 + `purchase` only, small internal tenant allowlist (GA4 is the universal default destination on every managed container, per existing provisioning; `purchase` is the highest-value monitored event). **Phase 2** — all 8 `BEACON_EVENTS` on GA4, same allowlist. **Phase 3** — add Meta CAPI (the destination the brief's own AUTH_ERROR storm example concerns). **Phase 4** — TikTok, Snapchat, Google Ads. **Phase 5** — remove the tenant allowlist, 100% rollout. Each phase validates ingestion/caps/sharding under progressively higher real risk before the next.

---

## Implementation plan

### Exact collections and schemas

**`event_agg_shards`** — doc ID `{clientId}_{eventName}_{destination}_{bucketStart}_{shardId}`:
```
clientId, eventName, destination, bucketStart (Timestamp, 5-min floor),
shardId (0-9), accepted, failed, validationFailed (all int counters),
latencyP50Ms, latencyP95Ms (optional, int), expiresAt (Timestamp, +30d)
```

**`event_agg_daily`** — doc ID `{clientId}_{eventName}_{destination}_{dayStart}`:
```
clientId, eventName, destination, dayStart (Timestamp, day floor),
accepted, failed, validationFailed, updatedAt (Timestamp)
— no expiresAt; 13-month retention enforced by the backstop sweep only
  (TTL on a 13-month field is intentionally not relied on as sole
  enforcement given the discovered TTL-gap precedent).
```

**`event_failure_samples`** — doc ID auto:
```
clientId (required), eventId (opaque, sGTM-generated), eventName, destination,
reasonCode (controlled taxonomy), reasonSummary (reviewed template, not free text),
httpStatus (int, optional), schemaVersion, containerVersion,
receivedAt, attemptedAt, failedAt (Timestamps, each optional/"not reported"),
attemptCount, payloadSizeBytes, retryState (pending|retried|exhausted, optional),
expiresAt (Timestamp, +14d)
— allowlisted fields only, enforced at ingestion by explicit key rejection,
  never a wholesale copy of the request body.
```

### Exact endpoints

- `POST /api/v1/internal/event-telemetry` — sGTM → backend, batched bucket increments (one call may cover multiple shards/keys accumulated client-side over the report interval). Auth: per-client API key (decision 2).
- `POST /api/v1/internal/event-failure` — **disabled in V1** (see amendment above). Always returns `501`, independent of rollout flags. No generated container calls this path.
- `GET /api/v1/clients/:id/events/summary?eventName=&destination=&range=` — owner-scoped read, aggregate rows for Explorer.
- `GET /api/v1/clients/:id/events/failures?eventName=&destination=&reasonCode=&before=` — owner-scoped read, cursor-paginated failure samples for Mode 1's list and Mode 2 lookups.

### Auth model

Ingestion: per-client API key only (decision 2), mirroring beacon Path A verbatim — same `apiKeyService`, same `getApiKey`/`clientId` binding check. Reads: owner-scoped Firebase ID token (decision 1), `decoded.uid` must equal the `:id` path param — same pattern as `/api/ss/*`, not `_requireAdmin()`.

### Write path

sGTM container (independent tag, fires on the same trigger as the real GA4 purchase event, no `setupTag`/`teardownTag` linkage to the GA4 forward tag — same unsequenced pattern as the existing beacon, `lib/gtm-config-builder.js`) → `POST /api/v1/internal/event-telemetry` with a static, `JSON.stringify`-built body (`accepted:1,failed:0,validationFailed:0` — an ingestion counter, not a delivery-confirmation signal) → server picks a random shard (0-9) and increments the addressed shard + daily documents (`FieldValue.increment`, create-if-absent).

**Failures path — removed in V1** (see amendment above). `event_failure_samples` writes, its per-reason (20/24h) and per-tenant-daily (500) caps, and the over-cap `202 { ok:true, sampled:false }` behavior remain implemented and tested in `event-observability-service.js`/`firestore-service.js`, but `POST /api/v1/internal/event-failure` is hard-disabled (`501`) and no container calls it, so none of this code path executes in V1.

### Read path

Explorer summary: read `event_agg_daily` for the selected range (trend) plus the latest `event_agg_shards` bucket set for the current-hour live count (summed server-side across the 10 shards). Event Details Mode 1: same aggregate reads scoped to one `(eventName, destination)` plus a cursor-paginated `event_failure_samples` query for the "recent failed samples" list. Mode 2: single `event_failure_samples` document read, authorized against `clientId` first.

### TTL/index requirements

`firestore.indexes.json` additions: `fieldOverrides` entries (`ttl: true`) for `event_agg_shards.expiresAt` and `event_failure_samples.expiresAt` (decision 6). Composite indexes: `(clientId, eventName, destination, bucketStart)` on `event_agg_shards`; `(clientId, eventName, destination, occurredAt)` and `(clientId, reasonCode, occurredAt)` on `event_failure_samples` — matching the brief's own index list, nothing broader.

### Cost controls

10-shard cap (not unbounded), 5-minute bucketing (not per-event), 500/day per-tenant failure-sample ceiling, 14-day sample TTL + 6-hourly backstop sweep, daily rollups instead of retaining 30-day fine-grained buckets past their window. Dominant cost driver is failure rate, not total successful traffic, by construction (decision 5 + Option B's own cost analysis).

### Fail-open guarantees

The one surviving sGTM tag (telemetry) is independent and unsequenced — confirmed by grepping the generated container for `setupTag`/`teardownTag` (zero matches) and by a static contract test. Ingestion endpoint timeouts/errors are swallowed client-side in the container (best-effort report, never blocks the destination send). This guarantee is also *why* the failure tag was removed rather than reworked: the only native way to make it real (tag sequencing) would have violated this exact guarantee.

### Files to change (when implementation is approved — none touched yet)

- `lib/gtm-config-builder.js` — new telemetry/failure tags, additive/opt-in per rollout phase (decision 9).
- `lib/event-observability-service.js` (new) — shard write/sum, cap enforcement, rollup.
- `firestore-service.js` — new collection read/write functions.
- `server.js` — the four new endpoints.
- `firestore.indexes.json` — TTL `fieldOverrides` + composite indexes.
- `lib/ttl-backstop-worker.js` (new) — the sweep, started alongside `dlq-worker.js` at boot.
- `tests/` — new files mirroring `tests/pii-hashing.test.js`/`tests/capi-json-safety.test.js` rigor for the new tags, plus cap/shard/TTL unit tests.

### Tests

Unit: shard-sum correctness, cap enforcement (exactly 20/500 boundaries), TTL field presence on every written document, allowlist rejection of any non-schema key. Contract: new sGTM tags never sequenced ahead of destination tags (static template assertion, same style as `tests/sgtm-template.contract.test.js`). Auth: per-client key binding rejects mismatched `clientId` (mirrors existing beacon auth tests if present, else new). Integration: capped-write-returns-202 path, backstop sweep deletes only expired docs.

### Rollout and rollback

Rollout follows decision 9 exactly (GA4/purchase → GA4/all-events → +Meta → +TikTok/Snap/GAds → remove allowlist). Each phase is a config flip in `lib/gtm-config-builder.js` (which destinations/events get the new tags), not a code branch — rollback at any phase is disabling the flag for that phase's scope, which stops new writes immediately; existing data ages out via TTL/backstop with no manual cleanup required, matching the rollback philosophy already established for Phase A/B1.

---

Stopping here for approval. No code has been modified.
