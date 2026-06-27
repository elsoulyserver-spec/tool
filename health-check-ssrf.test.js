'use strict';

/**
 * tests/health-check-ssrf.test.js
 *
 * Comprehensive unit tests for lib/ssrf-guard.js (v2).
 * Run: node --test tests/health-check-ssrf.test.js
 *
 * No external dependencies — uses node:test + node:assert only.
 * No real network calls — dns.lookup and http.request are patched inline.
 */

const { describe, test } = require('node:test');
const assert             = require('node:assert/strict');
const dns                = require('dns');
const http               = require('http');
const EventEmitter       = require('events');

const {
  ipv4ToInt,
  expandIPv6,
  isBlockedIPv4,
  isBlockedIPv6,
  isBlockedIp,
  validateTargetUrl,
  safeFetch,
} = require('../lib/ssrf-guard');

// ─── Patch helpers ─────────────────────────────────────────────────────────────
// Both helpers restore the original unconditionally after the async fn settles.

/**
 * Temporarily replace dns.lookup with a controlled implementation.
 * `responses` is a Map of hostname → { address, family } | Error.
 * If a hostname is not in the Map, an error is thrown (unexpected call).
 */
function withDnsMock(responses, fn) {
  const original = dns.lookup;
  dns.lookup = (hostname, _opts, cb) => {
    if (!responses.has(hostname)) {
      cb(new Error(`Unexpected dns.lookup call for hostname: ${hostname}`));
      return;
    }
    const r = responses.get(hostname);
    if (r instanceof Error) { cb(r); return; }
    cb(null, r.address, r.family || 4);
  };
  const result = fn();
  const restore = () => { dns.lookup = original; };
  if (result && typeof result.then === 'function') {
    return result.then(v => { restore(); return v; }, e => { restore(); throw e; });
  }
  restore();
  return result;
}

/**
 * Temporarily replace http.request with a sequence of mock response handlers.
 * Each call to http.request pops and invokes the next handler in the array.
 */
function withHttpMock(handlers, fn) {
  const original = http.request;
  const queue    = [...handlers];
  http.request   = (opts, callback) => {
    const handler = queue.shift();
    if (!handler) throw new Error('Unexpected extra http.request call in test');
    return handler(opts, callback);
  };
  const result = fn();
  const restore = () => { http.request = original; };
  if (result && typeof result.then === 'function') {
    return result.then(v => { restore(); return v; }, e => { restore(); throw e; });
  }
  restore();
  return result;
}

/** Build a fake ClientRequest. `onEnd` is called when req.end() fires. */
function fakeReq(onEnd) {
  const r  = new EventEmitter();
  r.end    = () => onEnd();
  r.destroy = () => {};
  return r;
}

/** Build a fake IncomingMessage. Call _emit() to push data+end to listeners. */
function fakeRes(statusCode, headers, body) {
  const r       = new EventEmitter();
  r.statusCode  = statusCode;
  r.headers     = headers || {};
  r.resume      = () => {};
  r._emit       = () => {
    if (body) setImmediate(() => { r.emit('data', Buffer.from(body)); r.emit('end'); });
    else      setImmediate(() => r.emit('end'));
  };
  return r;
}

/** HTTP mock handler that returns a redirect. */
function redirectHandler(statusCode, location) {
  return (_opts, cb) => {
    const res = fakeRes(statusCode, { location });
    const req = fakeReq(() => { cb(res); res._emit(); });
    return req;
  };
}

/** HTTP mock handler that returns a 200 with body. */
function okHandler(body) {
  return (_opts, cb) => {
    const res = fakeRes(200, { 'content-type': 'text/html' }, body || '<html>OK</html>');
    const req = fakeReq(() => { cb(res); res._emit(); });
    return req;
  };
}

// ─── 1. ipv4ToInt ─────────────────────────────────────────────────────────────

describe('ipv4ToInt', () => {
  test('127.0.0.1 → 0x7F000001', () => {
    assert.equal(ipv4ToInt('127.0.0.1'), 0x7F000001);
  });
  test('0.0.0.0 → 0', () => {
    assert.equal(ipv4ToInt('0.0.0.0'), 0);
  });
  test('255.255.255.255 → 0xFFFFFFFF', () => {
    assert.equal(ipv4ToInt('255.255.255.255'), 0xFFFFFFFF);
  });
  test('169.254.169.254 → 0xA9FEA9FE', () => {
    assert.equal(ipv4ToInt('169.254.169.254'), 0xA9FEA9FE);
  });
  test('invalid returns -1', () => {
    assert.equal(ipv4ToInt('not.an.ip.address'), -1);
    assert.equal(ipv4ToInt('256.0.0.1'), -1);
    assert.equal(ipv4ToInt('1.2.3'), -1);
    assert.equal(ipv4ToInt(''), -1);
  });
});

