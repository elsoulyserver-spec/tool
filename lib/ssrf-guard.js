'use strict';

/**
 * lib/ssrf-guard.js — hardened SSRF protection (v2)
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 *
 *   Per-hop pipeline in safeFetch():
 *     1. validateTargetUrl()      — protocol / port / hostname-pattern /
 *                                   IP-literal checks  (sync, zero I/O)
 *     2. resolveHostname()        — ONE dns.lookup() call per hop  (async)
 *     3. isBlockedIp(resolved)    — numeric IP check on the actual IP
 *     4. lib.request({ hostname: resolvedIp, headers:{ Host: orig } })
 *                                 — connect to the IP, no second DNS call
 *
 * ── DNS Rebinding Defence ─────────────────────────────────────────────────────
 *
 *   The hostname is resolved exactly ONCE (step 2). The resolved IP is
 *   validated (step 3). http.request() receives the resolved IP as `hostname`
 *   (step 4) — the OS never performs a second DNS lookup, so there is no
 *   TOCTOU window between validation and connection.
 *
 * ── Redirect Chain Defence ────────────────────────────────────────────────────
 *
 *   Every Location header goes through validateTargetUrl() + resolveHostname()
 *   + isBlockedIp() before the next connection is made.
 *
 * ── Blocked IPv4 Ranges ───────────────────────────────────────────────────────
 *
 *   0.0.0.0/8       — unspecified            (RFC 1122)
 *   10.0.0.0/8      — private                (RFC 1918)
 *   100.64.0.0/10   — CGNAT                  (RFC 6598)
 *   127.0.0.0/8     — loopback               (RFC 1122)
 *   169.254.0.0/16  — link-local / IMDS      (RFC 3927)
 *   172.16.0.0/12   — private                (RFC 1918)
 *   192.168.0.0/16  — private                (RFC 1918)
 *   198.18.0.0/15   — benchmarking           (RFC 2544)
 *   224.0.0.0/4     — multicast              (RFC 5771)
 *   240.0.0.0/4     — reserved               (RFC 1112)
 *
 * ── Blocked IPv6 Ranges ───────────────────────────────────────────────────────
 *
 *   ::1             — loopback               (RFC 4291)
 *   ::ffff:0:0/96   — IPv4-mapped (ALL private IPv4 ranges embedded)
 *   fc00::/7        — ULA (fc00::–fdff::)    (RFC 4193)
 *   fe80::/10       — link-local             (RFC 4291)
 *   Zone identifiers (%eth0 etc.) — always rejected
 */

const dns   = require('dns');
const http  = require('http');
const https = require('https');
const net   = require('net');

// ─── Tuning constants ──────────────────────────────────────────────────────────

const MAX_RESPONSE_HEADER_COUNT = 100;      // reject > 100 response headers
const MAX_RESPONSE_HEADER_BYTES = 16_384;   // 16 KB total response header budget

// ─── Blocked ports ────────────────────────────────────────────────────────────

const BLOCKED_PORTS = new Set([
  22,           // SSH
  25,           // SMTP
  110,          // POP3
  143,          // IMAP
  465,          // SMTPS
  587,          // SMTP submission
  993,          // IMAPS
  995,          // POP3S
  2379, 2380,   // etcd
  3306,         // MySQL / MariaDB
  5432,         // PostgreSQL
  6379,         // Redis
  6443,         // Kubernetes API server
  8500, 8501,   // Consul HTTP / HTTPS
  9090,         // Prometheus
  9200, 9300,   // Elasticsearch HTTP / transport
  27017,        // MongoDB
]);

// ─── Private hostname patterns (no DNS, no I/O) ───────────────────────────────

const PRIVATE_HOST_RE = /^(localhost|.+\.local|.+\.internal|.+\.localhost)$/i;

// ─── IPv4 numeric blocklist ───────────────────────────────────────────────────

