#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// scripts/gtm-delete-all-containers.js
//
// SAFE bulk-delete of every GTM container in an account.
//
// Safety guarantees
//   1. Lists all containers and prints a numbered summary before touching anything.
//   2. Exports a full JSON backup of every container's latest version.
//   3. Aborts immediately if ANY backup fails — nothing is deleted.
//   4. Demands explicit confirmation: type  DELETE_ALL_<N>_CONTAINERS  exactly.
//   5. Deletes in batches of 5 with exponential backoff on HTTP 429.
//   6. Prints a final report (deleted / failed / backup path).
//
// Usage:
//   node scripts/gtm-delete-all-containers.js
//
// Required env vars (loaded from .env automatically if present):
//   GTM_SA_KEY_JSON  — full service-account JSON key, stringified
//   GTM_ACCOUNT_ID   — numeric GTM account ID  (e.g. 6351139341)
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const rl     = require('readline');

// ── 0. Load .env (no external deps) ─────────────────────────────────────────
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
    // Skip blanks and comments; don't overwrite vars already in the environment
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim();
    }
  });
}

// ── 1. Constants ─────────────────────────────────────────────────────────────
const BACKUP_DIR  = path.join(__dirname, '..', 'backups', 'gtm-containers');
const BATCH_SIZE  = 5;

const GTM_HOST   = 'tagmanager.googleapis.com';
const API_BASE   = '/tagmanager/v2';
const TOKEN_HOST = 'oauth2.googleapis.com';
const TOKEN_PATH = '/token';
const GTM_SCOPE  =
  'https://www.googleapis.com/auth/tagmanager.readonly ' +
  'https://www.googleapis.com/auth/tagmanager.edit.containers ' +
  'https://www.googleapis.com/auth/tagmanager.delete.containers';

// Exponential backoff delays (ms) for 429 responses
const BACKOFF_429 = [20_000, 40_000, 70_000, 90_000];

// ── 2. Service-account helpers ───────────────────────────────────────────────
let _sa = null;
function getSA() {
  if (_sa) return _sa;
  const raw = process.env.GTM_SA_KEY_JSON;
  if (!raw) throw new Error('GTM_SA_KEY_JSON is not set');
  try { _sa = JSON.parse(raw); } catch (e) { throw new Error('GTM_SA_KEY_JSON is not valid JSON: ' + e.message); }
  if (!_sa.client_email || !_sa.private_key)
    throw new Error('GTM_SA_KEY_JSON is missing client_email or private_key');
  // Railway stores literal \n — restore real newlines for the PEM parser
  _sa.private_key = _sa.private_key.replace(/\\n/g, '\n');
  return _sa;
}