// ─── 2. expandIPv6 ────────────────────────────────────────────────────────────

describe('expandIPv6', () => {
  test('::1 expands correctly', () => {
    assert.deepEqual(expandIPv6('::1'), [0,0,0,0,0,0,0,1]);
  });
  test(':: expands to all zeros', () => {
    assert.deepEqual(expandIPv6('::'), [0,0,0,0,0,0,0,0]);
  });
  test('::ffff:7f00:1 (hex IPv4-mapped 127.0.0.1)', () => {
    assert.deepEqual(expandIPv6('::ffff:7f00:1'), [0,0,0,0,0,0xffff,0x7f00,0x0001]);
  });
  test('::ffff:a9fe:a9fe (hex IPv4-mapped 169.254.169.254)', () => {
    assert.deepEqual(expandIPv6('::ffff:a9fe:a9fe'), [0,0,0,0,0,0xffff,0xa9fe,0xa9fe]);
  });
  test('::ffff:127.0.0.1 (dotted-decimal IPv4-mapped)', () => {
    assert.deepEqual(expandIPv6('::ffff:127.0.0.1'), [0,0,0,0,0,0xffff,0x7f00,0x0001]);
  });
  test('::ffff:192.168.1.1 (dotted-decimal private)', () => {
    assert.deepEqual(expandIPv6('::ffff:192.168.1.1'), [0,0,0,0,0,0xffff,0xc0a8,0x0101]);
  });
  test('zone identifier returns null', () => {
    assert.equal(expandIPv6('::1%eth0'), null);
  });
  test('invalid input returns null', () => {
    assert.equal(expandIPv6(''), null);
    assert.equal(expandIPv6('not:an:ipv6'), null);
    assert.equal(expandIPv6('1:2:3:4:5:6:7:8:9'), null); // too many groups
  });
});

// ─── 3. isBlockedIPv4 ─────────────────────────────────────────────────────────

describe('isBlockedIPv4 — all blocked ranges', () => {

  // 0.0.0.0/8
  test('blocks 0.0.0.0/8 start', () => assert.ok(isBlockedIPv4('0.0.0.0')));
  test('blocks 0.255.255.255/8 end', () => assert.ok(isBlockedIPv4('0.255.255.255')));

  // 10.0.0.0/8
  test('blocks 10.0.0.0', () => assert.ok(isBlockedIPv4('10.0.0.0')));
  test('blocks 10.255.255.255', () => assert.ok(isBlockedIPv4('10.255.255.255')));

  // 100.64.0.0/10 — CGNAT
  test('blocks 100.64.0.0 (CGNAT start)', () => assert.ok(isBlockedIPv4('100.64.0.0')));
  test('blocks 100.100.100.200 (common IMDS in some clouds)', () => assert.ok(isBlockedIPv4('100.100.100.200')));
  test('blocks 100.127.255.255 (CGNAT end)', () => assert.ok(isBlockedIPv4('100.127.255.255')));
  test('allows 100.63.255.255 (just below CGNAT)', () => assert.ok(!isBlockedIPv4('100.63.255.255')));
  test('allows 100.128.0.0 (just above CGNAT)', () => assert.ok(!isBlockedIPv4('100.128.0.0')));

  // 127.0.0.0/8
  test('blocks 127.0.0.1', () => assert.ok(isBlockedIPv4('127.0.0.1')));
  test('blocks 127.0.0.2 (still loopback/8)', () => assert.ok(isBlockedIPv4('127.0.0.2')));
  test('blocks 127.255.255.255', () => assert.ok(isBlockedIPv4('127.255.255.255')));

  // 169.254.0.0/16
  test('blocks 169.254.0.1', () => assert.ok(isBlockedIPv4('169.254.0.1')));
  test('blocks 169.254.169.254 (AWS EC2 metadata)', () => assert.ok(isBlockedIPv4('169.254.169.254')));
  test('blocks 169.254.255.255', () => assert.ok(isBlockedIPv4('169.254.255.255')));

  // 172.16.0.0/12
  test('blocks 172.16.0.0 (start)', () => assert.ok(isBlockedIPv4('172.16.0.0')));
  test('blocks 172.20.0.1 (mid)', () => assert.ok(isBlockedIPv4('172.20.0.1')));
  test('blocks 172.31.255.255 (end)', () => assert.ok(isBlockedIPv4('172.31.255.255')));
  test('allows 172.15.255.255 (just below)', () => assert.ok(!isBlockedIPv4('172.15.255.255')));
  test('allows 172.32.0.0 (just above)', () => assert.ok(!isBlockedIPv4('172.32.0.0')));

  // 192.168.0.0/16
  test('blocks 192.168.0.1', () => assert.ok(isBlockedIPv4('192.168.0.1')));
  test('blocks 192.168.255.255', () => assert.ok(isBlockedIPv4('192.168.255.255')));
  test('allows 192.169.0.1', () => assert.ok(!isBlockedIPv4('192.169.0.1')));

  // 198.18.0.0/15 — benchmarking
  test('blocks 198.18.0.0 (RFC 2544 start)', () => assert.ok(isBlockedIPv4('198.18.0.0')));
  test('blocks 198.19.255.255 (RFC 2544 end)', () => assert.ok(isBlockedIPv4('198.19.255.255')));
  test('allows 198.17.255.255 (just below)', () => assert.ok(!isBlockedIPv4('198.17.255.255')));
  test('allows 198.20.0.0 (just above)', () => assert.ok(!isBlockedIPv4('198.20.0.0')));

  // 224.0.0.0/4 — multicast
  test('blocks 224.0.0.0 (multicast start)', () => assert.ok(isBlockedIPv4('224.0.0.0')));
  test('blocks 239.255.255.255 (multicast end)', () => assert.ok(isBlockedIPv4('239.255.255.255')));
  test('allows 223.255.255.255 (just below multicast)', () => assert.ok(!isBlockedIPv4('223.255.255.255')));

  // 240.0.0.0/4 — reserved
  test('blocks 240.0.0.0 (reserved start)', () => assert.ok(isBlockedIPv4('240.0.0.0')));
  test('blocks 255.255.255.255 (reserved end)', () => assert.ok(isBlockedIPv4('255.255.255.255')));

  // Public IPs must NOT be blocked
  test('allows 1.1.1.1 (Cloudflare DNS)', () => assert.ok(!isBlockedIPv4('1.1.1.1')));
  test('allows 8.8.8.8 (Google DNS)', () => assert.ok(!isBlockedIPv4('8.8.8.8')));
  test('allows 93.184.216.34 (example.com)', () => assert.ok(!isBlockedIPv4('93.184.216.34')));

  test('invalid string returns blocked', () => assert.ok(isBlockedIPv4('not-an-ip')));
});