/**
 * Converts a dotted-decimal IPv4 string to an unsigned 32-bit integer.
 * Returns -1 for any input that cannot be parsed as a valid IPv4 address.
 *
 * Deliberately strict: only accepts canonical dotted-decimal (the form that
 * dns.lookup() and WHATWG URL always produce). No octal, hex, or compressed
 * notations reach this function.
 *
 * @param {string} ip
 * @returns {number}
 */
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return -1;
  let n = 0;
  for (const p of parts) {
    const oct = parseInt(p, 10);
    if (!Number.isInteger(oct) || oct < 0 || oct > 255) return -1;
    n = ((n << 8) | oct) >>> 0;
  }
  return n;
}

/**
 * Returns true if the IPv4 address falls in ANY blocked range.
 *
 * Uses unsigned 32-bit arithmetic — immune to every IP notation encoding
 * trick (decimal, octal, hex, mixed) because those are normalised to
 * dotted-decimal by WHATWG URL / dns.lookup before reaching here.
 *
 * @param {string} ip  canonical dotted-decimal IPv4
 * @returns {boolean}
 */
function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n < 0) return true;                            // unparseable → block

  /* eslint-disable no-multi-spaces */
  if ((n >>> 24)          === 0)        return true; // 0.0.0.0/8
  if ((n >>> 24)          === 10)       return true; // 10.0.0.0/8
  if ((n & 0xFFC00000)    === 0x64400000) return true; // 100.64.0.0/10  CGNAT
  if ((n >>> 24)          === 127)      return true; // 127.0.0.0/8
  if ((n >>> 16)          === 0xA9FE)   return true; // 169.254.0.0/16
  if (((n & 0xFFF00000) >>> 0) === 0xAC100000) return true; // 172.16.0.0/12
  if ((n >>> 16)          === 0xC0A8)   return true; // 192.168.0.0/16
  if (((n & 0xFFFE0000) >>> 0) === 0xC6120000) return true; // 198.18.0.0/15
  if ((n >>> 28)          === 0xE)      return true; // 224.0.0.0/4  multicast
  if ((n >>> 28)          === 0xF)      return true; // 240.0.0.0/4  reserved
  /* eslint-enable no-multi-spaces */

  return false;
}

// ─── IPv6 expansion and blocklist ─────────────────────────────────────────────

/**
 * Expands an IPv6 address string (without surrounding brackets) to an array
 * of exactly 8 unsigned 16-bit integers.
 *
 * Handles:
 *   • :: compression
 *   • Mixed dotted-decimal suffix (::ffff:192.168.0.1)
 *
 * Returns null on parse failure or if a zone identifier is present.
 *
 * @param {string} raw
 * @returns {number[]|null}
 */
