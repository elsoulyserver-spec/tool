// tests/load-test.js
// Phase 9 — Production load simulation for the EasyTrac sGTM pipeline.
//
// Simulates the GA4 Measurement Protocol traffic that hits a customer's sGTM
// container at various concurrency levels. Does NOT call real CAPI endpoints —
// targets the sGTM /g/collect endpoint with realistic event payloads.
//
// Prerequisites:
//   1. Set SGTM_URL=https://your-sgtm-url env var (or --url flag)
//   2. Set GA4_MEASUREMENT_ID=G-XXXXXXXX env var (or --ga4-id flag)
//   3. npm install (no extra deps — uses Node built-in https)
//
// Usage:
//   node tests/load-test.js --rps 100 --duration 30
//   node tests/load-test.js --rps 500 --duration 60 --url https://sgtm.example.com
//   node tests/load-test.js --rps 1000 --duration 30 --events purchase,add_to_cart
//   node tests/load-test.js --report              (print last results)
//
// Targets: 100 / 500 / 1000 / 5000 rps (as specified in Phase 9)
'use strict';

const https   = require('https');
const http    = require('http');
const { URL } = require('url');
const fs      = require('fs');
const path    = require('path');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(flag, dflt) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
}

const TARGET_URL    = argVal('--url',      process.env.SGTM_URL             || '');
const GA4_ID        = argVal('--ga4-id',   process.env.GA4_MEASUREMENT_ID   || 'G-LOADTEST');
const TARGET_RPS    = parseInt(argVal('--rps',      '100'),  10);
const DURATION_SEC  = parseInt(argVal('--duration', '30'),   10);
const EVENT_TYPES   = (argVal('--events', 'purchase,add_to_cart,view_item')).split(',');
const REPORT_ONLY   = args.includes('--report');
const RESULTS_FILE  = path.join(__dirname, 'load-test-results.json');

if (REPORT_ONLY) {
  try {
    const r = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    console.log(JSON.stringify(r, null, 2));
  } catch (e) { console.error('No results file found. Run a load test first.'); }
  process.exit(0);
}

if (!TARGET_URL) {
  console.error('Error: set SGTM_URL env var or pass --url https://your-sgtm-url');
  process.exit(1);
}

// ─── Payload templates ────────────────────────────────────────────────────────
const ITEMS_JSON = JSON.stringify([
  { id: 'SKU-001', name: 'Load Test Product A', price: 99.99,  quantity: 2 },
  { id: 'SKU-002', name: 'Load Test Product B', price: 149.00, quantity: 1 },
]);

function buildPayload(eventName, seqNum) {
  const eventId = 'lt-' + Date.now() + '-' + seqNum;
  const params = [
    'v=2',
    'tid=' + encodeURIComponent(GA4_ID),
    'cid=lt-client-' + (seqNum % 1000),    // 1000 synthetic clients
    'en=' + encodeURIComponent(eventName),
    'ep.event_id=' + encodeURIComponent(eventId),
    'ep.items_json=' + encodeURIComponent(ITEMS_JSON),
    'ep.items_count=2',
    'ep.items_truncated=0',
    'ep.currency=SAR',
    'ep.value=347.98',
    'ep.transaction_id=LT-TXN-' + seqNum,
    'ep.session_id=lt-session-' + Math.floor(seqNum / 10),
    'up.em=' + 'a'.repeat(64),             // synthetic pre-hashed email
    'up.ph=' + 'b'.repeat(64),
    '_z=crc32',                            // dedup token placeholder
  ].join('&');
  return params;
}

// ─── HTTP sender ───────────────────────────────────────────────────────────────
const parsedUrl = new URL(TARGET_URL.replace(/\/$/, '') + '/g/collect');
const useHttps  = parsedUrl.protocol === 'https:';
const httpLib   = useHttps ? https : http;
const agent     = new (useHttps ? https : http).Agent({ keepAlive: true, maxSockets: 200 });

const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;

function sendEvent(body) {
  return new Promise((resolve) => {
    const t0  = Date.now();
    const req = httpLib.request({
      hostname:  parsedUrl.hostname,
      port:      parsedUrl.port || (useHttps ? 443 : 80),
      path:      parsedUrl.pathname,
      method:    'POST',
      headers:   { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      agent:     agent,
      timeout:   CONNECT_TIMEOUT_MS,
    }, res => {
      res.resume(); // drain
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, latency: Date.now() - t0 }));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); resolve({ ok: false, status: 0, latency: REQUEST_TIMEOUT_MS, error: 'timeout' }); });
    req.on('error', err => resolve({ ok: false, status: 0, latency: Date.now() - t0, error: err.code || err.message }));
    req.write(body);
    req.end();
  });
}