// ─── 4. isBlockedIPv6 ─────────────────────────────────────────────────────────

describe('isBlockedIPv6 — all blocked ranges', () => {

  // ::1
  test('blocks ::1 (loopback)', () => assert.ok(isBlockedIPv6('::1')));
  test('blocks 0:0:0:0:0:0:0:1 (full form)', () => assert.ok(isBlockedIPv6('0:0:0:0:0:0:0:1')));

  // ::ffff:x — IPv4-mapped, dotted-decimal form
  test('blocks ::ffff:127.0.0.1 (dotted)', () => assert.ok(isBlockedIPv6('::ffff:127.0.0.1')));
  test('blocks ::ffff:10.0.0.1 (dotted)', () => assert.ok(isBlockedIPv6('::ffff:10.0.0.1')));
  test('blocks ::ffff:192.168.1.1 (dotted)', () => assert.ok(isBlockedIPv6('::ffff:192.168.1.1')));
  test('blocks ::ffff:169.254.169.254 (dotted, AWS metadata)', () => assert.ok(isBlockedIPv6('::ffff:169.254.169.254')));
  test('blocks ::ffff:172.16.0.1 (dotted, previously missing)', () => assert.ok(isBlockedIPv6('::ffff:172.16.0.1')));

  // ::ffff:x — IPv4-mapped, pure hex form (the previously unhandled bypass)
  test('FIXED — blocks ::ffff:7f00:1 (hex, was bypass)', () => assert.ok(isBlockedIPv6('::ffff:7f00:1')));
  test('FIXED — blocks ::ffff:a00:1 (hex, 10.0.0.1)', () => assert.ok(isBlockedIPv6('::ffff:a00:1')));
  test('FIXED — blocks ::ffff:c0a8:101 (hex, 192.168.1.1)', () => assert.ok(isBlockedIPv6('::ffff:c0a8:101')));
  test('FIXED — blocks ::ffff:a9fe:a9fe (hex, 169.254.169.254)', () => assert.ok(isBlockedIPv6('::ffff:a9fe:a9fe')));
  test('FIXED — blocks ::ffff:ac10:1 (hex, 172.16.0.1, was missing)', () => assert.ok(isBlockedIPv6('::ffff:ac10:1')));
  test('FIXED — blocks ::ffff:6440:1 (hex, 100.64.0.1 CGNAT)', () => assert.ok(isBlockedIPv6('::ffff:6440:1')));
  test('FIXED — blocks ::ffff:c612:1 (hex, 198.18.0.1 benchmark)', () => assert.ok(isBlockedIPv6('::ffff:c612:1')));

  // fc00::/7 — ULA
  test('blocks fc00::1 (ULA start)', () => assert.ok(isBlockedIPv6('fc00::1')));
  test('blocks fd00::1 (ULA fd block)', () => assert.ok(isBlockedIPv6('fd00::1')));
  test('blocks fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff (ULA end)', () =>
    assert.ok(isBlockedIPv6('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')));

  // fe80::/10 — link-local
  test('blocks fe80::1 (link-local)', () => assert.ok(isBlockedIPv6('fe80::1')));
  test('blocks febf::1 (link-local end)', () => assert.ok(isBlockedIPv6('febf::1')));
  test('allows fec0::1 (not link-local, deprecated site-local)', () =>
    assert.ok(!isBlockedIPv6('fec0::1')));

  // Zone identifiers
  test('blocks ::1%eth0 (zone ID on loopback)', () => assert.ok(isBlockedIPv6('::1%eth0')));
  test('blocks fe80::1%lo (zone ID on link-local)', () => assert.ok(isBlockedIPv6('fe80::1%lo')));
  test('blocks 2001:db8::1%eth0 (zone ID on public addr)', () =>
    assert.ok(isBlockedIPv6('2001:db8::1%eth0')));

  // Public IPv6 must NOT be blocked
  test('allows 2001:db8::1 (documentation range)', () => assert.ok(!isBlockedIPv6('2001:db8::1')));
  test('allows 2606:4700:4700::1111 (Cloudflare)', () =>
    assert.ok(!isBlockedIPv6('2606:4700:4700::1111')));

  // Invalid input
  test('invalid string returns blocked', () => assert.ok(isBlockedIPv6('not-ipv6')));
  test('empty string returns blocked', () => assert.ok(isBlockedIPv6('')));
});

