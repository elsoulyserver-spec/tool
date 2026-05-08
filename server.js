const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// Zero-dependency .env loader — runs BEFORE any service modules that read
// process.env. Handles `KEY=value` lines, ignores comments/blank lines, does
// NOT evaluate variable expansion or quote stripping because our values are
// raw JSON payloads that include braces and colons.
// ══════════════════════════════════════════════════════════════════════════════
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, 'utf8');
    text.split(/\r?\n/).forEach(line => {
      if (!line || line.trimStart().startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq < 1) return;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1);
      // Strip matching surrounding quotes (but keep inner JSON braces intact)
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    });
  } catch (e) { console.warn('[.env] loader warning:', e.message); }
})();

// ── Puppeteer (optional — graceful fallback if not installed) ──────────────
let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch (_) {}

// ── Managed GTM services (optional — endpoints return 503 if not set up) ──
const gtmService       = require('./gtm-service');
const firestoreService = require('./firestore-service');

// ── Server-Side Tracking services ─────────────────────────────────────────
const cryptoVault  = require('./lib/crypto-vault');
const rateLimiter  = require('./lib/ss-rate-limiter');
const { StapeProvider }      = require('./lib/providers/stape');
const { GoogleCloudProvider } = require('./lib/providers/gcloud');
const { SelfHostedProvider }  = require('./lib/providers/selfhosted');

// ── Startup dependency check ──────────────────────────────────────────────
// Surface missing deps loudly. The providers do `try { require('axios') } catch{}`
// silently — so without this banner, /api/ss/* would just return 502 with no
// hint of what's wrong on the box.
(function depCheck() {
  const missing = [];
  try { require('axios');         } catch (_) { missing.push('axios'); }
  try { require('firebase-admin'); } catch (_) { missing.push('firebase-admin'); }
  if (missing.length) {
    console.warn('');
    console.warn('⚠️  STARTUP WARNING: missing npm dependencies:', missing.join(', '));
    console.warn('   /api/ss/* and /api/managed/* will return 5xx until you run:');
    console.warn('   $ npm install');
    console.warn('');
  }
})();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ══════════════════════════════════════════════════════════════════════════════
// MANAGED GTM JOBS — in-memory async job tracker
// Container creation can take 60-120 seconds because of GTM write-quota pacing
// (20 writes/min). That exceeds Cloudflare / Railway proxy timeouts, so we run
// the work in the background and let the client poll /api/managed/job/:id.
// Jobs are cleaned up 10 minutes after they finish.
// ══════════════════════════════════════════════════════════════════════════════
const managedJobs = new Map();

function _newJobId() {
  return 'job_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function _setJob(id, patch) {
  const cur = managedJobs.get(id) || {};
  managedJobs.set(id, { ...cur, ...patch, updatedAt: Date.now() });
}

function _scheduleJobCleanup(id) {
  setTimeout(() => managedJobs.delete(id), 10 * 60 * 1000).unref?.();
}

// ══════════════════════════════════════════════════════════════════════════════
// SECURITY HEADERS
// Central place for CSP + hardening headers applied to every response.
// Update CSP_DIRECTIVES whenever you add a new external provider/CDN/API.
// ══════════════════════════════════════════════════════════════════════════════
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': [
    "'self'",
    "'unsafe-inline'",                       // tool.html uses many onclick handlers + inline <script>
    "'unsafe-eval'",                         // Firebase SDK uses Function()/eval internally
    'https://www.gstatic.com',               // Firebase SDK
    'https://apis.google.com',               // Google OAuth
    'https://www.googletagmanager.com',      // GTM / GA4
    'https://www.google-analytics.com',
    'https://connect.facebook.net',          // Meta Pixel
    'https://sc-static.net',                 // Snapchat Pixel
    'https://static.ads-twitter.com',        // X / Twitter Pixel
    'https://analytics.tiktok.com',          // TikTok Pixel
    'https://snap.licdn.com',                // LinkedIn Insight
    'https://googleads.g.doubleclick.net',   // Google Ads
    'https://www.googleadservices.com',
    'https://cdnjs.cloudflare.com',          // Misc CDNs
  ],
  'style-src': [
    "'self'",
    "'unsafe-inline'",                       // inline styles are used throughout tool.html
    'https://fonts.googleapis.com',
  ],
  'font-src': [
    "'self'",
    'data:',
    'https://fonts.gstatic.com',
  ],
  'img-src': [
    "'self'",
    'data:',
    'blob:',
    'https:',                                // pixels and CMS logos come from many hosts
  ],
  'connect-src': [
    "'self'",
    // Firebase
    'https://identitytoolkit.googleapis.com',
    'https://securetoken.googleapis.com',
    'https://firestore.googleapis.com',
    'https://firebaseinstallations.googleapis.com',
    'https://*.firebaseio.com',
    'wss://*.firebaseio.com',
    'https://*.firebaseapp.com',
    // Google APIs (GTM publish, OAuth)
    'https://tagmanager.googleapis.com',
    'https://www.googleapis.com',
    'https://oauth2.googleapis.com',
    // Fonts
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
    // Analytics endpoints
    'https://www.google-analytics.com',
    'https://region1.google-analytics.com',
    'https://analytics.google.com',
    // Project-owned
    'https://easy-track-excel-api-production.up.railway.app',
    // CORS proxies (used for CMS scan fallbacks)
    'https://api.allorigins.win',
    'https://corsproxy.io',
    'https://api.codetabs.com',
  ],
  'frame-src': [
    "'self'",
    'https://*.firebaseapp.com',             // Firebase Auth popup
    'https://accounts.google.com',           // Google OAuth popup
  ],
  'frame-ancestors': ["'none'"],             // prevent clickjacking
  'base-uri':        ["'self'"],
  'form-action':     ["'self'"],
  'object-src':      ["'none'"],
  'upgrade-insecure-requests': [],
};

const CSP_HEADER = Object.entries(CSP_DIRECTIVES)
  .map(([d, srcs]) => srcs.length ? `${d} ${srcs.join(' ')}` : d)
  .join('; ');

