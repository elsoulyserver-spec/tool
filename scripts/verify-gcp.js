#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { getAccessToken, isSaKeyValid } = require('../lib/gcp-auth');

const ROOT = path.resolve(__dirname, '..');
const FETCH_TIMEOUT_MS = 12_000;

const ICON = {
  ready: '✅',
  warning: '⚠',
  missing: '❌',
};

function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1);
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
  return true;
}

function env(name) {
  return (process.env[name] || '').trim();
}

function parseJsonEnv(name) {
  const raw = env(name);
  if (!raw) throw new Error(`${name} is not set`);
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`${name} is not valid JSON: ${e.message}`); }
}

function result(status, name, detail, fix) {
  return { status, name, detail, fix };
}

function ready(name, detail) {
  return result('ready', name, detail || 'Ready');
}

function warning(name, detail, fix) {
  return result('warning', name, detail, fix);
}

function missing(name, detail, fix) {
  return result('missing', name, detail, fix);
}

async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await globalThis.fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    const gerr = data.error || {};
    const msg = gerr.message || data.raw || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function tokenFor(saKeyJson, scope = 'https://www.googleapis.com/auth/cloud-platform') {
  const { accessToken } = await getAccessToken({ saKeyJson, scope });
  return accessToken;
}

function parseShards() {
  const shards = parseJsonEnv('MANAGED_SHARDS');
  const defaultShard = env('MANAGED_DEFAULT_SHARD');
  if (!defaultShard) throw new Error('MANAGED_DEFAULT_SHARD is not set');
  if (!shards[defaultShard]) throw new Error(`MANAGED_DEFAULT_SHARD "${defaultShard}" is not present in MANAGED_SHARDS`);
  for (const [id, shard] of Object.entries(shards)) {
    if (!shard || !shard.gcpProjectId || !shard.region || !shard.saKeyEnv) {
      throw new Error(`MANAGED_SHARDS["${id}"] must include gcpProjectId, region, and saKeyEnv`);
    }
    if (!env(shard.saKeyEnv)) throw new Error(`${shard.saKeyEnv} is not set`);
    if (!isSaKeyValid(env(shard.saKeyEnv))) throw new Error(`${shard.saKeyEnv} is not a valid service account JSON`);
  }
  return { shards, defaultShard };
}

function firebaseProjectId() {
  if (env('FIRESTORE_PROJECT_ID')) return env('FIRESTORE_PROJECT_ID');
  if (env('GOOGLE_CLOUD_PROJECT')) return env('GOOGLE_CLOUD_PROJECT');
  const sa = parseJsonEnv('FIREBASE_SA_KEY_JSON');
  if (!sa.project_id) throw new Error('FIREBASE_SA_KEY_JSON missing project_id');
  return sa.project_id;
}

function gtmProjectId() {
  const sa = parseJsonEnv('GTM_SA_KEY_JSON');
  if (!sa.project_id) throw new Error('GTM_SA_KEY_JSON missing project_id');
  return sa.project_id;
}

function serviceUsageUrl(projectId, service) {
  return `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/services/${service}`;
}

async function checkRequiredEnv() {
  const required = [
    'MANAGED_DEPLOY_PROVIDER',
    'MANAGED_SHARDS',
    'MANAGED_DEFAULT_SHARD',
    'GTM_SA_KEY_JSON',
    'GTM_ACCOUNT_ID',
    'FIREBASE_SA_KEY_JSON',
    'SGTM_BASE_DOMAIN',
  ];
  const missingVars = required.filter(k => !env(k));
  if (missingVars.length) {
    return missing('Required environment variables', `Missing: ${missingVars.join(', ')}`, 'Set these in Railway before launch.');
  }
  if ((env('MANAGED_DEPLOY_PROVIDER') || 'cloudrun').toLowerCase() !== 'cloudrun') {
    return missing('Managed deploy provider', `MANAGED_DEPLOY_PROVIDER=${env('MANAGED_DEPLOY_PROVIDER')}`, 'Set MANAGED_DEPLOY_PROVIDER=cloudrun.');
  }
  try {
    parseShards();
    if (!isSaKeyValid(env('GTM_SA_KEY_JSON'))) throw new Error('GTM_SA_KEY_JSON is invalid');
    if (!isSaKeyValid(env('FIREBASE_SA_KEY_JSON'))) throw new Error('FIREBASE_SA_KEY_JSON is invalid');
  } catch (e) {
    return missing('Required environment variables', e.message, 'Fix the invalid env var and rerun.');
  }
  return ready('Required environment variables', 'Required managed hosting env vars are present and parseable.');
}