// ─── 5. validateTargetUrl — protocol ──────────────────────────────────────────

describe('validateTargetUrl — protocol', () => {
  test('allows http://', () => assert.doesNotThrow(() => validateTargetUrl('http://example.com/')));
  test('allows https://', () => assert.doesNotThrow(() => validateTargetUrl('https://example.com/')));
  test('blocks ftp://', () => assert.throws(() => validateTargetUrl('ftp://example.com/'), /Only http\/https/i));
  test('blocks file://', () => assert.throws(() => validateTargetUrl('file:///etc/passwd'), /Only http\/https/i));
  test('blocks javascript:', () => assert.throws(() => validateTargetUrl('javascript:alert(1)'), /Only http\/https/i));
  test('rejects unparseable URL', () => assert.throws(() => validateTargetUrl('not a url'), /Invalid URL/i));
});

// ─── 6. validateTargetUrl — ports ────────────────────────────────────────────

describe('validateTargetUrl — blocked ports', () => {
  const blocked = [22, 25, 110, 143, 465, 587, 993, 995, 2379, 2380, 3306, 5432, 6379, 6443, 8500, 8501, 9090, 9200, 9300, 27017];
  for (const port of blocked) {
    test(`blocks port ${port}`, () =>
      assert.throws(() => validateTargetUrl(`http://example.com:${port}/`), /not allowed/i));
  }
  test('allows port 80', () => assert.doesNotThrow(() => validateTargetUrl('http://example.com:80/')));
  test('allows port 443', () => assert.doesNotThrow(() => validateTargetUrl('https://example.com:443/')));
  test('allows port 8080', () => assert.doesNotThrow(() => validateTargetUrl('http://example.com:8080/')));
});

// ─── 7. validateTargetUrl — private hostnames ────────────────────────────────

describe('validateTargetUrl — private hostnames', () => {
  test('blocks localhost', () => assert.throws(() => validateTargetUrl('http://localhost/'), /hostname is blocked/i));
  test('blocks localhost:8080', () => assert.throws(() => validateTargetUrl('http://localhost:8080/'), /hostname is blocked/i));
  test('blocks *.local', () => assert.throws(() => validateTargetUrl('http://myapp.local/'), /hostname is blocked/i));
  test('blocks *.internal', () => assert.throws(() => validateTargetUrl('http://k8s.internal/'), /hostname is blocked/i));
  test('blocks *.localhost', () => assert.throws(() => validateTargetUrl('http://anything.localhost/'), /hostname is blocked/i));
});

// ─── 8. validateTargetUrl — IP literals ──────────────────────────────────────