function securityHeaders(opts) {
  opts = opts || {};
  const h = {
    'X-Content-Type-Options':      'nosniff',
    'X-Frame-Options':             'DENY',
    'Referrer-Policy':             'strict-origin-when-cross-origin',
    'Permissions-Policy':          'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Strict-Transport-Security':   'max-age=31536000; includeSubDomains',
    // Firebase auth uses popup windows, so we need *-allow-popups, not strict same-origin
    'Cross-Origin-Opener-Policy':  'same-origin-allow-popups',
    'Cross-Origin-Resource-Policy':'cross-origin',
  };
  if (opts.html) h['Content-Security-Policy'] = CSP_HEADER;
  return h;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Id, X-GTM-Account-Id, X-GTM-Container-Id, X-GTM-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age':       '86400',
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TRACKING DEFINITIONS
// Each entry describes one platform, how to detect it in network requests,
// and how to extract IDs / event names / parameters from the request URLs.
// ══════════════════════════════════════════════════════════════════════════════
const TRACKING_DEFS = [
  {
    key: 'meta', name: 'Meta Pixel', icon: '👥', color: '#1877F2',
    // URLs that mean the pixel JS is loaded (client-side)
    loadPatterns:  ['connect.facebook.net/signals/fbevents', 'connect.facebook.net/en_US/fbevents', 'connect.facebook.net/signals/config'],
    // URLs that carry event hits — /tr and /tr/ (GET) + /signals/plugins (noscript fallback)
    eventPatterns: ['facebook.com/tr'],
    // URLs that indicate Conversions API / server-side
    serverPatterns: ['graph.facebook.com'],
    extractId:    (u) => {
      // ID can be in: ?id=XXXX, /signals/config/XXXX, or /tr?id=XXXX
      const m = u.match(/[?&]id=(\d{10,})/) || u.match(/signals\/config\/(\d{10,})/) || u.match(/signals\/fbevents\/config\?.*[?&]id=(\d{10,})/);
      return m ? m[1] : null;
    },
    extractEvent: (u) => { const m = u.match(/[?&]ev=([^&]+)/);           return m ? decodeURIComponent(m[1]) : null; },
    extractParams:(u) => {
      // cd[param_name]=value is URL-encoded as cd%5Bparam_name%5D=value
      const raw = u.match(/cd%5B(.+?)%5D=([^&]*)/g) || [];
      return raw.map(p => { const x = p.match(/cd%5B(.+?)%5D=/); return x ? x[1] : null; }).filter(Boolean);
    },
    // Meta CAPI POSTs event data to graph.facebook.com/{pixel_id}/events with JSON body
    extractFromPost: (url, postData) => {
      if (!postData || !url.includes('graph.facebook.com')) return null;
      try {
        const body = typeof postData === 'string' ? JSON.parse(postData) : postData;
        if (body.data && Array.isArray(body.data) && body.data.length) {
          return body.data.map(d => ({
            name: d.event_name || null,
            params: Object.keys(d.custom_data || {}),
          })).filter(e => e.name);
        }
      } catch (e) {}
      return null;
    },
    requiredParams: { Purchase: ['value','currency'], AddToCart: ['content_ids','content_type'], ViewContent: ['content_ids','content_type'] },
  },
  {
    key: 'gtm', name: 'Google Tag Manager', icon: '📦', color: '#246FDB',
    loadPatterns:  ['googletagmanager.com/gtm.js'],
    eventPatterns: [],
    serverPatterns: ['googletagmanager.com/a?id='],   // GTM server-side container
    extractId: (u) => { const m = u.match(/[?&]id=(GTM-[A-Z0-9]+)/); return m ? m[1] : null; },
  },
  {
    key: 'ga4', name: 'Google Analytics (GA4)', icon: '📊', color: '#E37400',
    loadPatterns:  ['googletagmanager.com/gtag/js?id=G-'],
    eventPatterns: ['google-analytics.com/g/collect', 'analytics.google.com/g/collect'],
    serverPatterns: [],
    extractId:    (u) => { const m = u.match(/[?&]tid=(G-[A-Z0-9]+)/) || u.match(/id=(G-[A-Z0-9]+)/); return m ? m[1] : null; },
    extractEvent: (u) => { const m = u.match(/[?&]en=([^&]+)/);   return m ? decodeURIComponent(m[1]) : null; },
    extractParams:(u) => {
      // GA4 sends params as ep.param or epn.param
      const keys = [];
      (u.match(/[?&]ep\.([^=]+)=/g) || []).forEach(p => { const x = p.match(/ep\.([^=]+)=/); if(x) keys.push(x[1]); });
      (u.match(/[?&]epn\.([^=]+)=/g) || []).forEach(p => { const x = p.match(/epn\.([^=]+)=/); if(x) keys.push(x[1]); });
      return keys;
    },
  },
  {
    key: 'google_ads', name: 'Google Ads', icon: '🎯', color: '#4285F4',
    loadPatterns:  ['googleadservices.com/pagead/conversion_async.js', 'googletagmanager.com/gtag/js?id=AW-'],
    eventPatterns: ['googleads.g.doubleclick.net/pagead/viewthroughconversion', 'google.com/pagead/1p-conversion', 'googleadservices.com/pagead/conversion/'],
    serverPatterns: [],
    extractId: (u) => {
      const m = u.match(/viewthroughconversion\/(\d+)/)
             || u.match(/conversion\/(\d{9,})/)
             || u.match(/[?&]id=(AW-[0-9]+)/)
             || u.match(/\/(\d{9,})\//);
      if (!m) return null;
      return m[1].startsWith('AW-') ? m[1] : 'AW-' + m[1];
    },
    // Google Ads conversion endpoints ALWAYS represent a 'conversion' event —
    // the event name isn't in the URL because it's implied by the endpoint itself.
    // Multiple hits with different conversion labels = different conversion actions.
    extractEvent: (u) => {
      if (/viewthroughconversion|1p-conversion|pagead\/conversion\//.test(u)) return 'conversion';
      return null;
    },
    extractParams: (u) => {
      const params = [];
      if (/[?&]label=/i.test(u)) params.push('label');
      if (/[?&]value=/i.test(u)) params.push('value');
      if (/[?&]currency_code=/i.test(u)) params.push('currency_code');
      if (/[?&]oid=/i.test(u) || /[?&]transaction_id=/i.test(u)) params.push('transaction_id');
      return params;
    },
  },
  {
    key: 'tiktok', name: 'TikTok Pixel', icon: '🎵', color: '#010101',
    loadPatterns:  ['analytics.tiktok.com/i18n/pixel/static', 'analytics.tiktok.com/i18n/pixel/events.js'],
    // Modern TikTok endpoint is /api/v2/pixel (POST with JSON); older one was /i18n/pixel/events
    eventPatterns: [
      'analytics.tiktok.com/api/v2/pixel',
      'analytics.tiktok.com/api/v2/pixel/track',
      'analytics.tiktok.com/api/v2/pixel/batch',
      'analytics.tiktok.com/i18n/pixel/events',
    ],
    serverPatterns: ['business-api.tiktok.com'],
    extractId:    (u) => {
      const m = u.match(/sdkid=([A-Z0-9]+)/i)
             || u.match(/pixel_code=([A-Z0-9]+)/i)
             || u.match(/pixel_id=([A-Z0-9]+)/i)
             || u.match(/\/static\/([A-Z0-9]{12,})\//i);
      return m ? m[1] : null;
    },
    extractEvent: (u) => { const m = u.match(/[?&]event=([^&]+)/); return m ? decodeURIComponent(m[1]) : null; },
    extractParams:(u) => {
      const raw = u.match(/properties%5B([^\]%]+)(?:%5D)?=/g) || [];
      return raw.map(p => { const x = p.match(/properties%5B([^\]%]+)/); return x ? decodeURIComponent(x[1]) : null; }).filter(Boolean);
    },
    // Modern TikTok POSTs JSON: { event: "Purchase", properties: {...}, context: {...} }
    // Or for batch: { batch: [{event, properties}, ...] }
    extractFromPost: (url, postData) => {
      if (!postData) return null;
      try {
        const body = typeof postData === 'string' ? JSON.parse(postData) : postData;
        const events = [];
        if (body.event) {
          events.push({
            name: body.event,
            params: Object.keys(body.properties || body.context || {}).filter(k => k !== 'user' && k !== 'page'),
          });
          // Merge nested properties/context/page keys for fuller view
          if (body.properties) Object.keys(body.properties).forEach(k => {
            if (events[0].params.indexOf(k) === -1) events[0].params.push(k);
          });
        }
        if (Array.isArray(body.batch)) {
          body.batch.forEach(ev => {
            if (ev.event) events.push({
              name: ev.event,
              params: Object.keys(ev.properties || {}),
            });
          });
        }
        // TikTok sometimes sends `event_name` instead of `event` (v2 API)
        if (!events.length && body.event_name) {
          events.push({
            name: body.event_name,
            params: Object.keys(body.properties || body.custom_data || {}),
          });
        }
        return events.length ? events : null;
      } catch (e) {}
      return null;
    },
    requiredParams: { Purchase: ['value','currency','content_id'], AddToCart: ['content_id','content_type'] },
  },
  {
    key: 'snapchat', name: 'Snapchat Pixel', icon: '👻', color: '#FFFC00',
    loadPatterns:  ['sc-static.net/scevent.min.js'],
    // tr.snapchat.com/p = event endpoint; /cm and /gcm = cookie/id matching only
    eventPatterns: ['tr.snapchat.com/p', 'tr.snapchat.com/cm/p', 'sc-analytics.appspot.com'],
    serverPatterns: [],
    extractId: (u) => {
      const m = u.match(/[?&]pid=([A-Za-z0-9\-]{8,})/i)
             || u.match(/[?&]pixel_id=([A-Za-z0-9\-]{8,})/i);
      return m ? m[1] : null;
    },
    // Snap pixel sends event name in e_n or e_c query param, or in path like /p/PAGE_VIEW
    extractEvent: (u) => {
      const m = u.match(/[?&]e_n=([^&]+)/)
             || u.match(/[?&]e_c=([^&]+)/)
             || u.match(/[?&]event=([^&]+)/)
             || u.match(/[?&]event_type=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
      // Default PAGE_VIEW for bare tr.snapchat.com/p calls
      if (/tr\.snapchat\.com\/p(\?|$)/.test(u)) return 'PAGE_VIEW';
      return null;
    },
    // Snap params: e_pr=price, e_cu=currency, e_ti=transaction_id, e_iids=item_ids
    extractParams: (u) => {
      const params = [];
      if (/[?&]e_pr=/i.test(u)) params.push('price');
      if (/[?&]e_cu=/i.test(u)) params.push('currency');
      if (/[?&]e_ti=/i.test(u)) params.push('transaction_id');
      if (/[?&]e_iids=/i.test(u)) params.push('item_ids');
      if (/[?&]e_ic=/i.test(u)) params.push('item_category');
      if (/[?&]e_ni=/i.test(u)) params.push('number_items');
      if (/[?&]e_dl=/i.test(u)) params.push('description');
      if (/[?&]e_ss=/i.test(u)) params.push('search_string');
      return params;
    },
    // Snap CAPI can POST JSON bodies to /v3/<pixel_id>/events
    extractFromPost: (url, postData) => {
      if (!postData) return null;
      try {
        const body = typeof postData === 'string' ? JSON.parse(postData) : postData;
        if (body && body.data && Array.isArray(body.data) && body.data.length) {
          return body.data.map(d => ({
            name: d.event_name || d.event_type || null,
            params: Object.keys(d.custom_data || d.event_custom_data || {}),
          })).filter(e => e.name);
        }
        if (body && (body.event_name || body.event_type)) {
          return {
            name: body.event_name || body.event_type,
            params: Object.keys(body.custom_data || body.event_custom_data || {}),
          };
        }
      } catch (e) {}
      return null;
    },
  },
  {
    key: 'twitter', name: 'X (Twitter) Pixel', icon: '𝕏', color: '#000000',
    loadPatterns:  ['static.ads-twitter.com/uwt.js'],
    eventPatterns: ['t.co/i/adsct', 'analytics.twitter.com/i/adsct'],
    serverPatterns: [],
    extractId: (u) => { const m = u.match(/[?&]p_id=(\w+)/) || u.match(/[?&]txn_id=(\w+)/); return m ? m[1] : null; },
    // X/Twitter adsct: events param carries the event name, or "page_view" by default
    extractEvent: (u) => {
      const m = u.match(/[?&]events=%5B%5B%22([^%]+)%22/) || u.match(/[?&]events=\[\[%22([^%]+)%22/);
      if (m) return decodeURIComponent(m[1]);
      if (/\/i\/adsct/.test(u)) return 'PageView';
      return null;
    },
    extractParams: (u) => {
      const params = [];
      if (/[?&]value=/i.test(u)) params.push('value');
      if (/[?&]currency=/i.test(u)) params.push('currency');
      if (/[?&]conversion_id=/i.test(u)) params.push('conversion_id');
      return params;
    },
  },
  {
    key: 'linkedin', name: 'LinkedIn Insight', icon: '💼', color: '#0A66C2',
    loadPatterns:  ['snap.licdn.com/li.lms-analytics'],
    eventPatterns: ['px.ads.linkedin.com'],
    serverPatterns: [],
    extractId: (u) => { const m = u.match(/partner_id=(\d+)/) || u.match(/pid=(\d+)/); return m ? m[1] : null; },
    // LinkedIn Insight Tag: conversionId param = conversion event, otherwise page_view
    extractEvent: (u) => {
      if (/[?&]conversionId=/i.test(u)) return 'conversion';
      if (/px\.ads\.linkedin\.com/.test(u)) return 'page_view';
      return null;
    },
    extractParams: (u) => {
      const params = [];
      if (/[?&]conversionId=/i.test(u)) params.push('conversion_id');
      if (/[?&]value=/i.test(u)) params.push('value');
      if (/[?&]currency=/i.test(u)) params.push('currency');
      return params;
    },
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// ANALYSE INTERCEPTED NETWORK REQUESTS
// ══════════════════════════════════════════════════════════════════════════════
function analyzeRequests(requests) {
  const found = {};

  const addEvent = (entry, name, params) => {
    if (!name) return;
    const existing = entry.events.find(e => e.name === name);
    if (existing) {
      (params || []).forEach(p => { if (p && !existing.params.includes(p)) existing.params.push(p); });
    } else {
      entry.events.push({ name, params: params || [] });
    }
  };

  requests.forEach(req => {
    const url = req.url || '';
    const postData = req.postData || null;

    TRACKING_DEFS.forEach(def => {
      const isLoad   = (def.loadPatterns   || []).some(p => url.includes(p));
      const isEvent  = (def.eventPatterns  || []).some(p => url.includes(p));
      const isServer = (def.serverPatterns || []).some(p => url.includes(p));
      if (!isLoad && !isEvent && !isServer) return;

      if (!found[def.key]) {
        found[def.key] = {
          key:           def.key,
          name:          def.name,
          icon:          def.icon,
          color:         def.color || '#adc6ff',
          ids:           [],
          events:        [],
          isServerSide:  false,
          requestCount:  0,
          eventHitCount: 0, // separate counter: how many event-endpoint hits we saw
        };
      }
      const entry = found[def.key];
      entry.requestCount++;

      if (isServer) entry.isServerSide = true;
      if (isEvent || isServer) entry.eventHitCount++;

      // Extract pixel / tag ID (try URL first)
      if (def.extractId) {
        const id = def.extractId(url);
        if (id && !entry.ids.includes(id)) entry.ids.push(id);
      }

      // ── Extract event from URL query ──
      let extractedFromUrl = false;
      if (def.extractEvent) {
        const evName = def.extractEvent(url);
        if (evName) {
          const params = def.extractParams ? def.extractParams(url) : [];
          addEvent(entry, evName, params);
          extractedFromUrl = true;
        }
      }

      // ── Extract event from POST body (modern TikTok v2, Meta CAPI, etc.) ──
      if (!extractedFromUrl && postData && def.extractFromPost) {
        try {
          const result = def.extractFromPost(url, postData);
          if (result) {
            if (Array.isArray(result)) {
              result.forEach(ev => addEvent(entry, ev.name, ev.params));
            } else if (result.name) {
              addEvent(entry, result.name, result.params);
            }
          }
        } catch (e) { /* ignore malformed bodies */ }
      }

      // Note: no more generic fallback — every platform now has extractEvent,
      // so if no event was parsed it genuinely means the pixel didn't fire.
    });
  });

  return Object.values(found);
}

// ══════════════════════════════════════════════════════════════════════════════
// PUPPETEER SCANNER
// Opens the page in a real headless Chrome, intercepts every network request,
// waits for lazy-loaded scripts, then returns HTML + full request log + pixels.
// ══════════════════════════════════════════════════════════════════════════════
async function scanWithPuppeteer(targetUrl) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  });

  try {
    const page = await browser.newPage();

    // Realistic desktop UA
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Collect every outgoing request (including POST bodies — critical for modern
    // pixels like TikTok v2 API and Meta CAPI which ship events in JSON bodies)
    const requests = [];
    await page.setRequestInterception(true);
    page.on('request', req => {
      requests.push({
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        postData: req.postData() || null,
      });
      req.continue();
    });

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Initial wait for pixels that fire on DOM ready
    await new Promise(r => setTimeout(r, 2000));

    // Simulate scroll — triggers lazy-loaded pixels (e.g. scroll-based Meta events,
    // lazy-loaded GTM snippets, or Scroll trigger in GTM). Also triggers viewport
    // observers which many pixels rely on.
    try {
      await page.evaluate(() => {
        window.scrollTo(0, Math.min(document.body.scrollHeight / 2, 1500));
      });
      await new Promise(r => setTimeout(r, 1500));
      await page.evaluate(() => { window.scrollTo(0, 0); });
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) { /* scroll can fail on some sites — ignore */ }

    // Final wait for post-scroll pixel fires
    await new Promise(r => setTimeout(r, 1500));

    const html        = await page.content();
    const resolvedUrl = page.url();

    await browser.close();

    const pixels = analyzeRequests(requests);

    return {
      html,
      url:        resolvedUrl,
      pixels,
      method:     'puppeteer',
      reqCount:   requests.length,
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HTTP FALLBACK (no Puppeteer)
// ══════════════════════════════════════════════════════════════════════════════
function fetchWithHttp(targetUrl, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('Too many redirects')); return; }
    const lib = targetUrl.startsWith('https') ? https : http;
    lib.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EasyTrackScanner/1.0)' } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const loc  = res.headers.location;
        const next = loc.startsWith('http') ? loc : new URL(loc, targetUrl).href;
        return resolve(fetchWithHttp(next, redirects + 1));
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (html.length < 800000) html += c; });
      res.on('end', () => resolve({ html, url: targetUrl, pixels: [], method: 'http' }));
    }).on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
const mime = {
  '.html':  'text/html; charset=utf-8',
  '.css':   'text/css',
  '.js':    'application/javascript',
  '.json':  'application/json',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.webp':  'image/webp',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.txt':   'text/plain; charset=utf-8',
  '.map':   'application/json',
};

// Extensions the public static server is allowed to hand out.
// Everything NOT in this set (server.js, package.json, Dockerfile, .env, ...)
// is blocked with 403 even if present in the root folder.
const STATIC_ALLOW_EXT = new Set([
  '.html', '.css',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
  '.txt', '.map',
]);

// Default 1 MB body cap (covers full GTM container imports). Override per-call
// by passing a maxBytes argument. /api/ss/* endpoints use a 64 KB cap because
// they only ever receive small JSON config blobs.
const DEFAULT_BODY_LIMIT = 1024 * 1024;
const SS_BODY_LIMIT      = 64   * 1024;

function parseBody(req, cb, maxBytes) {
  const limit = maxBytes || DEFAULT_BODY_LIMIT;
  // Reject early when the client advertises an oversize body
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared && declared > limit) {
    const err = new Error('Request body too large');
    err.code = 'BODY_TOO_LARGE';
    err.statusCode = 413;
    return cb(err);
  }

  let received = 0;
  const chunks  = [];
  let aborted   = false;

  req.on('data', chunk => {
    if (aborted) return;
    received += chunk.length;
    if (received > limit) {
      aborted = true;
      const err = new Error('Request body exceeded ' + limit + ' bytes');
      err.code = 'BODY_TOO_LARGE';
      err.statusCode = 413;
      // Stop reading and signal the client
      req.destroy();
      return cb(err);
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (e) { cb(e); }
  });
  req.on('error', e => { if (!aborted) { aborted = true; cb(e); } });
}

// Wraps parseBody with proper HTTP-error responses on failure:
//   err.code === 'BODY_TOO_LARGE' → 413 with the limit in bytes
//   any other error / empty body  → 400 with a generic JSON error
// On success: cb(body) is called. Use this from every /api/* route that
// reads a JSON body — it surfaces 413 correctly to clients trying to upload
// oversize payloads, instead of swallowing it as 400 'Invalid JSON'.
function parseJsonBody(req, res, cb, limit) {
  parseBody(req, (err, body) => {
    if (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        sendJSON(res, 413, { error: 'الـ body أكبر من المسموح (' + (limit || DEFAULT_BODY_LIMIT) + ' bytes)' });
      } else {
        sendJSON(res, 400, { error: 'Invalid JSON' });
      }
      return;
    }
    if (!body) { sendJSON(res, 400, { error: 'Empty or invalid JSON body' }); return; }
    cb(body);
  }, limit);
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(),
    ...securityHeaders(),
  });
  res.end(body);
}

