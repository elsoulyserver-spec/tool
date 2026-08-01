// tests/gcp-auth.test.js
// Unit tests for lib/gcp-auth.js
// Run: node --test tests/gcp-auth.test.js

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ── Real throwaway RSA keypair ────────────────────────────────────────────────
const { privateKey: _privKey, publicKey: _pubKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PRIVATE_KEY = _privKey.export({ type: 'pkcs1', format: 'pem' });
const TEST_PUBLIC_KEY  = _pubKey.export({ type: 'spki',  format: 'pem' });

const FAKE_SA = {
  client_email: 't@p.iam.gserviceaccount.com',
  private_key:  TEST_PRIVATE_KEY,
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ── fetch mock helpers ────────────────────────────────────────────────────────
let _origFetch;
let _fetchSpy;   // tracks calls: [ { url, options } ]
let _fetchImpl;  // current mock implementation

function _installMockFetch() {
  _origFetch = globalThis.fetch;
  _fetchSpy  = [];
  globalThis.fetch = async (url, options) => {
    _fetchSpy.push({ url, options });
    return _fetchImpl(url, options);
  };
}

function _restoreFetch() {
  globalThis.fetch = _origFetch;
}

function _okResponse(body) {
  return {
    ok:     true,
    status: 200,
    text:   async () => JSON.stringify(body),
  };
}

function _errResponse(status, body) {
  return {
    ok:     false,
    status,
    text:   async () => JSON.stringify(body),
  };
}

function _base64urlDecode(str) {
  // Pad and convert back to standard base64
  const padded = str + '==='.slice((str.length + 3) % 4);
  return JSON.parse(Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

// ── Shared setup ──────────────────────────────────────────────────────────────
before(() => { _installMockFetch(); });
after(() => { _restoreFetch(); });

// Fresh module + cache reset before each test group
function loadModule() {
  // Clear require cache so each group gets isolated module state
  const key = require.resolve('../lib/gcp-auth');
  delete require.cache[key];
  return require('../lib/gcp-auth');
}

// ═══════════════════════════════════════════════════════════════════════════════
// a) returns accessToken; JWT shape + signature valid
// ═══════════════════════════════════════════════════════════════════════════════
test('returns accessToken from fetch and JWT is structurally valid', async () => {
  const { getAccessToken, _resetCacheForTests } = loadModule();
  _resetCacheForTests();
  _fetchSpy = [];
  _fetchImpl = () => _okResponse({ access_token: 'tok1', expires_in: 3600 });

  const result = await getAccessToken({ saKeyJson: FAKE_SA });

  assert.equal(result.accessToken, 'tok1');
  assert.ok(typeof result.expiresAt === 'number' && result.expiresAt > Math.floor(Date.now() / 1000));

  // Verify fetch was called once with the token URL
  assert.equal(_fetchSpy.length, 1);
  assert.equal(_fetchSpy[0].url, TOKEN_URL);

  // Parse the request body
  const bodyStr = _fetchSpy[0].options.body;
  assert.ok(bodyStr.includes('grant_type='), 'body must contain grant_type');
  assert.ok(bodyStr.includes('urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer'), 'body must contain jwt-bearer grant type');
  assert.ok(bodyStr.includes('assertion='), 'body must contain assertion');

  // Extract JWT from assertion param
  const params = new URLSearchParams(bodyStr);
  const jwt = params.get('assertion');
  assert.ok(jwt, 'assertion must be present');

  const parts = jwt.split('.');
  assert.equal(parts.length, 3, 'JWT must have 3 segments');

  const header  = _base64urlDecode(parts[0]);
  const payload = _base64urlDecode(parts[1]);

  assert.equal(header.alg, 'RS256');
  assert.equal(header.typ, 'JWT');
  assert.equal(payload.iss, FAKE_SA.client_email);
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/cloud-platform');
  assert.equal(payload.aud, TOKEN_URL);
  assert.ok(typeof payload.iat === 'number');
  assert.ok(typeof payload.exp === 'number');
  assert.equal(payload.exp - payload.iat, 3600);

  // Verify RSA-SHA256 signature against the test public key
  const unsigned = parts[0] + '.' + parts[1];
  const sigBuf   = Buffer.from(
    parts[2].replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((parts[2].length + 3) % 4),
    'base64',
  );
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(unsigned);
  assert.ok(verifier.verify(TEST_PUBLIC_KEY, sigBuf), 'JWT signature must verify against test public key');
});

// ═══════════════════════════════════════════════════════════════════════════════
// b) caching behaviour
// ═══════════════════════════════════════════════════════════════════════════════
test('caches token: same key+scope reuses; different scope fetches again; reset clears', async () => {
  const { getAccessToken, _resetCacheForTests } = loadModule();
  _resetCacheForTests();
  _fetchSpy = [];
  _fetchImpl = () => _okResponse({ access_token: 'cached-tok', expires_in: 3600 });

  // First call — fetches
  await getAccessToken({ saKeyJson: FAKE_SA });
  assert.equal(_fetchSpy.length, 1);

  // Second call same key+scope — should NOT fetch again
  await getAccessToken({ saKeyJson: FAKE_SA });
  assert.equal(_fetchSpy.length, 1, 'second call with same scope must use cache');

  // Different scope — must fetch again
  await getAccessToken({ saKeyJson: FAKE_SA, scope: 'https://www.googleapis.com/auth/devstorage.read_only' });
  assert.equal(_fetchSpy.length, 2, 'different scope must trigger new fetch');

  // Reset cache — must fetch again on next call
  _resetCacheForTests();
  await getAccessToken({ saKeyJson: FAKE_SA });
  assert.equal(_fetchSpy.length, 3, 'after cache reset, next call must fetch');
});

// ═══════════════════════════════════════════════════════════════════════════════
// c) string saKeyJson + literal \n normalization
// ═══════════════════════════════════════════════════════════════════════════════
test('accepts string saKeyJson and normalizes literal \\n in private_key', async () => {
  const { getAccessToken, _resetCacheForTests } = loadModule();
  _resetCacheForTests();
  _fetchSpy = [];
  _fetchImpl = () => _okResponse({ access_token: 'string-tok', expires_in: 3600 });

  // Build a JSON string where the private_key has literal backslash-n instead of real newlines
  const keyWithLiteralNewlines = TEST_PRIVATE_KEY.replace(/\n/g, '\\n');
  const saStr = JSON.stringify({
    client_email: FAKE_SA.client_email,
    private_key:  keyWithLiteralNewlines,
  });

  // Should NOT throw — normalization should fix the PEM
  const result = await getAccessToken({ saKeyJson: saStr });
  assert.equal(result.accessToken, 'string-tok');
  assert.equal(_fetchSpy.length, 1, 'string input must call fetch once');
});

// ═══════════════════════════════════════════════════════════════════════════════
// d) validation errors
// ═══════════════════════════════════════════════════════════════════════════════
test('throws descriptively on missing client_email', async () => {
  const { getAccessToken, _resetCacheForTests } = loadModule();
  _resetCacheForTests();

  await assert.rejects(
    () => getAccessToken({ saKeyJson: { private_key: TEST_PRIVATE_KEY } }),
    (err) => {
      assert.ok(err.message.includes('client_email'), 'error must mention client_email');
      return true;
    },
  );
});

test('throws descriptively on missing private_key', async () => {
  const { getAccessToken, _resetCacheForTests } = loadModule();
  _resetCacheForTests();

  await assert.rejects(
    () => getAccessToken({ saKeyJson: { client_email: 'a@b.com' } }),
    (err) => {
      assert.ok(err.message.includes('private_key'), 'error must mention private_key');
      return true;
    },
  );
});

test('throws on invalid JSON string', async () => {
  const { getAccessToken, _resetCacheForTests } = loadModule();
  _resetCacheForTests();

  await assert.rejects(
    () => getAccessToken({ saKeyJson: 'not json {{{' }),
    (err) => {
      assert.ok(err.message.includes('invalid service account JSON'));
      return true;
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// e) non-2xx fetch response → throws; err.status set; NOT cached
// ═══════════════════════════════════════════════════════════════════════════════
test('non-2xx response throws with status and error body; token not cached', async () => {
  const { getAccessToken, _resetCacheForTests } = loadModule();
  _resetCacheForTests();
  _fetchSpy = [];

  let callCount = 0;
  _fetchImpl = () => {
    callCount++;
    if (callCount === 1) return _errResponse(400, { error: 'invalid_grant', error_description: 'bad jwt' });
    return _okResponse({ access_token: 'recovery-tok', expires_in: 3600 });
  };

  await assert.rejects(
    () => getAccessToken({ saKeyJson: FAKE_SA }),
    (err) => {
      assert.equal(err.status, 400, 'err.status must be 400');
      assert.ok(err.message.includes('invalid_grant') || err.message.includes('bad jwt'), 'error must include response error text');
      return true;
    },
  );

  // Token must NOT have been cached — next call must fetch again
  const result = await getAccessToken({ saKeyJson: FAKE_SA });
  assert.equal(result.accessToken, 'recovery-tok');
  assert.equal(callCount, 2, 'failed request must not cache; next call must fetch');
});

// ═══════════════════════════════════════════════════════════════════════════════
// isSaKeyValid — non-throwing quick validator
// ═══════════════════════════════════════════════════════════════════════════════
test('isSaKeyValid returns true for a valid SA key object', () => {
  const { isSaKeyValid } = loadModule();
  assert.equal(isSaKeyValid(FAKE_SA), true);
});

test('isSaKeyValid returns false for missing fields or bad JSON string', () => {
  const { isSaKeyValid } = loadModule();
  assert.equal(isSaKeyValid({}), false);
  assert.equal(isSaKeyValid({ client_email: 'a@b.com' }), false);
  assert.equal(isSaKeyValid('bad json'), false);
  assert.equal(isSaKeyValid(null), false);
});