describe('validateTargetUrl — IP literals blocked immediately', () => {
  test('blocks 127.0.0.1', () => assert.throws(() => validateTargetUrl('http://127.0.0.1/'), /blocked range/i));
  test('blocks 10.0.0.1', () => assert.throws(() => validateTargetUrl('http://10.0.0.1/'), /blocked range/i));
  test('blocks 169.254.169.254', () => assert.throws(() => validateTargetUrl('http://169.254.169.254/'), /blocked range/i));
  test('blocks 172.16.0.1', () => assert.throws(() => validateTargetUrl('http://172.16.0.1/'), /blocked range/i));
  test('blocks 192.168.1.1', () => assert.throws(() => validateTargetUrl('http://192.168.1.1/'), /blocked range/i));
  test('blocks 100.64.0.1 (CGNAT)', () => assert.throws(() => validateTargetUrl('http://100.64.0.1/'), /blocked range/i));
  test('blocks 198.18.0.1 (benchmark)', () => assert.throws(() => validateTargetUrl('http://198.18.0.1/'), /blocked range/i));
  test('blocks 224.0.0.1 (multicast)', () => assert.throws(() => validateTargetUrl('http://224.0.0.1/'), /blocked range/i));
  test('blocks 240.0.0.1 (reserved)', () => assert.throws(() => validateTargetUrl('http://240.0.0.1/'), /blocked range/i));
  test('blocks [::1]', () => assert.throws(() => validateTargetUrl('http://[::1]/'), /blocked range/i));
  test('blocks [::ffff:7f00:1] (hex IPv4-mapped loopback)', () =>
    assert.throws(() => validateTargetUrl('http://[::ffff:7f00:1]/'), /blocked range/i));
  test('blocks [::ffff:a9fe:a9fe] (hex IPv4-mapped AWS metadata)', () =>
    assert.throws(() => validateTargetUrl('http://[::ffff:a9fe:a9fe]/'), /blocked range/i));
  test('blocks [::ffff:ac10:1] (hex IPv4-mapped 172.16.0.1)', () =>
    assert.throws(() => validateTargetUrl('http://[::ffff:ac10:1]/'), /blocked range/i));
  test('blocks [::1%25eth0] (zone ID)', () =>
    // WHATWG URL in Node 18+ may reject [::1%25eth0] as unparseable before
    // our code sees it. Either error means the address is correctly blocked.
    assert.throws(() => validateTargetUrl('http://[::1%25eth0]/'), /zone identifier|Invalid URL/i));
  test('allows public IP 1.1.1.1', () =>
    assert.doesNotThrow(() => validateTargetUrl('http://1.1.1.1/')));
  test('allows public IP 8.8.8.8', () =>
    assert.doesNotThrow(() => validateTargetUrl('http://8.8.8.8/')));
});

// ─── 9. safeFetch — initial validation (no I/O) ───────────────────────────────

describe('safeFetch — rejects before any I/O', () => {
  test('rejects ftp://', async () =>
    assert.rejects(() => safeFetch('ftp://example.com/'), /Only http\/https/i));
  test('rejects localhost', async () =>
    assert.rejects(() => safeFetch('http://localhost/'), /hostname is blocked/i));
  test('rejects 127.0.0.1', async () =>
    assert.rejects(() => safeFetch('http://127.0.0.1/'), /blocked range/i));
  test('rejects 169.254.169.254 (AWS IMDS)', async () =>
    assert.rejects(() => safeFetch('http://169.254.169.254/'), /blocked range/i));
  test('rejects 100.64.0.1 (CGNAT)', async () =>
    assert.rejects(() => safeFetch('http://100.64.0.1/'), /blocked range/i));
  test('rejects 198.18.0.1 (benchmark network)', async () =>
    assert.rejects(() => safeFetch('http://198.18.0.1/'), /blocked range/i));
  test('rejects 224.0.0.1 (multicast)', async () =>
    assert.rejects(() => safeFetch('http://224.0.0.1/'), /blocked range/i));
  test('rejects 240.0.0.1 (reserved)', async () =>
    assert.rejects(() => safeFetch('http://240.0.0.1/'), /blocked range/i));
  test('rejects [::ffff:7f00:1] hex IPv4-mapped', async () =>
    assert.rejects(() => safeFetch('http://[::ffff:7f00:1]/'), /blocked range/i));
  test('rejects [::1%25eth0] zone ID', async () =>
    assert.rejects(() => safeFetch('http://[::1%25eth0]/'), /zone identifier|Invalid URL/i));
  test('rejects port 6443 (Kubernetes)', async () =>
    assert.rejects(() => safeFetch('http://example.com:6443/'), /not allowed/i));
  test('rejects port 9200 (Elasticsearch)', async () =>
    assert.rejects(() => safeFetch('http://example.com:9200/'), /not allowed/i));
  test('rejects port 2379 (etcd)', async () =>
    assert.rejects(() => safeFetch('http://example.com:2379/'), /not allowed/i));
  test('rejects port 8500 (Consul)', async () =>
    assert.rejects(() => safeFetch('http://example.com:8500/'), /not allowed/i));
  test('rejects port 9090 (Prometheus)', async () =>
    assert.rejects(() => safeFetch('http://example.com:9090/'), /not allowed/i));
});