async function checkApis() {
  let parsed;
  try { parsed = parseShards(); } catch (e) { return [missing('Google Cloud APIs', e.message, 'Fix shard env first.')]; }
  const firebaseProject = (() => { try { return firebaseProjectId(); } catch (_) { return null; } })();
  const gtmProject = (() => { try { return gtmProjectId(); } catch (_) { return null; } })();

  const checks = [];
  const byProject = new Map();
  for (const shard of Object.values(parsed.shards)) {
    byProject.set(shard.gcpProjectId, {
      saKeyJson: env(shard.saKeyEnv),
      services: [
        'run.googleapis.com',
        'iamcredentials.googleapis.com',
        'cloudresourcemanager.googleapis.com',
        'compute.googleapis.com',
        'certificatemanager.googleapis.com',
      ],
    });
  }
  if (firebaseProject) {
    const firstShard = Object.values(parsed.shards)[0];
    byProject.set(firebaseProject, {
      saKeyJson: env('FIREBASE_SA_KEY_JSON') || env(firstShard.saKeyEnv),
      services: ['firestore.googleapis.com'],
    });
  }
  if (gtmProject) {
    byProject.set(gtmProject, {
      saKeyJson: env('GTM_SA_KEY_JSON'),
      services: ['tagmanager.googleapis.com'],
    });
  }

  for (const [projectId, cfg] of byProject) {
    let token;
    try { token = await tokenFor(cfg.saKeyJson); }
    catch (e) {
      checks.push(missing(`Google Cloud APIs (${projectId})`, `Could not mint token: ${e.message}`, 'Check service account key JSON.'));
      continue;
    }
    for (const svc of cfg.services) {
      try {
        const data = await fetchJson(serviceUsageUrl(projectId, svc), { headers: { Authorization: `Bearer ${token}` } });
        if (data.state === 'ENABLED') checks.push(ready(`API ${svc}`, `${projectId}: ENABLED`));
        else checks.push(missing(`API ${svc}`, `${projectId}: ${data.state || 'not enabled'}`, `gcloud services enable ${svc} --project=${projectId}`));
      } catch (e) {
        checks.push(missing(`API ${svc}`, `${projectId}: ${e.message}`, `gcloud services enable ${svc} --project=${projectId}`));
      }
    }
  }
  return checks;
}

async function checkIamAccess() {
  let parsed;
  try { parsed = parseShards(); } catch (e) { return [missing('IAM access', e.message, 'Fix shard env first.')]; }
  const out = [];
  const permissions = [
    'run.services.create',
    'run.services.get',
    'run.services.update',
    'run.services.setIamPolicy',
    'iam.serviceAccounts.actAs',
  ];
  for (const [id, shard] of Object.entries(parsed.shards)) {
    try {
      const token = await tokenFor(env(shard.saKeyEnv));
      const url = `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(shard.gcpProjectId)}:testIamPermissions`;
      const data = await fetchJson(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions }),
      });
      const granted = new Set(data.permissions || []);
      const missingPerms = permissions.filter(p => !granted.has(p));
      if (missingPerms.length) {
        out.push(missing(`IAM access (${id})`, `Missing permissions: ${missingPerms.join(', ')}`, 'Grant roles/run.admin and roles/iam.serviceAccountUser to the shard service account.'));
      } else {
        out.push(ready(`IAM access (${id})`, `${shard.gcpProjectId}: required Cloud Run permissions granted.`));
      }
    } catch (e) {
      out.push(missing(`IAM access (${id})`, e.message, 'Enable Cloud Resource Manager API and verify IAM roles.'));
    }
  }
  return out;
}

async function checkGtmAuth() {
  if (!env('GTM_SA_KEY_JSON') || !env('GTM_ACCOUNT_ID')) {
    return missing('GTM authentication', 'GTM_SA_KEY_JSON or GTM_ACCOUNT_ID is missing', 'Set GTM env vars.');
  }
  try {
    const token = await tokenFor(env('GTM_SA_KEY_JSON'), 'https://www.googleapis.com/auth/tagmanager.edit.containers');
    const url = `https://tagmanager.googleapis.com/tagmanager/v2/accounts/${encodeURIComponent(env('GTM_ACCOUNT_ID'))}/containers`;
    const data = await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
    const count = Array.isArray(data.container) ? data.container.length : 0;
    return ready('GTM authentication', `Service account can list GTM containers. Current count: ${count}.`);
  } catch (e) {
    return missing('GTM authentication', e.message, 'Enable Tag Manager API and add the service account as Admin in GTM account user management.');
  }
}

