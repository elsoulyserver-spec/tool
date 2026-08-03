# Event Observability V1 — Product and Backend Decision Brief

**Status:** Decision proposed for V1; reviewed against the live repository and revised with concrete hardening requirements (see *Verification against the current deployment* and *Open product decisions*). Recommendation (Option B) unchanged by review — the changes are grounding/hardening, not a different choice.  
**Decision:** Option B — Aggregate + failed-event samples  
**Scope:** Tracking Health, Events Explorer, incident diagnosis, destination rejection reasons, event-type coverage, and delivery trends without retaining every successful raw event

## Decision context

EasyTrac is a managed server-side Google Tag Manager (sGTM) hosting and provisioning product. The repository shows Firestore as the operational store and Cloud Run as a supported managed sGTM runtime (`docs/CLOUD-RUN-DEPLOYMENT.md`, `docs/DEPLOYMENT-HARDENING.md`). The Node application provisions, configures, and monitors infrastructure; it is not on the live event path. Actual event evaluation and destination delivery happen inside deployed sGTM containers (`docs/EASYTRAC-TECHNICAL-REPORT-AR.md`, especially §2.2). Consequently, any V1 delivery telemetry must be emitted deliberately by those containers; the Node service cannot reconstruct it later.

The current backend already demonstrates two deliberately bounded patterns (`docs/frontend/events-ui-integration-brief.md`):

- `event_type_last_seen` is a debounced presence signal, not an event log. It records only `clientId`, `eventName`, and `lastSeenAt`, with at most one update per five-minute bucket per event type.
- `dlq_events` records failures for retry with a 72-hour TTL. It includes useful failure details, but currently lacks tenant attribution and has no customer read API. Successful sends create no equivalent record.

The approved design handoff defines an Events Explorer and an Event Details composition. Event Details expects a breadcrumb, event/destination status, ordered trace, response code, payload table, copy action, and related events (`EasyTrac Tracking Command Center/design_handoff_easytrac_design_system/patterns/EventDetails.js`). The integration research explicitly concludes that the data needed for that literal experience does not exist today. This decision therefore preserves the approved visual system and drawer/list interaction while revising the information shown to match V1 evidence.

### V1 observability unit and boundaries

V1 should treat an **event type × destination × fixed time bucket** as the primary aggregate unit. A compact telemetry report from each deployed sGTM container should contain counters and safe dimensions only: tenant/store attribution, event name, destination, accepted/failed/validation-failed counts, latency summaries, last-seen timestamps, and bounded rejection-code counts. It must not contain the successful event payload.

A **failed-event sample** is a bounded diagnostic record for a failed event→destination attempt. It retains tenant attribution and an allowlisted diagnostic snapshot, not the raw request. The allowed snapshot is limited to operational/non-PII fields such as event ID, event name, destination, timestamps, normalized error category/code, HTTP status where available, validation failures expressed as field names or booleans, schema/config version, attempt count, and payload size. Values for user identifiers, contact data, IP address, user agent, cookies, URL query values, order/customer/session identifiers, destination tokens, authorization headers, and arbitrary payload/header bodies are not stored.

### Verification against the current deployment (added after strict review)

Five claims in this brief were checked directly against the running codebase and deployment config, not assumed. Two hold up as-written and are cited below for traceability; three do not hold as originally stated and change the design as noted.

**Holds — fail-open is architecturally real, not just a stated principle.** The existing beacon tag (`lib/gtm-config-builder.js:1842-1858`, `'ET - EasyTrac Beacon'`) fires as an independent native HTTP tag with its own trigger and **no `setupTag`/`teardownTag` sequencing** to any CAPI/GA4 destination tag. GTM server containers fire unsequenced tags in parallel by default, so a slow or failing beacon call cannot block or delay a destination send today. **Required change:** any new telemetry-report tag (aggregate buckets, failure samples) must be built the same way — an independent tag, never wired via `setupTag` ahead of a destination tag — and the brief's "fail-open" guardrail (see *Decision consequences and guardrails*) should cite this precedent explicitly rather than assert the property abstractly.