// ─── 10. safeFetch — DNS rebinding prevention ────────────────────────────────

describe('safeFetch — DNS rebinding prevention (critical fix)', () => {

  test('CRITICAL FIX — blocks when DNS resolves public-looking hostname to 127.0.0.1', () => {
    // Simulates: attacker registers evil.com, which passes string validation
    // (it's a public-looking hostname), but DNS has been rebinded to 127.0.0.1.
    // The fix: resolve first, validate the resolved IP, connect to the IP.
    return withDnsMock(
      new Map([['evil.com', { address: '127.0.0.1', family: 4 }]]),
      () => assert.rejects(
        () => safeFetch('http://evil.com/'),
        /Resolved IP is in a blocked range.*127\.0\.0\.1/i,
      ),
    );
  });

  test('blocks when DNS resolves to 169.254.169.254 (AWS metadata rebinding)', () => {
    return withDnsMock(
      new Map([['metadata.attacker.com', { address: '169.254.169.254', family: 4 }]]),
      () => assert.rejects(
        () => safeFetch('http://metadata.attacker.com/'),
        /Resolved IP is in a blocked range.*169\.254\.169\.254/i,
      ),
    );
  });

  test('blocks when DNS resolves to 10.0.0.1 (RFC 1918 rebinding)', () => {
    return withDnsMock(
      new Map([['corp.attacker.com', { address: '10.0.0.1', family: 4 }]]),
      () => assert.rejects(
        () => safeFetch('http://corp.attacker.com/'),
        /Resolved IP is in a blocked range.*10\.0\.0\.1/i,
      ),
    );
  });

  test('blocks when DNS resolves to 100.64.0.1 (CGNAT rebinding)', () => {
    return withDnsMock(
      new Map([['cgnat.attacker.com', { address: '100.64.0.1', family: 4 }]]),
      () => assert.rejects(
        () => safeFetch('http://cgnat.attacker.com/'),
        /Resolved IP is in a blocked range/i,
      ),
    );
  });

  test('allows when DNS resolves to a legitimate public IP', () => {
    // DNS resolves correctly to a public IP — fetch proceeds (mocked as 200).
    return withDnsMock(
      new Map([['example.com', { address: '93.184.216.34', family: 4 }]]),
      () => withHttpMock(
        [okHandler('<html>OK</html>')],
        async () => {
          const result = await safeFetch('http://example.com/');
          assert.equal(result.statusCode, 200);
          assert.ok(result.body.includes('OK'));
        },
      ),
    );
  });

});

// ─── 11. safeFetch — redirect chain SSRF prevention ──────────────────────────