async function checkFirestoreConnectivity() {
  try {
    const projectId = firebaseProjectId();
    const token = await tokenFor(env('FIREBASE_SA_KEY_JSON'), 'https://www.googleapis.com/auth/datastore');
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/clients?pageSize=1`;
    await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
    return ready('Firestore connectivity', `${projectId}: documents API reachable.`);
  } catch (e) {
    return missing('Firestore connectivity', e.message, 'Enable Firestore and verify FIREBASE_SA_KEY_JSON.');
  }
}

async function checkCloudRunConnectivity() {
  let parsed;
  try { parsed = parseShards(); } catch (e) { return [missing('Cloud Run connectivity', e.message, 'Fix shard env first.')]; }
  const out = [];
  for (const [id, shard] of Object.entries(parsed.shards)) {
    try {
      const token = await tokenFor(env(shard.saKeyEnv));
      const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(shard.gcpProjectId)}/locations/${encodeURIComponent(shard.region)}/services?pageSize=1`;
      await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
      out.push(ready(`Cloud Run connectivity (${id})`, `${shard.gcpProjectId}/${shard.region}: services list reachable.`));
    } catch (e) {
      out.push(missing(`Cloud Run connectivity (${id})`, e.message, 'Enable Cloud Run API and grant roles/run.admin.'));
    }
  }
  return out;
}

async function checkCertificateStatus() {
  let parsed;
  try { parsed = parseShards(); } catch (e) { return [missing('Certificate status', e.message, 'Fix shard env first.')]; }
  const certName = env('SGTM_CERTIFICATE_NAME') || 'sgtm-wildcard-cert';
  const out = [];
  for (const [id, shard] of Object.entries(parsed.shards)) {
    try {
      const token = await tokenFor(env(shard.saKeyEnv));
      const url = `https://certificatemanager.googleapis.com/v1/projects/${encodeURIComponent(shard.gcpProjectId)}/locations/global/certificates/${encodeURIComponent(certName)}`;
      const data = await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
      if (data.sanDnsnames && !data.sanDnsnames.includes(`*.${env('SGTM_BASE_DOMAIN')}`)) {
        out.push(warning(`Certificate status (${id})`, `${certName}: ACTIVE check returned, but SANs do not include *.${env('SGTM_BASE_DOMAIN')}.`, 'Verify certificate domains.'));
      } else if (data.scope || data.name) {
        const state = data.managed && data.managed.state || data.state || 'UNKNOWN';
        if (state === 'ACTIVE' || state === 'PROVISIONING') {
          const status = state === 'ACTIVE' ? ready : warning;
          out.push(status(`Certificate status (${id})`, `${certName}: ${state}`, 'Wait until certificate state is ACTIVE.'));
        } else {
          out.push(missing(`Certificate status (${id})`, `${certName}: ${state}`, 'Fix DNS authorization and wait for ACTIVE.'));
        }
      } else {
        out.push(warning(`Certificate status (${id})`, `${certName}: response did not include state`, 'Inspect certificate manually.'));
      }
    } catch (e) {
      out.push(missing(`Certificate status (${id})`, e.message, `Create Certificate Manager cert ${certName} for *.${env('SGTM_BASE_DOMAIN')}.`));
    }
  }
  return out;
}

async function checkEdgeRouterHealth() {
  const base = env('SGTM_BASE_DOMAIN') || 'sgtm.easytrac.io';
  const url = env('EDGE_HEALTH_URL') || `https://anyslug.${base}/__edge/healthz`;
  try {
    const data = await fetchJson(url, { timeoutMs: 8000 });
    if (data.ok === true) return ready('Edge Router health', `${url}: ok=true`);
    return warning('Edge Router health', `${url}: JSON returned but ok !== true`, 'Verify edge-router deployment.');
  } catch (e) {
    return missing('Edge Router health', `${url}: ${e.message}`, 'Deploy edge router, LB, cert, and wildcard DNS first.');
  }
}

async function checkDnsResolution() {
  const base = env('SGTM_BASE_DOMAIN') || 'sgtm.easytrac.io';
  const host = env('EDGE_DNS_TEST_HOST') || `anyslug.${base}`;
  try {
    const addrs = await dns.resolve4(host);
    if (addrs.length) return ready('DNS resolution', `${host} -> ${addrs.join(', ')}`);
    return missing('DNS resolution', `${host}: no A records`, `Create wildcard A record *.${base}.`);
  } catch (e) {
    return missing('DNS resolution', `${host}: ${e.code || e.message}`, `Create wildcard A record *.${base}.`);
  }
}