// ══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════════════════════════════════
http.createServer((req, res) => {

  // ── CORS preflight ──────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...corsHeaders(), ...securityHeaders() });
    res.end();
    return;
  }

  // ── GTM Import Proxy ─────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/gtm/import') {
    parseJsonBody(req, res, body => {

      const accountId   = req.headers['x-gtm-account-id'];
      const containerId = req.headers['x-gtm-container-id'];
      const authToken   = req.headers['x-gtm-token'];

      if (!accountId || !containerId || !authToken) {
        sendJSON(res, 400, { error: 'Missing x-gtm-account-id, x-gtm-container-id, or x-gtm-token headers' });
        return;
      }

      const gtmApiBody = body.exportFormatVersion !== undefined
        ? { containerConfigJSON: JSON.stringify(body) }
        : body;

      const postData = JSON.stringify(gtmApiBody);
      const options  = {
        hostname: 'tagmanager.googleapis.com',
        path: `/tagmanager/v2/accounts/${accountId}/containers/${containerId}/versions:import`,
        method: 'POST',
        headers: {
          'Authorization':  `Bearer ${authToken}`,
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const apiReq = https.request(options, apiRes => {
        let result = '';
        apiRes.on('data', c => { result += c; });
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            ...corsHeaders(),
            ...securityHeaders(),
          });
          res.end(result);
        });
      });
      apiReq.on('error', e => sendJSON(res, 502, { error: e.message }));
      apiReq.write(postData);
      apiReq.end();
    });
    return;
  }

  // ── Pixel Scanner ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/scan-url') {
    parseJsonBody(req, res, async body => {

      let targetUrl = (body && body.url) ? body.url.trim() : '';
      if (!targetUrl) { sendJSON(res, 400, { error: 'Missing url' }); return; }
      if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

      try {
        let result;
        if (puppeteer) {
          result = await scanWithPuppeteer(targetUrl);
        } else {
          console.warn('[scanner] Puppeteer not available — falling back to HTTP fetch');
          result = await fetchWithHttp(targetUrl);
        }
        sendJSON(res, 200, result);
      } catch (e) {
        console.error('[scanner] Error:', e.message);
        sendJSON(res, 502, { error: e.message });
      }
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MANAGED GTM ENDPOINTS
  // Creates containers in our own GTM account so non-technical clients don't
  // have to OAuth into their own GTM. See gtm-service.js + firestore-service.js.
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/managed/health — capacity + config status (for ops dashboard)
  if (req.method === 'GET' && req.url === '/api/managed/health') {
    (async () => {
      const ready = gtmService.isConfigured() && firestoreService.isConfigured();
      let count = null, tokenOk = false, err = null, containers = null;
      if (ready) {
        try { await gtmService.getAccessToken(); tokenOk = true; } catch (e) { err = e.message; }
        if (tokenOk) {
          try { containers = await gtmService.listContainers(); } catch (e) { err = err || e.message; }
        }
        try { count = await firestoreService.countActiveContainers(); } catch (e) { err = err || e.message; }
      }
      sendJSON(res, 200, {
        configured: ready,
        tokenOk,
        activeContainers: count,
        capacityHint: count !== null ? Math.max(0, 500 - count) : null,
        error: err,
        gtmConfigured:       gtmService.isConfigured(),
        firestoreConfigured: firestoreService.isConfigured(),
        gtmAccountId:        process.env.GTM_ACCOUNT_ID || null,
        gtmContainerCount:   containers ? containers.length : null,
      });
    })().catch(e => sendJSON(res, 500, { error: e.message }));
    return;
  }

  // POST /api/managed/create-container
  // Body: { clientId, clientEmail, projectName, domain?, cmsType, platforms,
  //         events, pixelIds, configJson, publishLive }
  //
  // Returns { ok: true, jobId } IMMEDIATELY (202). The actual GTM provisioning
  // runs in the background because it takes 60-120s (write-quota pacing) and
  // that would blow past Cloudflare / Railway proxy timeouts. Client must poll
  // GET /api/managed/job/:jobId until status === 'completed' or 'failed'.
  if (req.method === 'POST' && req.url === '/api/managed/create-container') {
    parseJsonBody(req, res, body => {

      if (!gtmService.isConfigured()) {
        return sendJSON(res, 503, {
          error: 'Managed GTM is not configured on this server',
          hint:  'Set GTM_SA_KEY_JSON and GTM_ACCOUNT_ID env vars',
        });
      }
      if (!firestoreService.isConfigured()) {
        return sendJSON(res, 503, {
          error: 'Firestore is not configured on this server',
          hint:  'Set FIREBASE_SA_KEY_JSON env var and `npm install firebase-admin`',
        });
      }

      const { clientId, clientEmail, projectName, domain, cmsType,
              platforms, events, pixelIds, configJson, publishLive } = body;

      // Tracking mode picker — 'client' (default) or 'client_server'.
      // Anything else is normalised to 'client' so old callers keep working.
      const mode = (body.mode === 'client_server') ? 'client_server' : 'client';

      if (!clientId)    return sendJSON(res, 400, { error: 'Missing clientId' });
      if (!configJson)  return sendJSON(res, 400, { error: 'Missing configJson' });

      // Spawn background job and respond immediately
      const jobId = _newJobId();
      _setJob(jobId, {
        status:    'pending',
        stage:     'queued',
        clientId,
        startedAt: Date.now(),
      });

      // Fire-and-forget — errors are captured into the job record, not thrown.
      (async () => {
        try {
          _setJob(jobId, { status: 'running', stage: 'capacity_check' });

          // 1. Capacity guard — GTM caps at 500 containers per account
          const activeCount = await firestoreService.countActiveContainers();
          if (activeCount >= 490) {
            _setJob(jobId, {
              status: 'failed',
              stage:  'capacity_exceeded',
              error:  'Managed GTM account is near capacity',
              hint:   'Provision a new GTM_ACCOUNT_ID and route new clients there',
              httpStatus: 507,
              activeContainers: activeCount,
            });
            _scheduleJobCleanup(jobId);
            return;
          }

          // 2. Provision via GTM API. Branch on mode:
          //    - 'client'        → existing single-container flow (publishes live).
          //    - 'client_server' → web + server containers; web is left
          //                        UNPUBLISHED so /api/ss/wire-transport can
          //                        patch the GA4 transport_url and republish
          //                        once the user confirms the sGTM URL.
          _setJob(jobId, { stage: 'gtm_provisioning', mode });

          const provisionOpts = {
            projectName: projectName || `${clientEmail || 'client'} — ${cmsType || 'site'}`,
            domain,
            configJson,
            publishLive: mode === 'client_server' ? false : !!publishLive,
            inviteEmail: clientEmail || null,
            onProgress: (p) => _setJob(jobId, { stage: 'gtm_provisioning', progress: p }),
          };

          let webResult;
          let serverResult = null;
          if (mode === 'client_server') {
            const both    = await gtmService.provisionForClientWithServer(provisionOpts);
            webResult     = both.web;
            serverResult  = both.server;
          } else {
            webResult = await gtmService.provisionForClient(provisionOpts);
          }

          // 3. Persist web container to Firestore (existing collection)
          _setJob(jobId, { stage: 'saving' });
          await firestoreService.saveContainer({
            clientId,
            clientEmail: clientEmail || null,
            projectName: projectName  || null,
            domain:      domain       || null,
            cmsType:     cmsType      || null,
            platforms:   platforms    || [],
            events:      events       || [],
            pixelIds:    pixelIds     || {},
            gtmAccountId:   webResult.gtmAccountId,
            gtmContainerId: webResult.gtmContainerId,
            gtmPublicId:    webResult.gtmPublicId,
            gtmWorkspaceId: webResult.gtmWorkspaceId,
            gtmVersionId:   webResult.gtmVersionId,
            published:      webResult.published,
            publishedAt:    webResult.publishedAt,
            snippetHead:    webResult.snippetHead,
            snippetBody:    webResult.snippetBody,
            containerName:  webResult.containerName || null,
            invited:        !!webResult.invited,
            inviteEmail:    webResult.inviteEmail || null,
            inviteError:    webResult.inviteError || null,
            importedCounts: {
              tags:      webResult.importedTagCount,
              triggers:  webResult.importedTriggerCount,
              variables: webResult.importedVariableCount,
            },
            mode,
            serverContainerPublicId: serverResult ? serverResult.publicId : null,
          });

          // 4. client_server flow — auto-deploy to Stape + auto-wire transport_url.
          //    The Stape API key is a PLATFORM credential (set via STAPE_API_KEY env
          //    var) — clients never see or enter it. If the env var is missing or
          //    the deploy fails, we fall back to "manual mode": save the
          //    containerConfig blob in Firestore so the frontend can show it and
          //    /api/ss/wire-transport remains available for manual recovery.
          let stapeDeployed   = null;
          let stapeDeployErr  = null;
          let webRepublished  = false;

          if (mode === 'client_server' && serverResult) {
            const platformStapeKey = (process.env.STAPE_API_KEY || '').trim();
            const stapeRegion      = process.env.STAPE_REGION === 'eu' ? 'eu' : 'global';

            if (platformStapeKey && serverResult.containerConfig) {
              try {
                _setJob(jobId, { stage: 'stape_deploy' });
                const stape = new StapeProvider({ stapeRegion });
                const dep = await stape.deployContainer({
                  stapeApiKey:   platformStapeKey,
                  containerName: serverResult.containerName ||
                                 ('Easy Track sGTM — ' + (clientId || '').slice(0, 8)),
                  gtmConfigBody: serverResult.containerConfig,
                });
                stapeDeployed = {
                  serverUrl:   dep.serverUrl,
                  containerId: dep.containerId,
                  status:      dep.status,
                  region:      stapeRegion,
                };

                // Wire the web container's GA4 tag → the deployed sGTM URL.
                // setGA4TransportUrl creates a new web container version + publishes
                // it, so this single call covers both wiring and going-live.
                if (dep.serverUrl) {
                  _setJob(jobId, { stage: 'wiring_transport_url' });
                  try {
                    await gtmService.setGA4TransportUrl(
                      webResult.gtmContainerId,
                      webResult.gtmWorkspaceId,
                      dep.serverUrl,
                    );
                    webRepublished = true;
                    // Refresh local snippet flags so the success UI shows LIVE.
                    webResult.published   = true;
                    webResult.publishedAt = new Date().toISOString();
                  } catch (wireErr) {
                    console.warn('[managed/create] wire transport_url failed:', wireErr.message);
                    stapeDeployErr = 'Stape deployed but wiring failed: ' + wireErr.message;
                  }
                }
              } catch (depErr) {
                console.warn('[managed/create] Stape deploy failed:', depErr.message);
                stapeDeployErr = depErr.message;
              }
            } else if (!platformStapeKey) {
              stapeDeployErr = 'STAPE_API_KEY env var is not set on the server — manual deploy required';
            }

            // Persist the SS config regardless of deploy outcome.
            try {
              const existingSs = await firestoreService.getSSConfig(clientId).catch(() => null);
              await firestoreService.saveSSConfig(clientId, {
                provider:         'stape',
                serverUrl:        (stapeDeployed && stapeDeployed.serverUrl) || '',
                platforms:        (existingSs && existingSs.platforms)        || (platforms || []),
                encryptedTokens:  (existingSs && existingSs.encryptedTokens)  || {},
                stapeApiKey:      null,
                stapeContainerId: stapeDeployed ? stapeDeployed.containerId : null,
                mode:                 'client_server',
                webContainerId:       webResult.gtmContainerId,
                webPublicId:          webResult.gtmPublicId,
                webWorkspaceId:       webResult.gtmWorkspaceId,
                serverContainerId:    serverResult.containerId,
                serverPublicId:       serverResult.publicId,
                serverWorkspaceId:    serverResult.workspaceId,
                serverVersionId:      serverResult.versionId,
                // Keep the blob ONLY when auto-deploy didn't succeed — saves
                // Firestore space and prevents stale blobs after redeploys.
                containerConfig:      stapeDeployed ? null : (serverResult.containerConfig || null),
                transportUrlWired:    webRepublished,
                transportUrlWiredAt:  webRepublished ? new Date() : null,
                stapeAutoDeployed:    !!stapeDeployed,
                stapeDeployError:     stapeDeployErr || null,
              });
            } catch (saveErr) {
              console.warn('[managed/create] saveSSConfig failed (non-fatal):', saveErr.message);
            }
          }

          // Attach deploy info to serverResult before returning to the client
          if (serverResult && (stapeDeployed || stapeDeployErr)) {
            serverResult.deployedUrl       = stapeDeployed ? stapeDeployed.serverUrl   : null;
            serverResult.stapeContainerId  = stapeDeployed ? stapeDeployed.containerId : null;
            serverResult.stapeStatus       = stapeDeployed ? stapeDeployed.status      : null;
            serverResult.transportUrlWired = webRepublished;
            serverResult.deployError       = stapeDeployErr || null;
            // For manual-fallback path: keep the blob in the response only if
            // auto-deploy didn't happen, so the frontend can still render it.
            if (stapeDeployed) delete serverResult.containerConfig;
          }

          _setJob(jobId, {
            status:     'completed',
            stage:      'done',
            result:     {
              ok: true,
              mode,
              ...webResult,
              server: serverResult,                  // null when mode=client
            },
            finishedAt: Date.now(),
          });
          _scheduleJobCleanup(jobId);
        } catch (e) {
          console.error('[managed/create][job ' + jobId + ']', e);
          _setJob(jobId, {
            status:     'failed',
            stage:      'error',
            error:      e.message,
            details:    e.details || null,
            code:       e.code    || null,
            httpStatus: (e.status && e.status >= 400 && e.status < 600) ? e.status : 502,
            finishedAt: Date.now(),
          });
          _scheduleJobCleanup(jobId);
        }
      })();

      // Return jobId immediately (202 Accepted)
      sendJSON(res, 202, { ok: true, jobId, status: 'pending' });
    });
    return;
  }

  // GET /api/managed/job/:jobId — poll status of a provisioning job
  if (req.method === 'GET' && req.url.startsWith('/api/managed/job/')) {
    const jobId = req.url.substring('/api/managed/job/'.length).split('?')[0];
    if (!jobId) return sendJSON(res, 400, { error: 'Missing jobId' });
    const job = managedJobs.get(jobId);
    if (!job) return sendJSON(res, 404, { error: 'Job not found or expired' });
    sendJSON(res, 200, { ok: true, jobId, ...job });
    return;
  }

  // GET /api/managed/container/:gtmPublicId
  if (req.method === 'GET' && req.url.startsWith('/api/managed/container/')) {
    const gtmPublicId = req.url.substring('/api/managed/container/'.length).split('?')[0];
    if (!gtmPublicId) return sendJSON(res, 400, { error: 'Missing GTM public ID' });
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    firestoreService.getContainer(gtmPublicId)
      .then(doc => {
        if (!doc) return sendJSON(res, 404, { error: 'Container not found' });
        sendJSON(res, 200, doc);
      })
      .catch(e => sendJSON(res, 500, { error: e.message }));
    return;
  }

  // GET /api/managed/client/:clientId — list all containers for a client
  if (req.method === 'GET' && req.url.startsWith('/api/managed/client/')) {
    const clientId = req.url.substring('/api/managed/client/'.length).split('?')[0];
    if (!clientId) return sendJSON(res, 400, { error: 'Missing client ID' });
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    firestoreService.listContainersByClient(clientId)
      .then(list => sendJSON(res, 200, { containers: list, count: list.length }))
      .catch(e => sendJSON(res, 500, { error: e.message }));
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN ENDPOINTS
  // Protected by a bearer token: set ADMIN_TOKEN env var on the server, then
  // call with header: Authorization: Bearer <ADMIN_TOKEN>
  // ══════════════════════════════════════════════════════════════════════════
  function _requireAdmin() {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected) {
      sendJSON(res, 503, { error: 'ADMIN_TOKEN is not configured on the server' });
      return false;
    }
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    // Constant-time comparison to prevent timing attacks
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && require('crypto').timingSafeEqual(a, b);
    if (!ok) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  // GET /api/admin/export — dump all clients + containers as JSON
  // Optional ?download=1 sets Content-Disposition so the browser saves a file
  if (req.method === 'GET' && req.url.startsWith('/api/admin/export')) {
    if (!_requireAdmin()) return;
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    const wantDownload = /[?&]download=1\b/.test(req.url);
    firestoreService.exportAll()
      .then(dump => {
        const json = JSON.stringify(dump, null, 2);
        const headers = {
          ...securityHeaders(),
          'Content-Type':   'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(json),
        };
        if (wantDownload) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          headers['Content-Disposition'] = `attachment; filename="easytrack-export-${stamp}.json"`;
        }
        res.writeHead(200, headers);
        res.end(json);
      })
      .catch(e => sendJSON(res, 500, { error: e.message }));
    return;
  }

  // GET /api/admin/ping — quick token validity check (used by admin login)
  if (req.method === 'GET' && req.url.startsWith('/api/admin/ping')) {
    if (!_requireAdmin()) return;
    return sendJSON(res, 200, { ok: true, firestore: firestoreService.isConfigured() });
  }

  // POST /api/admin/client/:uid — update client fields (status, plan, ...)
  const _cliUpdMatch = req.url.split('?')[0].match(/^\/api\/admin\/client\/([^/]+)$/);
  if (req.method === 'POST' && _cliUpdMatch) {
    if (!_requireAdmin()) return;
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    const uid = decodeURIComponent(_cliUpdMatch[1]);
    parseJsonBody(req, res, body => {
      firestoreService.updateClient(uid, body || {})
        .then(upd => sendJSON(res, 200, { ok: true, update: upd }))
        .catch(e => sendJSON(res, 500, { error: e.message }));
    });
    return;
  }

  // DELETE /api/admin/client/:uid — delete a client document
  if (req.method === 'DELETE' && _cliUpdMatch) {
    if (!_requireAdmin()) return;
    if (!firestoreService.isConfigured()) {
      return sendJSON(res, 503, { error: 'Firestore is not configured' });
    }
    const uid = decodeURIComponent(_cliUpdMatch[1]);
    firestoreService.deleteClient(uid)
      .then(() => sendJSON(res, 200, { ok: true }))
      .catch(e => sendJSON(res, 500, { error: e.message }));
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SERVER-SIDE TRACKING ENDPOINTS  /api/ss/*
  //
  // Authenticated via Firebase ID token (Authorization: Bearer <ID_TOKEN>).
  // The token is verified server-side via firebase-admin.auth().verifyIdToken();
  // we use decoded.uid as the canonical clientId — the X-Client-Id header is
  // accepted only when present and must equal decoded.uid (defense-in-depth
  // against header-confusion bugs in upstream layers). Tokens are AES-256-GCM
  // encrypted at rest. See ssAuthAndRate() below.
  // ══════════════════════════════════════════════════════════════════════════

  if (req.url.startsWith('/api/ss/')) {

    // ── Shared SS helpers ──────────────────────────────────────────────────

    // Verify Firebase ID token + apply rate-limit. Returns { clientId, email,
    // decoded } on success, or null after writing the appropriate error
    // response (401/403/429/503). All callers MUST `if (!auth) return;`.
    async function ssAuthAndRate() {
      // Auth setup must be ready — same env var as Firestore.
      if (!firestoreService.isConfigured()) {
        sendJSON(res, 503, { error: 'Firebase Auth غير مُهيَّأ على هذا الخادم', hint: 'اضبط FIREBASE_SA_KEY_JSON في ملف .env' });
        return null;
      }

      const authz = (req.headers['authorization'] || req.headers['Authorization'] || '').trim();
      if (!authz) {
        sendJSON(res, 401, { error: 'Authorization header مطلوب', hint: 'أرسل Authorization: Bearer <Firebase ID token>' });
        return null;
      }
      const m = /^Bearer\s+(.+)$/i.exec(authz);
      if (!m) {
        sendJSON(res, 401, { error: 'Authorization header غير صحيح — استخدم Bearer scheme' });
        return null;
      }
      const idToken = m[1].trim();
      // Firebase ID tokens are JWTs (~1.0–2.5 KB). 8 KB is a generous upper
      // bound — anything larger is almost certainly garbage and we reject
      // before paying the verifyIdToken round-trip.
      if (!idToken || idToken.length > 8192) {
        sendJSON(res, 401, { error: 'الـ token فارغ أو طويل جداً' });
        return null;
      }

      let decoded;
      try {
        decoded = await firestoreService.verifyIdToken(idToken);
      } catch (e) {
        // Don't leak token internals to clients. Log server-side, surface
        // a generic 401 with the firebase error code (auth/id-token-expired etc.)
        // so the frontend can refresh and retry on its own.
        const code = (e && e.code) || 'auth/invalid-id-token';
        sendJSON(res, 401, { error: 'Firebase ID token غير صالح', code: String(code) });
        return null;
      }
      if (!decoded || !decoded.uid) {
        sendJSON(res, 401, { error: 'Firebase token بدون uid' });
        return null;
      }

      // If the client also sent X-Client-Id (legacy / debugging), it MUST
      // match the verified uid. Mismatches are a sign of a broken caller or
      // an attempted impersonation — fail closed with 403.
      const claimed = (req.headers['x-client-id'] || '').trim().slice(0, 128);
      if (claimed && claimed !== decoded.uid) {
        sendJSON(res, 403, { error: 'X-Client-Id لا يطابق الـ Firebase UID' });
        return null;
      }

      const clientId = decoded.uid;
      const rl = rateLimiter.check(clientId);
      if (!rl.allowed) {
        const msg = rl.locked ? 'حسابك محظور مؤقتاً بسبب أخطاء متكررة' : 'تجاوزت الحد المسموح (100 طلب/دقيقة)';
        res.writeHead(429, { ...corsHeaders(), ...securityHeaders(), 'Retry-After': Math.ceil((rl.resetAt - Date.now()) / 1000) });
        res.end(JSON.stringify({ error: msg, resetAt: rl.resetAt }));
        return null;
      }

      return { clientId, email: decoded.email || null, decoded };
    }

    function ssRequireFirestore() {
      if (!firestoreService.isConfigured()) {
        sendJSON(res, 503, { error: 'Firestore غير مُهيَّأ على هذا الخادم', hint: 'اضبط FIREBASE_SA_KEY_JSON في ملف .env' });
        return false;
      }
      return true;
    }

    function ssRequireCrypto() {
      try { cryptoVault.getMasterKey(); return true; }
      catch (e) {
        sendJSON(res, 503, { error: 'MASTER_ENCRYPTION_KEY غير مُهيَّأ', hint: 'شغّل: node -e "require(\'crypto\').randomBytes(32).toString(\'hex\')" ثم أضف النتيجة في .env' });
        return false;
      }
    }

    // Categorise provider errors so the response code matches the cause:
    //   missing dep / invalid URL / programmer error → 500  (server-side bug)
    //   SSRF guard hit / private IP                  → 400  (caller mistake)
    //   actual upstream failure (timeout, DNS, etc.) → 502  (bad gateway)
    // Returns { status, payload } for the caller to pass to sendJSON.
    function ssClassifyError(e, fallbackArMsg) {
      const msg = (e && e.message) || String(e);
      if (/axios is not installed|firebase-admin is not installed/i.test(msg)) {
        return { status: 500, payload: { error: 'مكتبة مفقودة على الخادم', detail: msg, hint: 'شغّل npm install على الخادم ثم أعد التشغيل' } };
      }
      if (/Private\/internal IP|Hostname is blocked|Port .* is not allowed|Only http\/https/i.test(msg)) {
        return { status: 400, payload: { error: 'الرابط مرفوض (SSRF guard)', detail: msg } };
      }
      return { status: 502, payload: { error: fallbackArMsg + ': ' + msg } };
    }

    // Body parser dedicated to /api/ss/* — small cap (64 KB), surfaces 413 properly.
    // Delegates to the top-level parseJsonBody helper (which handles 413/400 + empty).
    function ssParseBody(cb) {
      parseJsonBody(req, res, cb, SS_BODY_LIMIT);
    }

    function ssGetProvider(config) {
      const provider = (config && config.provider) || 'selfhosted';
      switch (provider) {
        case 'stape':    return new StapeProvider(config);
        case 'gcloud':   return new GoogleCloudProvider(config);
        default:         return new SelfHostedProvider(config);
      }
    }

    const ssPath = req.url.split('?')[0];

    // ────────────────────────────────────────────────────────────────────────
    // GET /api/ss/config — return user's SS config (tokens redacted)
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && ssPath === '/api/ss/config') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        if (!ssRequireFirestore()) return;
        try {
          // getSSConfigPublic redacts encryptedTokens + stapeApiKey internally —
          // never leaks ciphertext, even if a future caller forgets to redact.
          const cfg = await firestoreService.getSSConfigPublic(clientId);
          if (!cfg) { sendJSON(res, 404, { error: 'لا يوجد إعداد Server-Side لهذا الحساب' }); return; }
          sendJSON(res, 200, { ok: true, config: cfg });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/validate-url — ping sGTM URL, return latency + status
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/validate-url') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        ssParseBody(async body => {
          const url = (body.url || '').trim();
          if (!url) return sendJSON(res, 400, { error: 'حقل url مطلوب' });
          if (!/^https?:\/\/.+\..+/.test(url)) return sendJSON(res, 400, { error: 'الرابط غير صالح — يجب أن يبدأ بـ https://' });

          try {
            const provider = ssGetProvider({ provider: body.provider || 'selfhosted' });
            const result   = await provider.validateUrl(url);
            if (!result.valid) rateLimiter.recordError(clientId);
            else               rateLimiter.recordSuccess(clientId);
            sendJSON(res, 200, { ok: result.valid, ...result });
          } catch (e) {
            rateLimiter.recordError(clientId);
            const c = ssClassifyError(e, 'فشل الاتصال بالخادم'); sendJSON(res, c.status, c.payload);
          }
        });
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/save-config — encrypt tokens + save to Firestore
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/save-config') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        if (!ssRequireFirestore()) return;
        if (!ssRequireCrypto()) return;

        ssParseBody(async body => {
          const {
            provider, serverUrl, platforms, tokens, stapeApiKey,
            pixelIds, ecommPlatform, metaTec,
            ga4MeasurementId, ga4Events, googleAdsEvents, ssEvents,
          } = body;
          if (!provider) return sendJSON(res, 400, { error: 'حقل provider مطلوب' });
          if (!serverUrl && provider !== 'gcloud') return sendJSON(res, 400, { error: 'حقل serverUrl مطلوب' });

          try {
            // Encrypt each token
            // AAD = clientId + ':' + platform — binds each token's ciphertext to
            // its slot. Re-using a ciphertext under a different (clientId, platform)
            // pair will fail decryption.
            const encryptedTokens = {};
            const VALID_PLATFORMS = ['meta', 'tiktok', 'snapchat', 'ga4', 'mixpanel'];
            VALID_PLATFORMS.forEach(function (p) {
              const t = tokens && tokens[p];
              // '***CONFIGURED***' = unchanged (already stored) — skip re-encryption
              if (t && t !== '***CONFIGURED***') {
                encryptedTokens[p] = cryptoVault.encryptToken(t, clientId + ':' + p);
              }
            });

            // Merge with existing config (preserve tokens not updated)
            let existing = null;
            try { existing = await firestoreService.getSSConfig(clientId); } catch (_) {}

            const mergedTokens = Object.assign(
              {},
              (existing && existing.encryptedTokens) || {},
              encryptedTokens
            );

            const mergedStapeKey = (stapeApiKey && stapeApiKey !== '***CONFIGURED***')
              ? cryptoVault.encryptToken(stapeApiKey, clientId + ':stape')
              : (existing && existing.stapeApiKey) || null;

            // Merge pixel IDs (only overwrite non-null values so partial updates work)
            const mergedPixelIds = Object.assign(
              {},
              (existing && existing.pixelIds) || {},
              pixelIds && typeof pixelIds === 'object' ? pixelIds : {}
            );

            await firestoreService.saveSSConfig(clientId, {
              provider,
              serverUrl:          serverUrl   || '',
              platforms:          Array.isArray(platforms) ? platforms : [],
              encryptedTokens:    mergedTokens,
              stapeApiKey:        mergedStapeKey,
              stapeContainerId:   body.stapeContainerId || (existing && existing.stapeContainerId) || null,
              // Extended SS wizard fields — persisted for ss_loadConfig() restoration
              pixelIds:           mergedPixelIds,
              ecommPlatform:      ecommPlatform      || (existing && existing.ecommPlatform)      || '',
              metaTec:            metaTec            || (existing && existing.metaTec)            || '',
              ga4MeasurementId:   ga4MeasurementId   || (existing && existing.ga4MeasurementId)   || '',
              ga4Events:          Array.isArray(ga4Events)        ? ga4Events        : ((existing && existing.ga4Events)        || []),
              googleAdsEvents:    Array.isArray(googleAdsEvents)  ? googleAdsEvents  : ((existing && existing.googleAdsEvents)  || []),
              ssEvents:           Array.isArray(ssEvents)         ? ssEvents         : ((existing && existing.ssEvents)         || []),
            });

            sendJSON(res, 200, { ok: true, message: 'تم حفظ الإعدادات بنجاح' });
          } catch (e) {
            sendJSON(res, 500, { error: 'فشل الحفظ: ' + e.message });
          }
        });
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/test-event — send test event to sGTM, return trace
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/test-event') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        ssParseBody(async body => {
          const url = (body.serverUrl || '').trim();
          if (!url) return sendJSON(res, 400, { error: 'حقل serverUrl مطلوب' });
          if (!/^https?:\/\/.+\..+/.test(url)) return sendJSON(res, 400, { error: 'الرابط غير صالح' });

          const ts = Date.now();
          const testPayload = {
            v:          '2',
            tid:        body.measurementId || 'G-TEST000001',
            en:         'purchase',
            _et:        String(ts),
            ep_event_id: 'test_' + ts.toString(36).toUpperCase(),
            ep_currency: 'SAR',
            epn_value:   '100',
            ep_transaction_id: 'TEST_' + ts.toString(36).toUpperCase(),
            // user data
            uid:  'test_user_et',
            up_external_id: 'test_user_et',
          };

          try {
            const provider = ssGetProvider({ provider: body.provider || 'selfhosted' });
            const result   = await provider.sendTestEvent(url, testPayload);
            if (!result.ok) rateLimiter.recordError(clientId);
            else            rateLimiter.recordSuccess(clientId);
            sendJSON(res, 200, {
              ok:        result.ok,
              status:    result.status,
              latencyMs: result.latencyMs,
              body:      result.body   || null,
              error:     result.error  || null,
              eventId:   testPayload.ep_event_id,
            });
          } catch (e) {
            rateLimiter.recordError(clientId);
            const c = ssClassifyError(e, 'فشل إرسال الحدث'); sendJSON(res, c.status, c.payload);
          }
        });
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/deploy-stape
    // Deploys the GTM server containerConfig to Stape.io via their API.
    //
    // Body: {
    //   stapeApiKey:     string   — Stape API key (from user, never stored without consent)
    //   containerConfig: string   — GTM container config JSON blob from create-containers job
    //   containerName?:  string   — display name for the Stape container
    //   region?:         string   — 'us-central' (default) | 'eu-west' | 'me-central1'
    //   saveKey?:        boolean  — encrypt + persist stapeApiKey in user's SS config
    // }
    //
    // Returns: { ok, serverUrl, containerId, status }
    // On success also patches ss_config with stapeContainerId + serverUrl so
    // /api/ss/wire-transport can be called immediately after.
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/deploy-stape') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId, email } = auth;
        if (!ssRequireFirestore()) return;

        ssParseBody(async body => {
          const stapeApiKey     = (body.stapeApiKey || '').trim();
          const containerConfig = (body.containerConfig || '').trim();
          const containerName   = (body.containerName  || ((email || clientId.slice(0, 8)) + ' — sGTM')).trim();
          const region          = (body.region || 'us-central').trim();
          const saveKey         = !!body.saveKey;

          if (!stapeApiKey)     return sendJSON(res, 400, { error: 'حقل stapeApiKey مطلوب' });
          if (!containerConfig) return sendJSON(res, 400, { error: 'حقل containerConfig مطلوب — أنشئ الـ containers أولاً (الخطوة 5)' });

          // Validate that the API key looks plausible before hitting Stape
          // (Stape keys are typically > 20 chars; reject obvious garbage early)
          if (stapeApiKey.length < 10) {
            return sendJSON(res, 400, { error: 'stapeApiKey يبدو قصيراً جداً — تأكد من نسخ المفتاح كاملاً من Stape' });
          }

          try {
            const provider = new StapeProvider({ stapeApiKey });
            const result   = await provider.deployContainer({
              stapeApiKey,
              gtmConfigBody: containerConfig,
              containerName,
              region,
            });

            // result = { serverUrl, containerId, status }
            if (!result.serverUrl && result.status === 'provisioning') {
              // Stape sometimes returns the container before the URL is ready.
              // Return what we have — frontend will poll /api/ss/validate-url.
              sendJSON(res, 202, {
                ok:          true,
                provisioning: true,
                containerId: result.containerId,
                status:      result.status,
                message:     'الـ Container بدأ التجهيز على Stape — قد يستغرق 1-3 دقائق قبل أن يكون الـ URL جاهزاً',
              });
              return;
            }

            // Patch the user's SS config with stapeContainerId + serverUrl so the
            // wizard can auto-advance to Step 7 without the user typing the URL.
            try {
              const existing = await firestoreService.getSSConfig(clientId).catch(() => null);
              const patch = {
                ...(existing || {}),
                stapeContainerId:  result.containerId || null,
                serverUrl:         result.serverUrl   || '',
                stapeAutoDeployed: true,
              };
              // Optionally persist the encrypted API key for future use
              if (saveKey && ssRequireCrypto()) {
                patch.stapeApiKey = cryptoVault.encryptToken(stapeApiKey, clientId + ':stape');
              }
              await firestoreService.saveSSConfig(clientId, patch);
            } catch (saveErr) {
              // Non-fatal — log and continue; the deploy itself succeeded.
              console.warn('[ss/deploy-stape] saveSSConfig patch failed (non-fatal):', saveErr.message);
            }

            rateLimiter.recordSuccess(clientId);
            sendJSON(res, 200, {
              ok:          true,
              serverUrl:   result.serverUrl,
              containerId: result.containerId,
              status:      result.status,
              message:     'تم النشر على Stape بنجاح — الـ URL جاهز للربط',
            });
          } catch (e) {
            rateLimiter.recordError(clientId);
            // Surface Stape auth errors clearly so the user can fix their API key
            const msg = e.message || '';
            if (e.status === 401 || e.status === 403 || /auth/i.test(msg)) {
              return sendJSON(res, 401, { error: 'Stape API key غير صالح أو منتهي — تحقق من المفتاح في إعدادات حسابك على stape.io', detail: msg });
            }
            const c = ssClassifyError(e, 'فشل النشر على Stape');
            sendJSON(res, c.status, c.payload);
          }
        });
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // GET /api/ss/gcp-instructions — return guided GCP deployment steps
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && ssPath === '/api/ss/gcp-instructions') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const configBody = (req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]).get('configBody') : null) || '';
        const region     = (req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]).get('region') : null) || 'me-central1';

        try {
          const provider = new GoogleCloudProvider();
          const result   = await provider.deployContainer({ configBody, region });
          sendJSON(res, 200, { ok: true, ...result });
        } catch (e) {
          sendJSON(res, 500, { error: e.message });
        }
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/gcp-confirm-url — validate Cloud Run URL after manual deploy
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/gcp-confirm-url') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        ssParseBody(async body => {
          const url = (body.url || '').trim();
          if (!url) return sendJSON(res, 400, { error: 'حقل url مطلوب' });

          try {
            const provider = new GoogleCloudProvider();
            const result   = await provider.validateUrl(url);
            if (!result.valid) rateLimiter.recordError(clientId);
            else               rateLimiter.recordSuccess(clientId);
            sendJSON(res, 200, {
              ok:      result.valid,
              message: result.valid
                ? 'تم التحقق — الخادم يستجيب بنجاح (' + result.latencyMs + 'ms)'
                : 'الخادم لا يستجيب — تأكد من اكتمال الـ deploy على Cloud Run',
              ...result,
            });
          } catch (e) {
            rateLimiter.recordError(clientId);
            const c = ssClassifyError(e, 'فشل التحقق'); sendJSON(res, c.status, c.payload);
          }
        });
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/populate-containers
    // Builds complete Variable + Trigger + Tag configs from the user's wizard
    // selections and imports them into the already-created web + server GTM
    // containers. Called from ss_confirmSetup() after all 6 input steps are done.
    //
    // Body: { ga4MeasurementId, sgtmUrl, pixelIds, events,
    //         ecommPlatform, platforms }
    //
    // Why a separate endpoint instead of doing this at create-containers time?
    // The containers are created at Step 1 (before GA4 ID / pixels / events are
    // entered). By Step 8 we have everything, so we populate here.
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/populate-containers') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        if (!ssRequireFirestore()) return;

        if (!gtmService.isConfigured()) {
          return sendJSON(res, 503, {
            error: 'GTM غير مُهيَّأ على هذا الخادم',
            hint:  'اضبط GTM_SA_KEY_JSON و GTM_ACCOUNT_ID في .env',
          });
        }

        ssParseBody(async body => {
          try {
            const {
              ga4MeasurementId, sgtmUrl,
              pixelIds, events, ecommPlatform, platforms,
            } = body;

            // Load the user's existing container IDs from Firestore
            const ssConfig = await firestoreService.getSSConfig(clientId).catch(() => null);
            if (!ssConfig || !ssConfig.webContainerId) {
              return sendJSON(res, 400, {
                error: 'لم يتم إنشاء الـ Containers بعد — اتبع الخطوة 1 أولاً',
              });
            }

            const webContainerId   = ssConfig.webContainerId;
            const webWorkspaceId   = ssConfig.webWorkspaceId;
            const serverContainerId = ssConfig.serverContainerId || null;
            const serverWorkspaceId = ssConfig.serverWorkspaceId || null;

            // Fall back to stored values if caller didn't supply them
            const ga4Id       = (ga4MeasurementId || ssConfig.ga4MeasurementId || '').trim();
            const sgtm        = (sgtmUrl          || ssConfig.serverUrl         || '').trim();
            const pxIds       = pixelIds           || {};
            const evList      = Array.isArray(events)    ? events    : (ssConfig.ssEvents   || []);
            const ecomm       = ecommPlatform      || ssConfig.ecommPlatform   || '';
            const platList    = Array.isArray(platforms) ? platforms : (ssConfig.platforms  || []);

            const { buildWebConfig, buildServerConfig } = require('./lib/gtm-config-builder');

            // ── Web container ─────────────────────────────────────────────
            const webConfig = buildWebConfig({
              ga4MeasurementId: ga4Id,
              sgtmUrl:          sgtm,
              pixelIds:         pxIds,
              events:           evList,
              ecommPlatform:    ecomm,
            });

            const webImport = await gtmService.importContainerJSON(
              webContainerId, webWorkspaceId, webConfig, null, null,
            );
            console.log('[ss/populate-containers] web import:', webImport);

            // Create version + publish web container
            const webVer = await gtmService.createVersion(
              webContainerId, webWorkspaceId,
              'EasyTrac full config — ' + new Date().toISOString().split('T')[0],
            );
            const webVersionId = webVer.containerVersion && webVer.containerVersion.containerVersionId;
            if (webVersionId) {
              await gtmService.publishVersion(webContainerId, webVersionId).catch(e => {
                console.warn('[ss/populate-containers] web publish non-fatal:', e.message);
              });
            }

            // ── Server container (optional) ───────────────────────────────
            let serverImport = null;
            if (serverContainerId && serverWorkspaceId) {
              const serverConfig = buildServerConfig({
                ga4MeasurementId: ga4Id,
                sgtmUrl:          sgtm,
                platforms:        platList,
                events:           evList,
              });

              serverImport = await gtmService.importContainerJSON(
                serverContainerId, serverWorkspaceId, serverConfig, null, null,
              );
              console.log('[ss/populate-containers] server import:', serverImport);

              const serverVer = await gtmService.createVersion(
                serverContainerId, serverWorkspaceId,
                'EasyTrac full config — ' + new Date().toISOString().split('T')[0],
              );
              const serverVersionId = serverVer.containerVersion && serverVer.containerVersion.containerVersionId;
              if (serverVersionId) {
                await gtmService.publishVersion(serverContainerId, serverVersionId).catch(e => {
                  console.warn('[ss/populate-containers] server publish non-fatal:', e.message);
                });
              }
            }

            sendJSON(res, 200, {
              ok:     true,
              web:    webImport    || {},
              server: serverImport || {},
            });
          } catch (e) {
            console.error('[ss/populate-containers]', e);
            sendJSON(res, e.status || 500, { error: e.message });
          }
        });
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/wire-transport — patch web container's GA4 tag with sGTM URL
    // Body: { sgtmUrl }   (web container ids come from the user's ss_configs)
    // After the user pastes back the deployed sGTM URL, this route writes
    // transport_url onto the GA4 Configuration tag, creates a new container
    // version, and publishes it. Marks transportUrlWired=true in Firestore.
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/wire-transport') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        if (!ssRequireFirestore()) return;

        ssParseBody(async body => {
          const sgtmUrl = (body.sgtmUrl || '').trim();
          if (!sgtmUrl)              return sendJSON(res, 400, { error: 'حقل sgtmUrl مطلوب' });
          if (!/^https:\/\//.test(sgtmUrl)) return sendJSON(res, 400, { error: 'يجب أن يبدأ sgtmUrl بـ https://' });

          try {
            const cfg = await firestoreService.getSSConfig(clientId);
            if (!cfg)                       return sendJSON(res, 404, { error: 'لا يوجد إعداد Server-Side لهذا الحساب' });
            if (cfg.mode !== 'client_server') return sendJSON(res, 400, { error: 'الـ mode الحالي ليس client_server — لا يوجد web container للربط' });
            if (!cfg.webContainerId || !cfg.webWorkspaceId) {
              return sendJSON(res, 400, { error: 'بيانات الـ web container ناقصة في الإعداد' });
            }

            const result = await gtmService.setGA4TransportUrl(
              cfg.webContainerId, cfg.webWorkspaceId, sgtmUrl,
            );

            // Also add/update ET - sGTM URL constant variable in the server container
            // so sGTM tags can reference the server URL without hardcoding it.
            let serverVarResult = null;
            if (cfg.serverContainerId && cfg.serverWorkspaceId) {
              try {
                serverVarResult = await gtmService.upsertServerUrlVariable(
                  cfg.serverContainerId, cfg.serverWorkspaceId, sgtmUrl,
                );
              } catch (varErr) {
                console.warn('[ss/wire-transport] upsertServerUrlVariable non-fatal:', varErr.message);
              }
            }

            await firestoreService.saveSSConfig(clientId, {
              ...cfg,
              serverUrl:           sgtmUrl,
              transportUrlWired:   true,
              transportUrlWiredAt: new Date(),
            });

            rateLimiter.recordSuccess(clientId);
            sendJSON(res, 200, {
              ok: true,
              tagId:        result.tagId,
              versionId:    result.versionId,
              transportUrl: result.transportUrl,
              serverVarId:  serverVarResult ? serverVarResult.variableId : null,
              message:      'تم ربط الـ web container بـ sGTM ونشره بنجاح',
            });
          } catch (e) {
            rateLimiter.recordError(clientId);
            const c = ssClassifyError(e, 'فشل ربط الـ transport URL');
            sendJSON(res, c.status, c.payload);
          }
        });
      })();
      return;
    }

    // DELETE /api/ss/config — wipe user's SS config from Firestore
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'DELETE' && ssPath === '/api/ss/config') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        if (!ssRequireFirestore()) return;
        try {
          await firestoreService.deleteSSConfig(clientId);
          sendJSON(res, 200, { ok: true, message: 'تم حذف إعدادات Server-Side Tracking' });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // GET /api/ss/health — check sGTM container uptime
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && ssPath === '/api/ss/health') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const url = (req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]).get('url') : null) || '';
        if (!url) { sendJSON(res, 400, { error: 'query param url مطلوب' }); return; }

        try {
          const provider = ssGetProvider({ provider: 'selfhosted' });
          const result   = await provider.getContainerStatus(url);
          sendJSON(res, 200, { ok: true, ...result });
        } catch (e) {
          sendJSON(res, 502, { error: e.message });
        }
      })();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // POST /api/ss/create-containers
    // Authenticated via Firebase token.
    // Body: { configJson, projectName?, ga4MeasurementId?, ga4Events?,
    //         googleAdsEvents?, ssEvents?, ssPlatforms? }
    // Spawns a GTM provisioning job (mode=client_server) and returns jobId
    // immediately. Poll GET /api/managed/job/:jobId for progress.
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'POST' && ssPath === '/api/ss/create-containers') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId, email } = auth;
        if (!ssRequireFirestore()) return;

        if (!gtmService.isConfigured()) {
          return sendJSON(res, 503, {
            error: 'GTM غير مُهيَّأ على هذا الخادم',
            hint:  'اضبط GTM_SA_KEY_JSON و GTM_ACCOUNT_ID في .env',
          });
        }

        ssParseBody(async body => {
          const {
            configJson, projectName,
            ga4MeasurementId, ga4Events, googleAdsEvents,
            ssEvents, ssPlatforms,
            pixelIds, ecommPlatform,
          } = body;

          const activeCount = await firestoreService.countActiveContainers().catch(() => 0);
          if (activeCount >= 490) {
            return sendJSON(res, 507, { error: 'حساب GTM وصل للحد الأقصى (490 container)' });
          }

          const jobId = _newJobId();
          _setJob(jobId, { status: 'pending', stage: 'queued', clientId, startedAt: Date.now() });

          // Fire-and-forget provisioning
          (async () => {
            try {
              _setJob(jobId, { status: 'running', stage: 'gtm_provisioning', mode: 'client_server' });

              // Build full web + server configs from wizard data now (at creation time),
              // so containers are populated with the user's actual GA4 ID, pixels, events.
              // sgtmUrl is empty string at this stage — it gets wired later via /api/ss/wire-transport.
              const { buildWebConfig, buildServerConfig } = require('./lib/gtm-config-builder');

              const webConfig = configJson || buildWebConfig({
                ga4MeasurementId: ga4MeasurementId || '',
                sgtmUrl:          '',
                pixelIds:         (pixelIds && typeof pixelIds === 'object') ? pixelIds : {},
                events:           ssEvents       || [],
                ecommPlatform:    ecommPlatform  || '',
              });

              const serverConfig = buildServerConfig({
                ga4MeasurementId: ga4MeasurementId || '',
                sgtmUrl:          '',
                platforms:        ssPlatforms || [],
                events:           ssEvents    || [],
              });

              const both = await gtmService.provisionForClientWithServer({
                projectName:      projectName || ((email || clientId.slice(0, 8)) + ' — SS Setup'),
                configJson:       webConfig,
                serverConfigJson: serverConfig,
                publishLive:      false,
                inviteEmail:      email || null,
                onProgress:       (p) => _setJob(jobId, { stage: 'gtm_provisioning', progress: p }),
              });

              const { web, server } = both;
              _setJob(jobId, { stage: 'saving' });

              // Persist web container record
              await firestoreService.saveContainer({
                clientId,
                clientEmail:    email || null,
                projectName:    projectName || null,
                platforms:      ssPlatforms || [],
                events:         ssEvents    || [],
                gtmAccountId:   web.gtmAccountId,
                gtmContainerId: web.gtmContainerId,
                gtmPublicId:    web.gtmPublicId,
                gtmWorkspaceId: web.gtmWorkspaceId,
                gtmVersionId:   web.gtmVersionId,
                published:      false,
                snippetHead:    web.snippetHead,
                snippetBody:    web.snippetBody,
                mode:           'client_server',
                serverContainerPublicId: server ? server.publicId : null,
              });

              // Persist SS config with step-1 results (no URL yet)
              try {
                const existing = await firestoreService.getSSConfig(clientId).catch(() => null);
                await firestoreService.saveSSConfig(clientId, {
                  provider:           'pending',
                  serverUrl:          '',
                  platforms:          ssPlatforms   || [],
                  encryptedTokens:    (existing && existing.encryptedTokens) || {},
                  stapeApiKey:        null,
                  stapeContainerId:   null,
                  mode:               'client_server',
                  webContainerId:     web.gtmContainerId,
                  webPublicId:        web.gtmPublicId,
                  webWorkspaceId:     web.gtmWorkspaceId,
                  serverContainerId:  server ? server.containerId  : null,
                  serverPublicId:     server ? server.publicId     : null,
                  serverWorkspaceId:  server ? server.workspaceId  : null,
                  serverVersionId:    server ? server.versionId    : null,
                  containerConfig:    server ? (server.containerConfig || null) : null,
                  transportUrlWired:  false,
                  ga4MeasurementId:   ga4MeasurementId || null,
                  ga4Events:          ga4Events        || [],
                  googleAdsEvents:    googleAdsEvents  || [],
                  ssEvents:           ssEvents         || [],
                  pixelIds:           (pixelIds && typeof pixelIds === 'object') ? pixelIds : {},
                  ecommPlatform:      ecommPlatform    || '',
                });
              } catch (saveErr) {
                console.warn('[ss/create-containers] saveSSConfig failed (non-fatal):', saveErr.message);
              }

              _setJob(jobId, {
                status:    'completed',
                stage:     'done',
                result:    { ok: true, mode: 'client_server', ...web, server },
                finishedAt: Date.now(),
              });
              _scheduleJobCleanup(jobId);
            } catch (e) {
              console.error('[ss/create-containers][job ' + jobId + ']', e);
              _setJob(jobId, {
                status:    'failed',
                stage:     'error',
                error:     e.message,
                code:      e.code    || null,
                httpStatus: (e.status >= 400 && e.status < 600) ? e.status : 502,
                finishedAt: Date.now(),
              });
              _scheduleJobCleanup(jobId);
            }
          })();

          sendJSON(res, 202, { ok: true, jobId });
        });
      })();
      return;
    }

        // GET /api/ss/full-status
    // Returns combined container + SS config data for the Overview section.
    // Tokens are always redacted. Container snippets are included.
    // ────────────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && ssPath === '/api/ss/full-status') {
      (async () => {
        const auth = await ssAuthAndRate();
        if (!auth) return;
        const { clientId } = auth;
        if (!ssRequireFirestore()) return;
        try {
          const [ssCfg, containers] = await Promise.all([
            firestoreService.getSSConfigPublic(clientId).catch(() => null),
            firestoreService.listContainersByClient(clientId).catch(() => []),
          ]);

          // Prefer the client_server container; fallback to most-recent
          const sorted = (containers || []).sort((a, b) => {
            const ta = (a.updatedAt && a.updatedAt.toMillis) ? a.updatedAt.toMillis() : 0;
            const tb = (b.updatedAt && b.updatedAt.toMillis) ? b.updatedAt.toMillis() : 0;
            return tb - ta;
          });
          const csContainer = sorted.find(c => c.mode === 'client_server') || sorted[0] || null;

          sendJSON(res, 200, {
            ok: true,
            ss: ssCfg || null,
            container: csContainer ? {
              webGtmId:    csContainer.gtmPublicId              || null,
              serverGtmId: csContainer.serverContainerPublicId  || null,
              snippetHead: csContainer.snippetHead              || null,
              snippetBody: csContainer.snippetBody              || null,
              platforms:   csContainer.platforms                || [],
              events:      csContainer.events                   || [],
              published:   csContainer.published                || false,
              mode:        csContainer.mode                     || 'client',
            } : null,
          });
        } catch (e) { sendJSON(res, 500, { error: e.message }); }
      })();
      return;
    }

    // Unknown /api/ss/* path
    sendJSON(res, 404, { error: 'SS endpoint غير موجود: ' + ssPath });
    return;
  }

  // ── Static File Server ────────────────────────────────────────
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (_) {
    res.writeHead(400, securityHeaders()); res.end('Bad Request'); return;
  }

  // Default root → tool.html (the app's single-page entry)
  const requestedPath = urlPath === '/' ? '/tool.html' : urlPath;
  const filePath      = path.normalize(path.join(ROOT, requestedPath));

  // Path traversal guard — filePath MUST stay within ROOT
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, securityHeaders()); res.end('Forbidden'); return;
  }

  // Dotfile/dotdir guard (.env, .git/, .DS_Store, ...)
  if (filePath.split(path.sep).some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
    res.writeHead(403, securityHeaders()); res.end('Forbidden'); return;
  }

  function serveFile(fp, triedFallback) {
    fs.readFile(fp, (err, data) => {
      if (err) {
        // Extensionless URLs (e.g. /tool) → try <name>.html once
        if (!triedFallback && !path.extname(fp)) return serveFile(fp + '.html', true);
        res.writeHead(404, securityHeaders()); res.end('Not found');
        return;
      }
      const ext    = path.extname(fp).toLowerCase();

      // Extension allowlist — blocks server.js / package.json / Dockerfile / etc.
      if (!STATIC_ALLOW_EXT.has(ext)) {
        res.writeHead(403, securityHeaders()); res.end('Forbidden');
        return;
      }

      const isHtml = ext === '.html';
      res.writeHead(200, {
        'Content-Type': mime[ext] || 'text/plain',
        ...securityHeaders({ html: isHtml }),
      });
      res.end(data);
    });
  }
  serveFile(filePath);

}).listen(PORT, () => {
  const mode = puppeteer ? '🟢 Puppeteer (headless Chrome)' : '🟡 HTTP fallback (install puppeteer for full analysis)';
  console.log(`Easy Track server running at http://localhost:${PORT}`);
  console.log(`Scanner mode: ${mode}`);
});