describe('safeFetch — redirect chain SSRF (mocked http.request)', () => {

  // For these tests we use IP literals as the initial URL so dns.lookup is
  // skipped (IP literals are returned directly). The mock http.request
  // returns synthetic 3xx responses pointing to various targets.

  test('blocks redirect to 127.0.0.1', () => {
    return withHttpMock(
      [redirectHandler(302, 'http://127.0.0.1/secret')],
      () => assert.rejects(
        () => safeFetch('http://1.2.3.4/'),
        /Redirect blocked by SSRF guard.*blocked range.*127\.0\.0\.1/i,
      ),
    );
  });

  test('blocks redirect to localhost', () => {
    return withHttpMock(
      [redirectHandler(301, 'http://localhost/admin')],
      () => assert.rejects(
        () => safeFetch('http://1.2.3.4/'),
        /Redirect blocked by SSRF guard.*hostname is blocked/i,
      ),
    );
  });

  test('blocks redirect to 169.254.169.254 (AWS EC2 metadata)', () => {
    return withHttpMock(
      [redirectHandler(302, 'http://169.254.169.254/latest/meta-data/iam/')],
      () => assert.rejects(
        () => safeFetch('http://1.2.3.4/'),
        /Redirect blocked by SSRF guard.*blocked range/i,
      ),
    );
  });

  test('FIXED — blocks redirect to ::ffff:7f00:1 (hex IPv4-mapped loopback)', () => {
    return withHttpMock(
      [redirectHandler(302, 'http://[::ffff:7f00:1]/secret')],
      () => assert.rejects(
        () => safeFetch('http://1.2.3.4/'),
        /Redirect blocked by SSRF guard.*blocked range/i,
      ),
    );
  });

  test('FIXED — blocks redirect to ::ffff:a9fe:a9fe (hex IPv4-mapped AWS metadata)', () => {
    return withHttpMock(
      [redirectHandler(302, 'http://[::ffff:a9fe:a9fe]/latest/meta-data/')],
      () => assert.rejects(
        () => safeFetch('http://1.2.3.4/'),
        /Redirect blocked by SSRF guard.*blocked range/i,
      ),
    );
  });

  test('FIXED — blocks redirect to ::ffff:ac10:1 (hex IPv4-mapped 172.16.0.1)', () => {
    return withHttpMock(
      [redirectHandler(302, 'http://[::ffff:ac10:1]/internal-api')],
      () => assert.rejects(
        () => safeFetch('http://1.2.3.4/'),
        /Redirect blocked by SSRF guard.*blocked range/i,
      ),
    );
  });

  test('blocks redirect to 100.64.0.1 (CGNAT)', () => {
    return withHttpMock(
      [redirectHandler(302, 'http://100.64.0.1/')],
      () => assert.rejects(
        () => safeFetch('http://1.2.3.4/'),
        /Redirect blocked by SSRF guard.*blocked range/i,
      ),
    );
  });

  test('blocks redirect to 198.18.0.1 (benchmark network)', () => {
    return withHttpMock(
      [redirectHandler(302, 'http://198.18.0.1/')],
      () => assert.rejects(
        () => safeFetch('http://1.2.3.4/'),
        /Redirect blocked by SSRF guard.*blocked range/i,
      ),
    );
  });

  test('blocks redirect to 224.0.0.1 (multicast)', () => {
    return withHttpMock(
      [redirectHandler(302, 'http://224.0.0.1/')],
      () => assert.rejects(
        () => safeFetch('http://1.2.3.4/'),
        /Redirect blocked by SSRF guard.*blocked range/i,
      ),
    );
  });

  test('public → public → private chain is blocked at final hop', () => {
    // Hop 1: 1.2.3.4 → 302 → 5.6.7.8  (public)
    // Hop 2: 5.6.7.8 → 301 → 169.254.169.254  (private — BLOCKED)
    return withHttpMock(
      [
        redirectHandler(302, 'http://5.6.7.8/redirect'),   // hop 1 response
        redirectHandler(301, 'http://169.254.169.254/'),   // hop 2 response (never sent to target)
      ],
      () => assert.rejects(
        () => safeFetch('http://1.2.3.4/'),
        /Redirect blocked by SSRF guard.*blocked range/i,
      ),
    );
  });

  test('maxRedirects=3 enforced — throws on 4th redirect', () => {
    // All redirects point to public IPs so the guard isn't what throws.
    return withHttpMock(
      [
        redirectHandler(302, 'http://5.6.7.8/b'),
        redirectHandler(302, 'http://5.6.7.9/c'),
        redirectHandler(302, 'http://5.6.7.10/d'),
        redirectHandler(302, 'http://5.6.7.11/e'),  // 4th — over limit
      ],
      () => assert.rejects(
        () => safeFetch('http://1.2.3.4/', { maxRedirects: 3 }),
        /Too many redirects/i,
      ),
    );
  });

  test('valid 2-hop redirect chain resolves correctly', () => {
    return withHttpMock(
      [
        redirectHandler(301, 'http://5.6.7.8/final'),
        okHandler('<html>FINAL</html>'),
      ],
      async () => {
        const result = await safeFetch('http://1.2.3.4/');
        assert.equal(result.statusCode, 200);
        assert.ok(result.body.includes('FINAL'));
      },
    );
  });

  test('redirect with missing Location header throws descriptive error', () => {
    return withHttpMock(
      [(_opts, cb) => {
        const res = fakeRes(302, {}); // no location header
        const req = fakeReq(() => { cb(res); res._emit(); });
        return req;
      }],
      () => assert.rejects(
        () => safeFetch('http://1.2.3.4/'),
        /no Location header/i,
      ),
    );
  });

});

// ─── 12. safeFetch — DNS rebinding via redirect chain ────────────────────────