function expandIPv6(raw) {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.includes('%')) return null; // zone identifiers rejected here

  let ip = raw.toLowerCase();

  // Handle mixed IPv4-suffix notation: ::ffff:192.168.0.1
  // Convert the trailing dotted-decimal part to two hex groups first.
  const mixedMatch = ip.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mixedMatch) {
    const prefix = mixedMatch[1];
    const n      = ipv4ToInt(mixedMatch[2]);
    if (n < 0) return null;
    const hi = ((n >>> 16) & 0xFFFF).toString(16);
    const lo =  (n         & 0xFFFF).toString(16);
    ip = `${prefix}${hi}:${lo}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null; // multiple :: is invalid

  const toGroups = (s) => {
    if (s === '') return [];
    return s.split(':').map((g) => {
      if (g === '') return NaN;
      const v = parseInt(g, 16);
      return (Number.isFinite(v) && v >= 0 && v <= 0xFFFF) ? v : NaN;
    });
  };

  const left  = toGroups(halves[0]);
  const right = halves.length === 2 ? toGroups(halves[1]) : [];

  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;

  const fillCount = 8 - left.length - right.length;
  // fillCount === 8 is valid: it means "::" with nothing on either side (all-zeros)
  if (fillCount < 0 || fillCount > 8) return null;

  return [...left, ...Array(fillCount).fill(0), ...right];
}

/**
 * Returns true if the IPv6 address (without brackets) falls in a blocked range.
 *
 * Key case — IPv4-mapped (::ffff:0:0/96):
 *   The embedded IPv4 address is extracted from groups[6..7] and checked
 *   against the full IPv4 blocklist. This catches ALL forms:
 *     ::ffff:127.0.0.1       (dotted-decimal)
 *     ::ffff:7f00:1          (pure hex — the previously unhandled bypass)
 *     ::ffff:a9fe:a9fe       (169.254.169.254 — AWS metadata)
 *     ::ffff:ac10:1          (172.16.0.1 — previously missing from ::ffff check)
 *
 * @param {string} ip  IPv6 address without brackets
 * @returns {boolean}
 */
function isBlockedIPv6(ip) {
  if (typeof ip !== 'string') return true;
  if (ip.includes('%')) return true; // zone identifiers always blocked

  const g = expandIPv6(ip);
  if (!g || g.length !== 8 || g.some(Number.isNaN)) return true; // invalid → block

  // ::1 — loopback
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 &&
      g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) return true;

  // ::ffff:0:0/96 — IPv4-mapped
  // Standard form: groups[0..4] = 0, groups[5] = 0xffff, groups[6..7] = IPv4
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 &&
      g[4] === 0 && g[5] === 0xFFFF) {
    const embeddedIPv4 = [
      (g[6] >>> 8) & 0xFF,
       g[6]        & 0xFF,
      (g[7] >>> 8) & 0xFF,
       g[7]        & 0xFF,
    ].join('.');
    return isBlockedIPv4(embeddedIPv4);
  }

  // fc00::/7 — ULA  (first group high 7 bits = 1111110x → 0xFC00–0xFDFF)
  if ((g[0] & 0xFE00) === 0xFC00) return true;

  // fe80::/10 — link-local  (first group high 10 bits = 1111111010xxxxxx → 0xFE80–0xFEBF)
  if ((g[0] & 0xFFC0) === 0xFE80) return true;

  return false;
}

/**
 * Unified entry point: returns true if the IP string (IPv4 or IPv6) is blocked.
 * Unrecognised format → blocked (fail-closed).
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // unknown format → block
}

// ─── DNS resolution (single lookup, no second lookup possible) ────────────────

/**
 * Resolves `hostname` to a single IP address.
 *
 * If `hostname` is already an IP literal, returns it immediately (no I/O).
 *
 * Otherwise calls dns.lookup() via the OS resolver (libuv / getaddrinfo),
 * which respects /etc/hosts.  The caller receives ONE IP address, validates
 * it with isBlockedIp(), then passes it directly to http.request() as
 * `hostname`.  The OS performs no further DNS lookup during the connection —
 * the TOCTOU window between "check" and "use" is eliminated.
 *
 * @param {string} hostname
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function resolveHostname(hostname, timeoutMs) {
  // Strip IPv6 brackets that WHATWG URL includes in .hostname: "[::1]" → "::1"
  const bare = (hostname.startsWith('[') && hostname.endsWith(']'))
    ? hostname.slice(1, -1)
    : hostname;

  if (net.isIP(bare) !== 0) return Promise.resolve(bare);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`DNS lookup timed out for: ${bare}`));
    }, timeoutMs);

    dns.lookup(bare, { verbatim: true }, (err, address) => {
      clearTimeout(timer);
      if (err) {
        reject(new Error(`DNS lookup failed for ${bare}: ${err.code || err.message}`));
        return;
      }
      if (!address || net.isIP(address) === 0) {
        reject(new Error(`DNS lookup returned invalid address for: ${bare}`));
        return;
      }
      resolve(address);
    });
  });
}

// ─── validateTargetUrl (sync, no I/O) ────────────────────────────────────────

/**
 * Validates the URL for all checks that do not require DNS resolution:
 *   • Protocol: only http / https
 *   • Port: not in BLOCKED_PORTS
 *   • Hostname: not a private name (localhost, *.local, *.internal, *.localhost)
 *   • IPv6 zone identifiers: explicitly rejected
 *   • IP literals: if the hostname is an IP, validate it immediately via isBlockedIp()
 *
 * For domain-name hostnames, DNS resolution and resolved-IP validation happen
 * inside safeFetch() after this function returns. This function is still
 * called first (and on every redirect Location header) to fast-fail obvious
 * targets without any I/O.
 *
 * @param {string} rawUrl
 * @returns {URL}
 */
function validateTargetUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  // ── Protocol ────────────────────────────────────────────────────────────────
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http/https protocols are allowed (got: ${parsed.protocol})`);
  }

  // ── Hostname ────────────────────────────────────────────────────────────────
  // Note: WHATWG URL returns IPv6 hostnames WITH brackets, e.g. "[::1]".
  // We strip them for all subsequent checks so net.isIP() works correctly.
  const rawHost = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!rawHost) throw new Error('URL has no hostname');

  // Strip IPv6 brackets: "[::1]" → "::1"
  const host = (rawHost.startsWith('[') && rawHost.endsWith(']'))
    ? rawHost.slice(1, -1)
    : rawHost;

  // Zone identifiers in IPv6 addresses (::1%eth0) must be rejected before
  // any regex or net.isIP() check — they can bypass the ::1$ pattern.
  // Note: %25 in a URL is the percent-encoded form of %; WHATWG may reject
  // [::1%25eth0] as invalid before we see it, but check anyway.
  if (host.includes('%')) {
    throw new Error(`IPv6 zone identifiers are not allowed: ${host}`);
  }

  // ── Port ────────────────────────────────────────────────────────────────────
  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : (parsed.protocol === 'https:' ? 443 : 80);

  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${String(parsed.port)}`);
  }
  if (BLOCKED_PORTS.has(port)) {
    throw new Error(`Port ${port} is not allowed`);
  }

  // ── Private hostname check (no DNS) ─────────────────────────────────────────
  if (PRIVATE_HOST_RE.test(host)) {
    throw new Error(`Private/internal hostname is blocked: ${host}`);
  }

  // ── IP literal check (no DNS needed) ────────────────────────────────────────
  // If the hostname is already an IP address, validate it immediately.
  // Domain names are validated after DNS resolution in safeFetch().
  if (net.isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new Error(`IP address is in a blocked range: ${host}`);
    }
  }

  return parsed;
}

// ─── safeFetch ────────────────────────────────────────────────────────────────

/**
 * Fetches `targetUrl` with full SSRF protection.
 *
 * See module docblock for architecture details.
 *
 * @param {string}  targetUrl
 * @param {object}  [opts]
 * @param {number}  [opts.maxRedirects=3]
 * @param {number}  [opts.timeoutMs=10000]
 * @param {number}  [opts.maxBodyBytes=512000]
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
async function safeFetch(targetUrl, {
  maxRedirects = 3,
  timeoutMs    = 10_000,
  maxBodyBytes = 500 * 1024,
} = {}) {

  validateTargetUrl(targetUrl);

  let currentUrl    = targetUrl;
  let redirectsLeft = maxRedirects;
  const deadline    = Date.now() + timeoutMs;

  while (true) {                                   // eslint-disable-line no-constant-condition
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Request timeout — deadline exceeded');

    const parsed   = new URL(currentUrl);
    const rawHost  = parsed.hostname.replace(/\.$/, '');
    // Strip IPv6 brackets: WHATWG URL .hostname returns "[::1]" for IPv6 literals
    const originalHost = (rawHost.startsWith('[') && rawHost.endsWith(']'))
      ? rawHost.slice(1, -1)
      : rawHost;
    const port         = parsed.port
      ? parseInt(parsed.port, 10)
      : (parsed.protocol === 'https:' ? 443 : 80);
    const lib          = parsed.protocol === 'https:' ? https : http;

    // ── Step 1: DNS resolution ───────────────────────────────────────────────
    // Budget 20% of the remaining wall-clock time for the DNS lookup,
    // capped at 5 s, with a 2 s floor so we always give the resolver
    // a reasonable chance to respond.
    const dnsTimeout = Math.min(5000, Math.max(2000, Math.floor(remaining * 0.2)));
    const resolvedIp = await resolveHostname(originalHost, dnsTimeout);

    // ── Step 2: validate the resolved IP ────────────────────────────────────
    // This is the DNS-rebinding defence: even if the hostname passed
    // validateTargetUrl() above (because it looked like a public domain),
    // the IP it actually resolves to might be private.
    if (isBlockedIp(resolvedIp)) {
      throw new Error(
        `Resolved IP is in a blocked range: ${resolvedIp} (hostname: ${originalHost})`,
      );
    }

    // ── Step 3: connect to the resolved IP ──────────────────────────────────
    // hostname = IP string  →  no OS DNS lookup during connect (TOCTOU closed)
    // Host header          →  virtual hosting preserved
    // servername (HTTPS)   →  TLS SNI uses the domain, cert verified against it
    const reqOptions = {
      hostname  : resolvedIp,
      port,
      path      : (parsed.pathname || '/') + parsed.search,
      method    : 'GET',
      headers   : {
        // RFC 7230 §5.4: Host = uri-host [":" port]
        'Host'        : (port === 80 || port === 443)
          ? originalHost
          : `${originalHost}:${port}`,
        'User-Agent'  : 'Mozilla/5.0 EasyTrack-HealthBot/1.0',
        'Accept'      : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Connection'  : 'close',
      },
      // Per-request timeout = remaining budget minus the DNS reservation
      timeout   : Math.max(1, remaining - dnsTimeout),
    };

    // For HTTPS, servername drives TLS SNI + certificate verification.
    // Without this, connecting to an IP directly would validate the cert
    // against the IP, not the domain — most certs would fail.
    if (parsed.protocol === 'https:') {
      reqOptions.servername = originalHost;
    }

    const response = await new Promise((resolve, reject) => {
      const req = lib.request(reqOptions, resolve);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.on('error',   reject);
      req.end();
    });

    // ── Step 4: response header guard ───────────────────────────────────────
    const headerKeys  = Object.keys(response.headers);
    const headerBytes = headerKeys.reduce(
      (sum, k) => sum + k.length + String(response.headers[k]).length + 4, 0,
    );

    if (headerKeys.length > MAX_RESPONSE_HEADER_COUNT) {
      response.destroy();
      throw new Error(`Response has too many headers: ${headerKeys.length}`);
    }
    if (headerBytes > MAX_RESPONSE_HEADER_BYTES) {
      response.destroy();
      throw new Error(`Response headers exceed size limit: ${headerBytes} bytes`);
    }

    const { statusCode } = response;

    // ── Redirect ─────────────────────────────────────────────────────────────
    if (statusCode === 301 || statusCode === 302 || statusCode === 303 ||
        statusCode === 307 || statusCode === 308) {

      response.resume(); // drain body to release the socket

      const location = response.headers['location'];
      if (!location) {
        throw new Error(`Redirect ${statusCode} with no Location header`);
      }

      if (redirectsLeft <= 0) {
        throw new Error(`Too many redirects (limit: ${maxRedirects})`);
      }
      redirectsLeft--;

      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl).href;
      } catch {
        throw new Error(`Invalid redirect Location header: ${location}`);
      }

      // validateTargetUrl on the redirect target: protocol / port / IP-literal /
      // private-hostname checks. DNS resolution + IP validation for domain-name
      // redirect targets happens in the next iteration of this loop.
      try {
        validateTargetUrl(nextUrl);
      } catch (e) {
        throw new Error(`Redirect blocked by SSRF guard: ${e.message}`);
      }

      currentUrl = nextUrl;
      continue;
    }

    // ── Body ──────────────────────────────────────────────────────────────────
    let body      = '';
    let bytesRead = 0;
    await new Promise((resolve, reject) => {
      response.on('data', (chunk) => {
        bytesRead += chunk.length;
        if (bytesRead <= maxBodyBytes) body += chunk; // always drain TCP
      });
      response.on('end',   resolve);
      response.on('error', reject);
    });

    return { statusCode, body };
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Primary API
  validateTargetUrl,
  safeFetch,
  resolveHostname,   // exported so server-side POST paths can resolve+validate without going through safeFetch (GET-only)
  // Exported for unit testing — not intended for external callers
  isBlockedIp,
  isBlockedIPv4,
  isBlockedIPv6,
  expandIPv6,
  ipv4ToInt,
};