**Holds — the AUTH_ERROR/token-rotation storm is a real, already-coded failure mode.** `lib/dlq-worker.js:108-121` and `server.js:4223-4231` already special-case HTTP 401/403 from a destination as "rotate the CAPI token," and exclude it from normal retry because it will fail every subsequent event for that (tenant, destination) pair until someone rotates the token. This is the primary real-world driver of a failure-sample storm in this system — not a hypothetical. **Required change:** the per-(tenant, event type, destination, reason code) sampling cap in Options B/C must explicitly name "auth/token-rotation storms" as the case it exists to bound, and aggregate accepted/failed/validation-failed counters must keep incrementing accurately even after the failure-sample cap for that reason is reached (stated generally in the Retention sections below; now made explicit).

**Does not hold as written — no Firestore TTL policy is currently provisioned anywhere in this repository.** `firestore.indexes.json` — the file this deployment's tooling uses to manage indexes and field configuration — has an empty `"fieldOverrides": []`, and no `gcloud firestore fields ttls update` call or equivalent exists anywhere in the repo. `firestore-service.js`'s own comment on `dlq_events` ("TTL field: expiresAt — set a Firestore TTL policy on this field") describes an intended policy, not a verified one, and `lib/dlq-worker.js` only deletes a `dlq_events` document on a **successful** retry (`lib/dlq-worker.js:152`) — documents that reach `status: 'exhausted'` (max attempts, auth error, non-retryable HTTP status) are never deleted by the worker. There is no evidence in this repository that the existing 72-hour `dlq_events` TTL this brief cites as precedent is actually enforced; exhausted records may be accumulating indefinitely today. **Required change:** every retention claim in this brief ("30 days," "13 months," "14 days," "7 days") must be treated as a target requiring an explicit `fieldOverrides` TTL entry (`"ttl": true` on the relevant timestamp field) or an equivalent `gcloud firestore fields ttls update` step, added and verified as part of implementation — not assumed to work because a comment elsewhere says it should. V1 should also add a small scheduled backstop-deletion sweep (mirroring nothing that exists today, since no such backstop exists for `dlq_events` either) so retention holds even if the native TTL policy is misconfigured or delayed, given this exact class of gap is already present in production.