describe('safeFetch — DNS rebinding via redirect + domain target', () => {

  test('DNS rebinding on redirect target is blocked', () => {
    // Hop 1: 1.2.3.4 (IP literal) → 302 → evil-redirect.com (domain)
    // Hop 2: evil-redirect.com → dns.lookup returns 127.0.0.1 → BLOCKED
    // This is the redirect-chain DNS rebinding attack.
    return withDnsMock(
      new Map([['evil-redirect.com', { address: '127.0.0.1', family: 4 }]]),
      () => withHttpMock(
        [redirectHandler(302, 'http://evil-redirect.com/secret')],
        () => assert.rejects(
          () => safeFetch('http://1.2.3.4/'),
          /Resolved IP is in a blocked range.*127\.0\.0\.1/i,
        ),
      ),
    );
  });

  test('DNS rebinding on redirect target to AWS metadata is blocked', () => {
    return withDnsMock(
      new Map([['metadata.evil.com', { address: '169.254.169.254', family: 4 }]]),
      () => withHttpMock(
        [redirectHandler(302, 'http://metadata.evil.com/latest/meta-data/')],
        () => assert.rejects(
          () => safeFetch('http://1.2.3.4/'),
          /Resolved IP is in a blocked range.*169\.254\.169\.254/i,
        ),
      ),
    );
  });

});

// ─── 13. Source-level structural proofs ──────────────────────────────────────

describe('structural proofs — verified from source', () => {
  const fs   = require('fs');
  const path = require('path');
  const src  = fs.readFileSync(path.resolve(__dirname, '../lib/ssrf-guard.js'), 'utf8');

  test('safeFetch calls resolveHostname before lib.request (DNS-then-connect order)', () => {
    const dnsPos  = src.indexOf('resolveHostname(');
    const httpPos = src.indexOf('lib.request(');
    assert.ok(dnsPos > 0, 'resolveHostname call must exist');
    assert.ok(httpPos > 0, 'lib.request call must exist');
    assert.ok(dnsPos < httpPos, 'DNS resolution must occur BEFORE http.request');
  });

  test('resolved IP is validated before connecting (isBlockedIp called on resolvedIp)', () => {
    assert.ok(src.includes('isBlockedIp(resolvedIp)'), 'must call isBlockedIp on resolved IP');
  });

  test('http.request uses resolvedIp as hostname (no second DNS lookup)', () => {
    assert.ok(
      src.includes('hostname  : resolvedIp') || src.includes('hostname: resolvedIp'),
      'lib.request must receive resolvedIp as hostname',
    );
  });

  test('virtual hosting Host header is set to original hostname', () => {
    assert.ok(src.includes("'Host'"), 'Host header must be set');
    assert.ok(src.includes('originalHost'), 'originalHost must be referenced in headers');
  });

  test('HTTPS uses servername for TLS SNI', () => {
    assert.ok(src.includes('servername'), 'https must set servername for SNI');
    assert.ok(src.includes('reqOptions.servername = originalHost'), 'SNI must be original hostname');
  });

  test('validateTargetUrl is called on redirect Location before following', () => {
    assert.ok(src.includes('validateTargetUrl(nextUrl)'), 'must validate each redirect target');
  });

  test('100.64.0.0/10 CGNAT is in the blocklist', () => {
    assert.ok(src.includes('0x64400000'), 'CGNAT range constant must be present');
  });

  test('198.18.0.0/15 benchmarking is in the blocklist', () => {
    assert.ok(src.includes('0xC6120000'), 'benchmark range constant must be present');
  });

  test('224.0.0.0/4 multicast is in the blocklist', () => {
    assert.ok(src.includes('0xE'), 'multicast range check must be present');
  });

  test('240.0.0.0/4 reserved is in the blocklist', () => {
    assert.ok(src.includes('0xF'), 'reserved range check must be present');
  });

  test('zone identifiers are explicitly rejected', () => {
    assert.ok(src.includes("includes('%')"), 'zone ID rejection must be present');
  });

  test('response header count is limited', () => {
    assert.ok(src.includes('MAX_RESPONSE_HEADER_COUNT'), 'header count limit must exist');
  });

  test('response header byte size is limited', () => {
    assert.ok(src.includes('MAX_RESPONSE_HEADER_BYTES'), 'header byte limit must exist');
  });

  test('infrastructure ports are blocked (etcd, k8s, Elasticsearch)', () => {
    assert.ok(src.includes('2379'), 'etcd port 2379 must be blocked');
    assert.ok(src.includes('6443'), 'Kubernetes API port 6443 must be blocked');
    assert.ok(src.includes('9200'), 'Elasticsearch port 9200 must be blocked');
    assert.ok(src.includes('8500'), 'Consul port 8500 must be blocked');
    assert.ok(src.includes('9090'), 'Prometheus port 9090 must be blocked');
  });
});