// ─── Load runner ──────────────────────────────────────────────────────────────
async function runLoad() {
  console.log(`\nEasyTrac Load Test`);
  console.log(`  Target:   ${TARGET_URL}`);
  console.log(`  RPS:      ${TARGET_RPS}`);
  console.log(`  Duration: ${DURATION_SEC}s`);
  console.log(`  Events:   ${EVENT_TYPES.join(', ')}`);
  console.log('─'.repeat(50));

  const intervalMs = 1000 / TARGET_RPS;
  const totalTarget = TARGET_RPS * DURATION_SEC;

  const results = { sent: 0, success: 0, failed: 0, errors: {}, latencies: [] };
  const start = Date.now();

  function pickEvent(i) { return EVENT_TYPES[i % EVENT_TYPES.length]; }

  // Burst in chunks of 50ms to approximate the target RPS without flooding the
  // event loop. Each chunk fires Math.round(TARGET_RPS / 20) requests.
  const chunkSize  = Math.max(1, Math.round(TARGET_RPS / 20));
  const chunkDelay = 50; // ms between chunks

  return new Promise((resolve) => {
    let seq = 0;
    const promises = [];

    const timer = setInterval(async () => {
      if (seq >= totalTarget || Date.now() - start >= DURATION_SEC * 1000) {
        clearInterval(timer);
        Promise.all(promises).then(() => resolve(results));
        return;
      }

      const batch = [];
      for (let i = 0; i < chunkSize && seq < totalTarget; i++, seq++) {
        const body = buildPayload(pickEvent(seq), seq);
        batch.push(sendEvent(body).then(r => {
          results.sent++;
          if (r.ok) {
            results.success++;
          } else {
            results.failed++;
            const key = r.error || ('HTTP_' + r.status);
            results.errors[key] = (results.errors[key] || 0) + 1;
          }
          // Sample 10% of latencies to keep memory bounded at high RPS
          if (seq % 10 === 0) results.latencies.push(r.latency);
        }));
      }
      promises.push(...batch);
    }, chunkDelay);
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[i];
}

async function main() {
  const results = await runLoad();

  const elapsed   = DURATION_SEC;
  const actualRps = (results.sent / elapsed).toFixed(1);
  results.latencies.sort((a, b) => a - b);
  const lat = results.latencies;

  const report = {
    timestamp:    new Date().toISOString(),
    config:       { target_rps: TARGET_RPS, duration_sec: DURATION_SEC, events: EVENT_TYPES, url: TARGET_URL },
    results: {
      total_sent:    results.sent,
      success:       results.success,
      failed:        results.failed,
      actual_rps:    parseFloat(actualRps),
      success_rate:  results.sent ? ((results.success / results.sent) * 100).toFixed(2) + '%' : '0%',
      errors:        results.errors,
    },
    latency_ms: {
      p50:  percentile(lat, 50),
      p75:  percentile(lat, 75),
      p90:  percentile(lat, 90),
      p95:  percentile(lat, 95),
      p99:  percentile(lat, 99),
      max:  lat.length ? lat[lat.length - 1] : 0,
      min:  lat.length ? lat[0] : 0,
      mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
    },
  };

  console.log('\n── Results ──');
  console.log(`  Sent:         ${report.results.total_sent}`);
  console.log(`  Success:      ${report.results.success} (${report.results.success_rate})`);
  console.log(`  Failed:       ${report.results.failed}`);
  console.log(`  Actual RPS:   ${report.results.actual_rps}`);
  console.log('\n── Latency (ms) ──');
  console.log(`  p50=${report.latency_ms.p50}  p90=${report.latency_ms.p90}  p95=${report.latency_ms.p95}  p99=${report.latency_ms.p99}  max=${report.latency_ms.max}`);
  if (Object.keys(report.results.errors).length) {
    console.log('\n── Errors ──');
    for (const [k, v] of Object.entries(report.results.errors)) {
      console.log(`  ${k}: ${v}`);
    }
  }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(report, null, 2));
  console.log(`\nFull report saved to ${RESULTS_FILE}`);
}

main().catch(err => { console.error('Load test failed:', err.message); process.exit(1); });