**Does not hold as written — "`clientId` is required" is a schema rule, not a write-time guarantee, unless bound to the right auth path.** The existing beacon endpoint has two authentication paths (`server.js:4262-4361`): Path A, a **per-client API key** where the server verifies `keyDoc.clientId === bClientId` before accepting the write (`server.js:4299-4302`) — a real cryptographic binding; and Path B, a **single shared `BEACON_SECRET`** HMAC where the signature covers `clientId + event + timestamp` but the secret itself is not tenant-scoped, so any party holding that one shared secret could report telemetry under any `clientId`. Encouragingly, `lib/gtm-config-builder.js` (`_beaconEnabled = !!(beaconUrl && beaconApiKey && etClientId)`, lines ~1507, ~1531-1532) shows the **currently generated containers use Path A**, the safe pattern — but the brief never says which path the *new* aggregate/failure-sample ingestion endpoint must use. **Required change:** the new endpoint must explicitly require the per-client API-key binding (Path A's pattern), and must not accept the shared-secret HMAC path (Path B) for anything that writes `clientId`-attributed telemetry. Without stating this, "retained attribution data" is a schema field, not a guarantee.

**Does not hold as written — bucket-counter writes are not automatically safe at this app's real Cloud Run scale.** `docs/CLOUD-RUN-DEPLOYMENT.md` documents production scaling of up to `--max-instances 100` at `--concurrency 250` per instance. Many concurrent container instances can attempt to increment the *same* `(clientId, eventName, destination, bucket)` counter document simultaneously — Firestore document writes are rate-limited to roughly one sustained write per second per document, so a single hot counter document becomes a bottleneck (and a source of write contention/failed increments) under real multi-instance traffic, not a hypothetical edge case for a store with meaningful volume. The brief's "periodic/batched container reports" language does not resolve this — batching within one container instance does not prevent many *different* instances from colliding on one bucket document in the same window. **Required change:** the aggregate-write design must specify a contention-safe pattern — either sharded/distributed counters (multiple sub-documents per bucket, summed on read) or per-instance sub-buckets merged by a separate periodic rollup — not a single document incremented directly by every container instance.

## Decision criteria

The recommendation criteria are: **prefer low cost, no raw PII, retained attribution data, useful diagnostics, and future extensibility.**

“No raw PII” is a storage boundary, not merely a UI masking rule. V1 must prevent disallowed fields from entering Firestore; masking after storage is insufficient. “Retained attribution data” means every aggregate and failure sample has the EasyTrac `clientId` plus event type and destination, avoiding the attribution gap in the current `dlq_events` shape.

## Options at a glance

| Dimension | A. Aggregate-only | B. Aggregate + failed-event samples | C. Aggregate + sampled successful events + failed events |
|---|---|---|---|
| Tracking Health, coverage, trends | Strong | Strong | Strong |
| Destination rejection diagnosis | Category/count only | Strong for retained failures | Strong for failures |
| Successful-instance drill-down | None | None | Limited to a non-representative sample |
| Successful raw events retained | No | No | Yes unless aggressively projected/redacted |
| Firestore cost profile | Lowest and traffic-bounded by buckets | Low; buckets plus failure rate | Highest; buckets plus failure rate plus sample rate |
| Privacy risk | Lowest | Low with ingestion allowlist | Highest |
| Honest fit with approved Event Details | Event-type summary only | Event-type summary plus real failure detail | Failure detail plus sampled success detail, with sampling caveats |
| V1 judgment | Too weak for incident diagnosis | **Recommended** | More cost/privacy than V1 needs |

Let:

- `T` = active tenants,
- `E` = observed event types,
- `D` = configured destinations,
- `B` = populated time buckets,
- `F` = failed destination attempts,
- `S` = successful destination attempts, and
- `p` = successful-event sample rate.

The formulas below describe order-of-growth, not a billing quote. Actual cost depends on traffic distribution, document size, index fan-out, dashboard refresh frequency, and current Google Cloud pricing.

## Option A — Aggregate-only

### Product capabilities enabled

- Tracking Health based on recent volume, failure rate, validation-failure rate, latency summaries, and last-seen freshness.
- Events Explorer as an event-type/destination coverage table rather than an event-instance stream.
- Event-type coverage: configured versus observed, never seen, stale, and recently active.
- Delivery trends over fixed intervals, including accepted, failed, and validation-failed counts.
- Incident detection for volume drops, spikes, elevated rejection rates, and stale event types.
- Destination rejection reasons as ranked aggregate categories/codes with counts and first/last seen times.

### Product capabilities not enabled

- No individual failed or successful event inspection.
- No instance-level response, trace, retry history, or exact validation evidence.
- No reproduction of a rejection from a retained sample.
- No payload view, copy-payload action, same-order/session related events, or event-ID search.
- Cannot distinguish multiple failures with the same aggregate reason beyond their counts and time range.

### Firestore write/read volume

Writes are approximately `O(T × E × D × B)` for populated buckets, plus optional rollup updates. This must be implemented as periodic/batched container reports rather than one counter update per live event; otherwise aggregate-only would still incur per-event writes and hot-document contention. Reads are small: time-range bucket scans for charts and one latest-summary/coverage read per Explorer refresh.

### Storage growth

Growth is bounded by active dimension combinations and bucket retention, not raw traffic. A million identical successes within one bucket should consume the same Firestore document count as one success, with only counter values differing. High-cardinality dimensions beyond tenant, event type, destination, and controlled reason code are excluded.

### Retention

- Fine-grained buckets: 30 days.
- Daily rollups: 13 months for seasonality and long-term delivery trends.
- Current coverage/last-seen documents: retained while the tenant/configuration exists; reset or archived when an event type is removed.
- Firestore TTL applies to fine-grained buckets through `expiresAt`; daily rollups have an explicit lifecycle policy.

### Required indexes

Minimum composite indexes, with timestamp descending unless noted:

- `(clientId, bucketStart)` for all-store health/trends.
- `(clientId, eventName, bucketStart)` for event-type trends.
- `(clientId, destination, bucketStart)` for destination trends.
- `(clientId, eventName, destination, bucketStart)` for Event Details aggregate drill-down.
- Coverage/latest-state documents should use deterministic IDs or direct document reads and require no composite index.

Do not create indexes for counters, diagnostic maps, or TTL fields unless queried; exempting these fields reduces index storage and write amplification.

### Privacy risk

Lowest. Counters, controlled enums, coarse timestamps, and latency summaries are not raw event content. Very rare event types can still reveal business activity, so access remains tenant-scoped and logs must avoid arbitrary event names if custom names can themselves contain sensitive text.

### PII handling

Accept only schema-approved dimensions. Never accept payloads, headers, URLs, user/customer/session/order IDs, IP addresses, user agents, cookies, or free-text destination messages. Normalize destination errors to a controlled taxonomy at the sGTM boundary; unknown messages become a generic code rather than stored text.

### Operational complexity

Moderate. It requires additive sGTM instrumentation, authenticated ingestion, idempotent bucket merge semantics, late-arrival handling, TTL, rollups, and monitoring for telemetry loss. It has no sample lifecycle or detail-record query path.

### Estimated cost drivers

- Bucket-report Firestore writes and index fan-out.
- Reads caused by chart range and dashboard refresh frequency.
- Retention length and bucket granularity.
- Cloud Run egress/requests from sGTM containers to telemetry ingestion.
- Scheduled daily rollups if not emitted directly.

### Migration path

Add a separate failure-sample stream later without changing aggregate keys. Stable dimensions and controlled error taxonomy become the join/filter contract. Historical aggregate windows remain valid, but past individual failures cannot be recovered.

### Impact on the approved Events Explorer and Event Details designs

The Explorer can preserve its search/filter/table language but rows must represent event type × destination summaries, not individual event IDs. “Volume,” “expected volume” (only after a baseline is defined), “last seen,” status, and quality flags are supportable.

The approved Event Details view cannot be populated literally. It must become an event-type/destination summary drawer: aggregate timeline and rejection-reason distribution replace EventTrace; Payload, Copy payload, and Related Events are removed. Calling it an individual event detail would be misleading.

## Option B — Aggregate + failed-event samples

### Product capabilities enabled

Everything in Option A, plus:

- Incident diagnosis from real, tenant-attributed failure examples.
- Destination rejection reasons with both aggregate prevalence and bounded representative samples.
- Failed-event search by non-PII event ID, normalized reason, destination, event type, and time range.
- A truthful failed-attempt trace showing only stages actually reported by sGTM: received/validated, destination attempted, rejected or transport failed, and retry status if reported.
- Exact missing-field names/validation flags, schema/config version, response status/code, timing, payload size, and attempt metadata for retained failures.

### Product capabilities not enabled

- No individual successful event history or proof that a particular successful event was accepted.
- No success response body/code unless it is included as an aggregate counter category; no success trace.
- No raw or reconstructed payload, raw headers, identity matching values, or sensitive-field reveal.
- No same-order/session related-event navigation because those identifiers are deliberately not stored.
- Absence of a failure sample does not prove success: sampling caps, telemetry loss, TTL expiry, or normalization can explain absence.

### Firestore write/read volume

Aggregate writes remain approximately `O(T × E × D × B)`. Failure-sample writes are `O(min(F, configured sample caps))`. V1 should retain all failures only while they are below per-tenant/per-reason caps; under storms it should use deterministic reservoir/rate sampling while aggregates continue counting every reported failure. This prevents an outage from becoming an unbounded Firestore write burst.

Explorer reads remain aggregate scans. Opening a failed sample adds a point read. Listing recent failures adds a bounded, cursor-paginated query. Incident pages read aggregate reason counts first and samples only on demand.

### Storage growth

Aggregate growth matches Option A. Sample storage grows with bounded failure volume, average safe-record size, and retention. It is explicitly independent of successful traffic. Fixed limits per tenant, event type/destination/reason/time bucket prevent one noisy tenant or repeated outage from dominating storage.

### Retention

- Fine-grained aggregate buckets: 30 days.
- Daily rollups: 13 months.
- Failed-event samples: 14 days by Firestore TTL; retry/DLQ operational retention may remain 72 hours independently.
- Aggregate rejection counts survive sample expiry, so trend and incident prevalence remain visible after diagnostic records disappear.
- The UI always shows the sample expiry time and explains when only aggregates remain.

### Required indexes

All Option A indexes, plus failed-sample indexes:

- `(clientId, occurredAt)` for recent failures and time-range pagination.
- `(clientId, eventName, occurredAt)`.
- `(clientId, destination, occurredAt)`.
- `(clientId, reasonCode, occurredAt)`.
- `(clientId, eventName, destination, occurredAt)` for the revised Event Details sample list.

Use direct lookup for a globally random sample document ID only after verifying `clientId` authorization. Do not index diagnostic field maps, free text, TTL, or other non-filtered fields. V1 should not promise arbitrary combinations of event name, destination, reason, status, and sorting; each would require more composite indexes.

### Privacy risk

Low but higher than Option A because records describe individual failures. Risk is controlled by strict projection at the sGTM source and validation again at ingestion. Free-text destination responses are not retained; normalized codes and safe summaries are used. Rare timestamps/event names can still be commercially sensitive and require tenant isolation.

### PII handling

No raw PII and no hashed PII is stored. There is no Reveal control. The ingest contract rejects unknown keys and applies length/cardinality limits. It drops payload/header snapshots rather than attempting best-effort redaction. Error messages are mapped to controlled reason codes; only reviewed, non-PII message templates may be stored. `clientId` is required, while shopper/customer/session/order identifiers are forbidden. Event IDs must be generated independently of PII and treated as opaque.

### Operational complexity

Medium. In addition to Option A, this needs a failure projection, caps/sampling behavior during storms, cursor pagination, TTL, authorization, and an explicit separation between retry/DLQ records and customer-safe observability samples. Reusing the current DLQ document directly is unsafe because its payload/header snapshots are broader, it lacks `clientId`, and its lifecycle serves retries rather than product analytics.

### Estimated cost drivers

- All Option A drivers.
- Failure rate and outage bursts, constrained by sample caps.
- Average diagnostic-record size and composite-index fan-out.
- Detail/list reads and incident investigation frequency.
- TTL deletion and rollup operations.

The dominant variable is failed attempts, not total successful events. This aligns cost with diagnostic value while keeping normal healthy traffic inexpensive.

### Migration path

The aggregate model remains the durable base. A future successful-sample collection can adopt the same tenant/event/destination/timestamp contract and use a distinct `sampleKind`. BigQuery export can later provide longer retention without turning Firestore into a raw event warehouse. Increasing sample retention or adding safe fields is additive. Historical successful instances cannot be backfilled, which the product must state.

### Impact on the approved Events Explorer and Event Details designs

The Explorer remains a summary table, with an optional “recent failures” count/sample affordance on each event type × destination row. It must not look like a chronological list of all events. Search covers event names, destinations, normalized reasons, and retained opaque failure event IDs; it does not search payload values.

The approved drawer composition can be reused only for failed samples. Breadcrumbs, status chip, and EventTrace remain. “Payload” becomes “Diagnostic fields,” Copy payload becomes “Copy diagnostic summary,” and Related Events becomes “Other retained failures with the same event type/destination/reason.” For a healthy/aggregate row, the same drawer shell renders the event-type summary experience specified below, not an invented successful instance.

## Option C — Aggregate + sampled successful events + failed events

### Product capabilities enabled

Everything in Option B, plus:

- Limited successful-instance drill-down and examples of normal processing.
- Approximate distributions of successful trace shapes beyond aggregate counters.
- A bounded ability to verify that some representative successful attempts reached a destination.
- Comparative debugging between sampled successes and failures.

### Product capabilities not enabled

- It still cannot provide a complete event ledger or guarantee lookup of a particular success.
- Sampling cannot prove absence, completeness, or delivery for an unsampled event.
- Low-volume event types can be missed unless stratified sampling is used; stratification increases complexity and writes.
- Related-order/session chains remain unavailable under the no-PII/no-correlation-ID boundary.
- A raw payload/reveal experience remains incompatible with the stated recommendation criteria unless the stored success projection is heavily restricted.

### Firestore write/read volume

Writes are `O(T × E × D × B + capped F + pS)`. Even a small `p` becomes material because `S` dominates normal traffic. Stratified minimum samples per tenant/event/destination add write floors, while random sampling alone produces uneven coverage. Reads resemble Option B but include mixed success/failure sample queries and additional detail fetches.

### Storage growth

Storage includes aggregates, bounded failures, and successful samples. It scales with total success volume times `p` unless hard quotas override sampling. Index storage may approach or exceed document storage for several filtered views. Quotas make cost predictable but further weaken statistical representativeness.

### Retention

- Aggregate retention as in Options A/B.
- Failed samples: 14 days.
- Successful samples: at most 7 days in V1, with TTL and per-tenant quotas.
- Any longer successful-event history belongs in an analytics warehouse, not Firestore.

### Required indexes

All Option B indexes plus `sampleKind/state` variants needed to separate successes and failures, at minimum:

- `(clientId, sampleKind, occurredAt)`.
- `(clientId, eventName, sampleKind, occurredAt)`.
- `(clientId, destination, sampleKind, occurredAt)`.
- `(clientId, eventName, destination, sampleKind, occurredAt)`.

This option has the highest risk of index proliferation if the UI allows arbitrary combinations. Fields not used for filtering must remain exempt.

### Privacy risk

Highest of the three. Healthy traffic greatly expands the number of individual behavioral records retained. Even without explicit PII, event names, exact timestamps, values, URLs, order IDs, and stable identifiers can become identifying or sensitive in combination. The product may also encourage users to expect payload access that V1 should not provide.

### PII handling

The same strict allowlist as Option B is mandatory, applied to successes and failures. No payload/header snapshots, hashed identities, URLs, order/customer/session IDs, IP addresses, user agents, cookies, or destination credentials. This restriction reduces the diagnostic advantage of successful samples, weakening the value proposition relative to their cost.

### Operational complexity

Highest. It needs sampling algorithms, fairness/stratification, tenant quotas, rate changes, sample-bias documentation, success and failure lifecycle management, and UI explanations of why a specific event is missing. Instrumentation also executes on the high-volume success path, increasing reliability and latency sensitivity.

### Estimated cost drivers

- All Option B drivers.
- Total successful destination attempts multiplied by sample rate.
- Per-stratum minimums and quota bookkeeping.
- Larger index set and mixed-sample reads.
- More sGTM telemetry network calls unless samples are buffered.
- Operational work to tune rates as tenants and traffic grow.

### Migration path

It is easy to reduce/disable success sampling while preserving aggregates and failures. Existing samples expire by TTL. Moving longer-term samples to BigQuery is straightforward if export is designed early. However, shipping success-instance UI creates a product expectation of lookup completeness that is difficult to retract.

### Impact on the approved Events Explorer and Event Details designs

This is the closest visual fit: sampled successful and failed records can use the trace/detail composition. The UI must label every success row and drawer “Sampled” and display the effective rate/window. Search results cannot imply completeness. The payload and related-event sections still require removal or revision under the no-raw-PII boundary, so even this option does not fully support the approved literal design.

## Recommendation — Choose Option B for V1

Choose **Option B: Aggregate + failed-event samples**.

Against the stated criteria—prefer low cost, no raw PII, retained attribution data, useful diagnostics, and future extensibility—Option B is the best balance:

- **Low cost:** routine successful traffic produces bucketed counters, not per-event Firestore writes. Failure storms are bounded by caps while aggregates retain the true counts.
- **No raw PII:** failure records use a reject-unknown-fields allowlist and never store payload/header snapshots or identity values.
- **Retained attribution data:** `clientId`, event name, and destination are mandatory on both aggregates and samples, correcting the current DLQ attribution gap.
- **Useful diagnostics:** normalized rejection reasons, safe validation evidence, timestamps, config/schema version, attempt status, and representative failures can explain common incidents.
- **Future extensibility:** aggregate keys remain stable; success sampling, longer-term warehouse export, and richer safe diagnostics can be added without migrating or invalidating V1 data.

Option A is cheaper but fails the “useful diagnostics” criterion when aggregate rejection codes are insufficient. Option C adds cost, privacy surface, and sampling ambiguity on the dominant success path without supporting a complete event ledger or the approved raw-payload interactions.

## Exact revised Event Details experience for V1

V1 keeps the approved list→detail drawer pattern and visual components, but there are two explicit drawer modes. The row type determines the mode; the UI never synthesizes an event instance from aggregate data.

### Mode 1 — Event type and destination summary

Opened from an Events Explorer summary row.

**Header**

- Breadcrumb: Store → Events → event name → destination.
- Title: `event name → destination`.
- Status chip derived from the selected time window, labeled as aggregate health rather than delivery of a specific event.
- Selected time range and “Aggregated telemetry” badge.

**Tracking summary**

- Total observed, accepted, failed, and validation-failed counts.
- Delivery rate and failure rate, with numerator/denominator shown.
- Last received and last successful timestamps.
- Latency summary only if reported (for example p50/p95); never an invented per-event duration.
- Configured/observed/stale/never-seen coverage state.

**Delivery trend**

- Time-series accepted/failed counts and failure rate from aggregate buckets.
- A data-gap state when telemetry buckets are missing; missing data is not rendered as zero.
- Expected-volume comparison only after a separate baseline is actually calculated. Until then, this field is omitted, not mocked.

**Rejection reasons**

- Ranked normalized reason code/category, count, percentage of failures, first seen, and last seen.
- Link from each reason to retained failed samples, with the retained sample count and expiry disclosure.

**Recent failed samples**

- Occurred time, opaque event ID, normalized reason, destination status/HTTP code when safe and available, validation field names, retry state, and sample expiry.
- Selecting a row opens Mode 2.

**Not shown**

- EventTrace, Payload, Copy payload, Reveal, and Related Events are absent because this mode is not an individual event.

### Mode 2 — Failed delivery sample

Opened only from a real retained failed sample.

**Header**

- Breadcrumb: Store → Events → event name → destination → failed sample.
- Title: `event name → destination`.
- Failure status chip, opaque event ID, occurred time, “Failure sample” badge, and expiry time.
- Action: **Copy diagnostic summary**. There is no Copy payload action.

**Failure trace**

Show only stages explicitly reported for this sample:

1. Received by sGTM — timestamp, if reported.
2. Validation/mapping — pass/fail and missing or invalid field names only.
3. Destination attempt — timestamp, attempt number, and safe latency if reported.
4. Destination result — normalized reason, safe HTTP/destination code, rejected/transport-failed state.
5. Retry state — pending/retried/exhausted and last attempt time, only if the observability sample receives that lifecycle update.

If a stage or timestamp was not reported, show “Not reported”; do not infer it. A destination rejection means the attempt was not accepted, not that no downstream processing ever occurred.

**Diagnostic fields**

- Tenant/store ID (or display name plus internal ID for authorized support users).
- Opaque event ID.
- Event name and destination.
- Schema version and deployed container/config version.
- Normalized reason category/code and reviewed safe summary.
- Validation result expressed as field names/booleans, never submitted values.
- HTTP status or destination code, attempt count, safe latency, and payload byte size when available.
- Received/attempted/failed timestamps and expiry time.

There are no raw values, masked values, or Reveal buttons. Unknown fields are not displayed because they should have been rejected at ingestion.

**Other retained failures**

- Replaces “Related Events (same order).” Shows recent samples with the same event type, destination, and normalized reason.
- It does not claim order, user, or session relationship.

### What V1 Event Details can answer

- Is this event type being observed for this store and destination?
- How much accepted/failed volume was reported in the selected window, and how is it trending?
- Which destination rejection or validation categories are most common?
- What safe operational facts were reported for a retained failed attempt?
- Did the reported failure occur before validation, during destination transport, or as a destination rejection?
- Is the problem isolated or repeated among retained samples, and which config/schema version was active?

### What V1 Event Details cannot answer

- Did a specific successful customer event arrive or deliver, unless it is represented only in aggregate counts?
- What exact payload, header, PII, hashed identity, URL, order, customer, or session values were sent?
- Which other events belong to the same user, session, cart, or order?
- What was the response body for a successful delivery, or a failure detail not included in the safe taxonomy?
- Does absence of a failure sample prove success? It does not; the record may never have been sampled, telemetry may have failed, or TTL may have expired.
- Are aggregate counts a billing-grade or audit-grade ledger? They are operational telemetry, subject to reporting delay, retry/idempotency rules, and explicit data-gap states.

## Decision consequences and guardrails

- The product name “Events Explorer” remains, but its primary rows are explicitly **event-type/destination summaries**, not all event instances.
- “Event Details” is a drawer shell with aggregate-summary and failed-sample modes. Only Mode 2 describes an individual attempt.
- Aggregate counts must remain accurate when failure sampling caps engage — including specifically during an auth/token-rotation storm (`lib/dlq-worker.js:108-121`) — the UI reports true failure totals separately from retained-sample counts.
- Telemetry ingestion must fail open relative to event delivery: an observability outage must not block or materially delay sGTM destination delivery. The mechanism for this is the same unsequenced-tag pattern the existing beacon tag already uses (`lib/gtm-config-builder.js:1842-1858` — no `setupTag`/`teardownTag` linkage to destination tags); the new telemetry tag(s) must be built the same way, not merely intended to behave this way.
- The new path must be additive and opt-in for deployed containers, because the repository’s generated sGTM configuration is the live processing surface. It must authenticate with a per-client API key (the beacon's Path A pattern, `server.js:4299-4302`), not the shared-secret HMAC path (Path B) — only Path A cryptographically binds `clientId` to the writer.
- Owner-scoped reads must authorize against `clientId`; admin access is a separate explicit tier. The customer feature must not accidentally inherit the admin-only posture of current Operations endpoints. **This tier has not been decided** — see Open product decisions below.
- Firestore is the V1 hot operational store, not a raw event warehouse. Any later need for complete or long-lived event records requires a new product/privacy decision and likely a warehouse-oriented backend.
- Every stated retention window (30 days / 13 months / 14 days / 7 days) requires an explicit Firestore TTL policy (a `fieldOverrides` entry or `gcloud firestore fields ttls update`) provisioned and verified as part of implementation, plus a scheduled backstop-deletion sweep as defense-in-depth — this repository currently has no verified-working TTL policy on any collection, including the `dlq_events` precedent this brief drew on.
- Bucket-counter writes must use a sharded/distributed-counter pattern (or per-instance sub-buckets merged by a periodic rollup), not a single document incremented directly by every Cloud Run instance — this deployment scales to 100 instances at 250 concurrency each (`docs/CLOUD-RUN-DEPLOYMENT.md`), well past what one Firestore document can safely absorb as concurrent writers.

## Open product decisions

These are not defects in the analysis — they are choices this brief deliberately leaves to product/engineering sign-off before implementation begins:

1. **Auth tier for the new read endpoints.** Owner-scoped (per-`clientId`, matching the customer-facing intent of Events Explorer) vs. admin-only (matching the existing, but customer-inaccessible, Operations Console pattern). The brief assumes owner-scoped is the goal but this has not been formally decided.
2. **Exact numeric caps.** Per-tenant/per-reason failure-sample ceilings, bucket granularity (e.g. 5-minute vs. hourly), and successful-sample rate `p` (if Option C is ever revisited) are named as concepts, not committed numbers.
3. **TTL backstop ownership.** Whether the scheduled backstop-deletion sweep is built in V1 alongside the native TTL policy, or the native policy is trusted alone once verified working — given the discovered gap, defaulting to "build the backstop" is the safer choice, but it is additional scope.
4. **Fate of the existing `dlq_events` collection.** This brief treats reusing it directly as unsafe (no `clientId`, broader payload/header retention, retry-lifecycle semantics), but does not decide whether `dlq_events` keeps running unchanged as a retry-only mechanism alongside the new failure-sample collection, or is eventually consolidated with it.
5. **Which destinations/event types get telemetry instrumentation first.** The brief assumes all configured destinations equally; a phased rollout (e.g. highest-volume destination first) is a reasonable alternative not evaluated here.