function indexSignature(index) {
  return JSON.stringify({
    collectionGroup: index.collectionGroup,
    fields: (index.fields || []).map(f => ({ fieldPath: f.fieldPath, order: f.order || 'ASCENDING' })),
  });
}

async function checkFirestoreIndexes() {
  const indexFile = path.join(ROOT, 'firestore.indexes.json');
  if (!fs.existsSync(indexFile)) {
    return missing('Required Firestore indexes', 'firestore.indexes.json not found', 'Restore index definition file.');
  }
  let required;
  try { required = JSON.parse(fs.readFileSync(indexFile, 'utf8')).indexes || []; }
  catch (e) { return missing('Required Firestore indexes', `Invalid firestore.indexes.json: ${e.message}`, 'Fix JSON.'); }

  try {
    const projectId = firebaseProjectId();
    const token = await tokenFor(env('FIREBASE_SA_KEY_JSON'), 'https://www.googleapis.com/auth/datastore');
    const groups = [...new Set(required.map(i => i.collectionGroup))];
    const existing = new Set();
    for (const group of groups) {
      const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/collectionGroups/${encodeURIComponent(group)}/indexes`;
      const data = await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
      for (const idx of data.indexes || []) {
        if (idx.state === 'READY') existing.add(indexSignature({ collectionGroup: group, fields: idx.fields || [] }));
      }
    }
    const missingIndexes = required.filter(idx => !existing.has(indexSignature(idx)));
    if (missingIndexes.length) {
      return missing('Required Firestore indexes', `${missingIndexes.length}/${required.length} indexes missing or not READY`, 'Deploy firestore.indexes.json before launch.');
    }
    return ready('Required Firestore indexes', `${required.length}/${required.length} indexes READY.`);
  } catch (e) {
    return missing('Required Firestore indexes', e.message, 'Deploy indexes and ensure Firebase SA can list Firestore indexes.');
  }
}

async function runChecks() {
  loadDotEnv();
  const groups = [
    ['Environment', [checkRequiredEnv]],
    ['Google Cloud APIs', [async () => checkApis()]],
    ['IAM', [async () => checkIamAccess()]],
    ['GTM', [checkGtmAuth]],
    ['Firestore', [checkFirestoreConnectivity, checkFirestoreIndexes]],
    ['Cloud Run', [async () => checkCloudRunConnectivity()]],
    ['Certificate', [async () => checkCertificateStatus()]],
    ['Edge Router', [checkDnsResolution, checkEdgeRouterHealth]],
  ];

  const all = [];
  for (const [group, checks] of groups) {
    for (const check of checks) {
      try {
        const value = await check();
        const arr = Array.isArray(value) ? value : [value];
        for (const item of arr) all.push({ group, ...item });
      } catch (e) {
        all.push({ group, ...missing(group, e.message, 'Fix the reported issue and rerun.') });
      }
    }
  }
  return all;
}

function print(results) {
  console.log('\nEasyTrack Managed sGTM Launch Gate');
  console.log('Read-only verification. No resources were created.\n');

  let lastGroup = null;
  for (const item of results) {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      console.log(lastGroup);
    }
    const icon = ICON[item.status] || ICON.warning;
    console.log(`  ${icon} ${item.name}`);
    if (item.detail) console.log(`     ${item.detail}`);
    if (item.fix && item.status !== 'ready') console.log(`     Fix: ${item.fix}`);
  }

  const missingCount = results.filter(r => r.status === 'missing').length;
  const warningCount = results.filter(r => r.status === 'warning').length;
  const readyCount = results.filter(r => r.status === 'ready').length;
  console.log(`\nSummary: ${ICON.ready} ${readyCount} ready, ${ICON.warning} ${warningCount} warning, ${ICON.missing} ${missingCount} missing`);
  if (missingCount) {
    console.log('Launch gate: FAILED');
    return 1;
  }
  if (warningCount) {
    console.log('Launch gate: PASSED WITH WARNINGS');
    return 0;
  }
  console.log('Launch gate: PASSED');
  return 0;
}

if (require.main === module) {
  runChecks()
    .then(results => { process.exitCode = print(results); })
    .catch(err => {
      console.error('Verifier crashed:', err && err.stack || err);
      process.exitCode = 1;
    });
}

module.exports = {
  loadDotEnv,
  parseShards,
  runChecks,
  print,
  indexSignature,
};