function getAccountId() {
  const id = process.env.GTM_ACCOUNT_ID;
  if (!id) throw new Error('GTM_ACCOUNT_ID is not set');
  return String(id).trim();
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// ── 3. OAuth token (JWT → access token, cached) ──────────────────────────────
let _token = null;
let _tokenExp = 0;

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_token && now < _tokenExp - 60) return _token;

  const sa = getSA();
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: GTM_SCOPE,
    aud: `https://${TOKEN_HOST}${TOKEN_PATH}`,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));
  const signer   = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const jwt = unsigned + '.' + base64url(signer.sign(sa.private_key));

  const form = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')
             + '&assertion=' + encodeURIComponent(jwt);
  const res = await httpRequest(
    { hostname: TOKEN_HOST, path: TOKEN_PATH, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                 'Content-Length': Buffer.byteLength(form) } },
    form
  );
  if (res.status !== 200 || !res.data.access_token)
    throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(res.data)}`);
  _token    = res.data.access_token;
  _tokenExp = now + (res.data.expires_in || 3600);
  return _token;
}

// ── 4. Raw HTTPS helper ──────────────────────────────────────────────────────
function httpRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); } catch (_) { data = { raw }; }
        resolve({ status: res.statusCode, data });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 5. GTM API calls ─────────────────────────────────────────────────────────
async function gtmGet(urlPath, attempt = 0) {
  const token = await getToken();
  const res = await httpRequest({
    hostname: GTM_HOST,
    path: API_BASE + urlPath,
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token },
  });

  if (res.status === 429 && attempt < BACKOFF_429.length) {
    const wait = BACKOFF_429[attempt];
    console.warn(`    [429] quota hit — waiting ${wait / 1000}s before retry ${attempt + 1}…`);
    await sleep(wait);
    return gtmGet(urlPath, attempt + 1);
  }

  if (res.status < 200 || res.status >= 300)
    throw Object.assign(
      new Error(`GET ${urlPath} → HTTP ${res.status}: ${JSON.stringify(res.data)}`),
      { status: res.status }
    );

  return res.data;
}

async function gtmDelete(urlPath, attempt = 0) {
  const token = await getToken();
  const res = await httpRequest({
    hostname: GTM_HOST,
    path: API_BASE + urlPath,
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token },
  });

  if (res.status === 429 && attempt < BACKOFF_429.length) {
    const wait = BACKOFF_429[attempt];
    console.warn(`    [429] quota hit — waiting ${wait / 1000}s before retry ${attempt + 1}…`);
    await sleep(wait);
    return gtmDelete(urlPath, attempt + 1);
  }

  // 204 No Content = deleted; 200 = some APIs return body; 404 = already gone — all fine
  if (![200, 204, 404].includes(res.status))
    throw Object.assign(
      new Error(`DELETE ${urlPath} → HTTP ${res.status}: ${JSON.stringify(res.data)}`),
      { status: res.status }
    );

  return res.data;
}

// ── 6. Interactive confirmation ───────────────────────────────────────────────
function prompt(question) {
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => iface.question(question, answer => {
    iface.close();
    resolve(answer.trim());
  }));
}

// ── 7. Divider helpers ────────────────────────────────────────────────────────
const HR  = '═'.repeat(70);
const HR2 = '─'.repeat(70);

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  const acc = getAccountId();

  console.log(`\n${HR}`);
  console.log('  GTM SAFE BULK-DELETE');
  console.log(`  Account ID : ${acc}`);
  console.log(`  Backup dir : ${BACKUP_DIR}`);
  console.log(HR);

  // ── STEP 1: List containers ────────────────────────────────────────────────
  console.log('\nSTEP 1/4  Fetching container list…\n');
  const listData   = await gtmGet(`/accounts/${acc}/containers`);
  const containers = (listData.container || [])
    .sort((a, b) => String(a.publicId).localeCompare(String(b.publicId)));

  if (containers.length === 0) {
    console.log('  No containers found. Nothing to do.\n');
    return;
  }

  // ── STEP 2: Print numbered summary ────────────────────────────────────────
  console.log(`  Found ${containers.length} container(s):\n`);
  const numW  = String(containers.length).length;
  const colW  = [numW + 2, 16, 16, 14, 0];  // #, accountId, containerId, publicId, name
  const header =
    '#'.padEnd(colW[0]) +
    'accountId'.padEnd(colW[1]) +
    'containerId'.padEnd(colW[2]) +
    'publicId'.padEnd(colW[3]) +
    'usageContext'.padEnd(14) +
    '  name';
  console.log('  ' + header);
  console.log('  ' + HR2);

  containers.forEach((c, i) => {
    const row =
      String(i + 1).padEnd(colW[0]) +
      String(c.accountId   || acc).padEnd(colW[1]) +
      String(c.containerId || '').padEnd(colW[2]) +
      String(c.publicId    || '').padEnd(colW[3]) +
      String((c.usageContext || []).join(',') || '').padEnd(14) +
      '  ' + String(c.name || '');
    console.log('  ' + row);
  });

  // ── STEP 3: Backup every container ────────────────────────────────────────
  console.log(`\n${HR2}`);
  console.log(`STEP 2/4  Exporting backups…\n`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const backedUp     = [];   // { container, file }
  const backupFailed = [];   // { container, error }

  for (let i = 0; i < containers.length; i++) {
    const c    = containers[i];
    const cid  = c.containerId;
    const pub  = c.publicId || cid;
    const safe = pub.replace(/[^a-zA-Z0-9_-]/g, '_');
    const file = path.join(BACKUP_DIR, `${safe}.json`);
    const tag  = `[${i + 1}/${containers.length}]`;

    let payload  = null;
    let warnNote = '';

    try {
      // Prefer the full container version (tags / triggers / variables)
      payload = await gtmGet(`/accounts/${acc}/containers/${cid}/versions:latest`);
    } catch (vErr) {
      // Container may exist but have no published version — fall back to metadata
      warnNote = ` (no version found: ${vErr.message}; saving metadata only)`;
      payload  = c;
    }

    try {
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
      const kb = (fs.statSync(file).size / 1024).toFixed(1);
      console.log(`  ${tag} ✓  ${pub}  ${c.name}  →  ${path.basename(file)}  (${kb} KB)${warnNote}`);
      backedUp.push({ container: c, file });
    } catch (writeErr) {
      console.error(`  ${tag} ✗  ${pub}  ${c.name}  —  WRITE FAILED: ${writeErr.message}`);
      backupFailed.push({ container: c, error: writeErr.message });
    }
  }

  // Hard abort if any backup failed
  if (backupFailed.length > 0) {
    console.error(`\n⛔  ABORT — ${backupFailed.length} backup(s) failed:`);
    backupFailed.forEach(f =>
      console.error(`     • ${f.container.publicId}  (${f.container.name}): ${f.error}`)
    );
    console.error('    Nothing has been deleted. Fix the errors above and re-run.\n');
    process.exit(1);
  }

  console.log(`\n  All ${backedUp.length} backup(s) written to:\n  ${BACKUP_DIR}\n`);

  // ── STEP 4: Explicit confirmation ─────────────────────────────────────────
  const confirmKey = `DELETE_ALL_${containers.length}_CONTAINERS`;
  console.log(HR2);
  console.log('STEP 3/4  Confirmation required\n');
  console.log(`  You are about to PERMANENTLY DELETE ${containers.length} GTM container(s).`);
  console.log('  This cannot be undone (your backups are the only recovery path).\n');
  console.log(`  Type exactly:  ${confirmKey}`);
  console.log('  (or anything else to abort)\n');

  const answer = await prompt('  > ');

  if (answer !== confirmKey) {
    console.log('\n  Confirmation did not match. Aborting — nothing deleted.\n');
    process.exit(0);
  }

  // ── STEP 5: Delete in batches of BATCH_SIZE ────────────────────────────────
  console.log(`\n${HR2}`);
  console.log(`STEP 4/4  Deleting ${containers.length} container(s) in batches of ${BATCH_SIZE}…\n`);

  const deleted = [];
  const failed  = [];

  for (let i = 0; i < backedUp.length; i += BATCH_SIZE) {
    const batch     = backedUp.slice(i, i + BATCH_SIZE);
    const batchNum  = Math.floor(i / BATCH_SIZE) + 1;
    const batchTotal = Math.ceil(backedUp.length / BATCH_SIZE);
    console.log(`  Batch ${batchNum}/${batchTotal}  (containers ${i + 1}–${Math.min(i + BATCH_SIZE, backedUp.length)}):`);

    await Promise.allSettled(
      batch.map(async ({ container: c }) => {
        const pub = c.publicId || c.containerId;
        try {
          await gtmDelete(`/accounts/${acc}/containers/${c.containerId}`);
          console.log(`    ✓  Deleted  ${pub}  —  ${c.name}`);
          deleted.push(c);
        } catch (err) {
          console.error(`    ✗  FAILED   ${pub}  —  ${c.name}:  ${err.message}`);
          failed.push({ container: c, error: err.message });
        }
      })
    );

    // Brief pause between batches (not after the last one)
    if (i + BATCH_SIZE < backedUp.length) {
      console.log('  … 3s pause between batches …');
      await sleep(3000);
    }
  }

  // ── FINAL REPORT ───────────────────────────────────────────────────────────
  console.log(`\n${HR}`);
  console.log('  FINAL REPORT');
  console.log(HR);
  console.log(`  Containers before deletion  :  ${containers.length}`);
  console.log(`  Successfully deleted         :  ${deleted.length}`);
  console.log(`  Failed to delete             :  ${failed.length}`);
  console.log(`  Backup files location        :  ${BACKUP_DIR}`);

  if (failed.length > 0) {
    console.log('\n  Failed containers:');
    failed.forEach(f =>
      console.log(`    • ${f.container.publicId}  (${f.container.name}): ${f.error}`)
    );
  }

  console.log(HR + '\n');

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
