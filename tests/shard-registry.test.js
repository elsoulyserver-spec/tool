// tests/shard-registry.test.js
// Unit tests for lib/shard-registry.js
// Run: node --test tests/shard-registry.test.js

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Always reload a fresh module between tests to clear the parse cache.
function loadModule() {
  const key = require.resolve('../lib/shard-registry');
  delete require.cache[key];
  return require('../lib/shard-registry');
}

// Minimal valid shard map for most tests
const VALID_MAP = JSON.stringify({
  'prod-1': { gcpProjectId: 'easytrack-prod-1', region: 'me-central1', saKeyEnv: 'GCP_SA_KEY_PROD_1' },
});

// Helper: set env vars, run fn, then restore originals
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// isConfigured
// ═══════════════════════════════════════════════════════════════════════════════

test('isConfigured returns false when MANAGED_SHARDS is unset', () => {
  withEnv({ MANAGED_SHARDS: undefined, MANAGED_DEFAULT_SHARD: undefined }, () => {
    assert.equal(loadModule().isConfigured(), false);
  });
});

test('isConfigured returns false when MANAGED_DEFAULT_SHARD is unset', () => {
  withEnv({ MANAGED_SHARDS: VALID_MAP, MANAGED_DEFAULT_SHARD: undefined }, () => {
    assert.equal(loadModule().isConfigured(), false);
  });
});

test('isConfigured returns false when default shard is not in the map', () => {
  withEnv({ MANAGED_SHARDS: VALID_MAP, MANAGED_DEFAULT_SHARD: 'prod-99' }, () => {
    assert.equal(loadModule().isConfigured(), false);
  });
});

test('isConfigured returns true when map + default are valid', () => {
  withEnv({ MANAGED_SHARDS: VALID_MAP, MANAGED_DEFAULT_SHARD: 'prod-1', GCP_SA_KEY_PROD_1: '{"k":1}' }, () => {
    assert.equal(loadModule().isConfigured(), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getShard — happy path
// ═══════════════════════════════════════════════════════════════════════════════

test('getShard returns resolved shard object with correct fields', () => {
  const saJson = JSON.stringify({ client_email: 'sa@p.iam.gserviceaccount.com', private_key: 'pk' });
  withEnv({ MANAGED_SHARDS: VALID_MAP, GCP_SA_KEY_PROD_1: saJson }, () => {
    const shard = loadModule().getShard('prod-1');
    assert.equal(shard.id, 'prod-1');
    assert.equal(shard.gcpProjectId, 'easytrack-prod-1');
    assert.equal(shard.region, 'me-central1');
    assert.equal(shard.saKeyJson, saJson);
  });
});

test('getShard supports multiple shards in the map', () => {
  const map = JSON.stringify({
    'prod-1': { gcpProjectId: 'easytrack-prod-1', region: 'me-central1', saKeyEnv: 'GCP_SA_KEY_PROD_1' },
    'prod-2': { gcpProjectId: 'easytrack-prod-2', region: 'us-central1', saKeyEnv: 'GCP_SA_KEY_PROD_2' },
  });
  withEnv({ MANAGED_SHARDS: map, GCP_SA_KEY_PROD_1: 'key1', GCP_SA_KEY_PROD_2: 'key2' }, () => {
    const mod = loadModule();
    assert.equal(mod.getShard('prod-1').saKeyJson, 'key1');
    assert.equal(mod.getShard('prod-2').saKeyJson, 'key2');
    assert.equal(mod.getShard('prod-2').region, 'us-central1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getShard — error paths
// ═══════════════════════════════════════════════════════════════════════════════

test('getShard throws UNKNOWN_SHARD for a missing shard id', () => {
  withEnv({ MANAGED_SHARDS: VALID_MAP, GCP_SA_KEY_PROD_1: 'key' }, () => {
    assert.throws(
      () => loadModule().getShard('prod-99'),
      (err) => {
        assert.ok(err.message.includes('prod-99'));
        assert.equal(err.code, 'UNKNOWN_SHARD');
        return true;
      },
    );
  });
});

test('getShard throws UNKNOWN_SHARD when called with no argument', () => {
  withEnv({ MANAGED_SHARDS: VALID_MAP, GCP_SA_KEY_PROD_1: 'key' }, () => {
    assert.throws(
      () => loadModule().getShard(undefined),
      (err) => {
        assert.equal(err.code, 'UNKNOWN_SHARD');
        return true;
      },
    );
  });
});

test('getShard throws when the SA key env var is unset', () => {
  withEnv({ MANAGED_SHARDS: VALID_MAP, GCP_SA_KEY_PROD_1: undefined }, () => {
    assert.throws(
      () => loadModule().getShard('prod-1'),
      (err) => {
        assert.ok(err.message.includes('GCP_SA_KEY_PROD_1'));
        return true;
      },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MANAGED_SHARDS parse errors
// ═══════════════════════════════════════════════════════════════════════════════

test('invalid JSON in MANAGED_SHARDS throws on first use', () => {
  withEnv({ MANAGED_SHARDS: 'not-json' }, () => {
    assert.throws(
      () => loadModule().getShard('prod-1'),
      (err) => {
        assert.ok(err.message.includes('MANAGED_SHARDS'));
        return true;
      },
    );
  });
});

test('MANAGED_SHARDS entry missing gcpProjectId throws', () => {
  const bad = JSON.stringify({ 'prod-1': { region: 'me-central1', saKeyEnv: 'X' } });
  withEnv({ MANAGED_SHARDS: bad }, () => {
    assert.throws(
      () => loadModule().getShard('prod-1'),
      (err) => {
        assert.ok(err.message.includes('gcpProjectId'));
        return true;
      },
    );
  });
});

test('MANAGED_SHARDS entry missing region throws', () => {
  const bad = JSON.stringify({ 'prod-1': { gcpProjectId: 'p', saKeyEnv: 'X' } });
  withEnv({ MANAGED_SHARDS: bad }, () => {
    assert.throws(
      () => loadModule().getShard('prod-1'),
      (err) => {
        assert.ok(err.message.includes('region'));
        return true;
      },
    );
  });
});

test('MANAGED_SHARDS entry missing saKeyEnv throws', () => {
  const bad = JSON.stringify({ 'prod-1': { gcpProjectId: 'p', region: 'me-central1' } });
  withEnv({ MANAGED_SHARDS: bad }, () => {
    assert.throws(
      () => loadModule().getShard('prod-1'),
      (err) => {
        assert.ok(err.message.includes('saKeyEnv'));
        return true;
      },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// pickShardForNewTenant
// ═══════════════════════════════════════════════════════════════════════════════

test('pickShardForNewTenant returns the default shard', () => {
  const saJson = '{"client_email":"a@b.com","private_key":"pk"}';
  withEnv({ MANAGED_SHARDS: VALID_MAP, MANAGED_DEFAULT_SHARD: 'prod-1', GCP_SA_KEY_PROD_1: saJson }, () => {
    const shard = loadModule().pickShardForNewTenant();
    assert.equal(shard.id, 'prod-1');
    assert.equal(shard.gcpProjectId, 'easytrack-prod-1');
  });
});

test('pickShardForNewTenant throws when MANAGED_DEFAULT_SHARD is unset', () => {
  withEnv({ MANAGED_SHARDS: VALID_MAP, MANAGED_DEFAULT_SHARD: undefined, GCP_SA_KEY_PROD_1: 'key' }, () => {
    assert.throws(
      () => loadModule().pickShardForNewTenant(),
      (err) => {
        assert.ok(err.message.includes('MANAGED_DEFAULT_SHARD'));
        return true;
      },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// _resetForTests — parse cache clears
// ═══════════════════════════════════════════════════════════════════════════════

test('_resetForTests clears the parse cache so env changes take effect', () => {
  const mod = loadModule();

  // First read with prod-1
  withEnv({ MANAGED_SHARDS: VALID_MAP, GCP_SA_KEY_PROD_1: 'key-a' }, () => {
    const s = mod.getShard('prod-1');
    assert.equal(s.saKeyJson, 'key-a');
  });

  // Without reset, _parsed still holds the old map — changing env has no effect
  // because saKeyEnv is resolved at call-time (not cached), so a new env value
  // IS visible. Reset the module-level map cache and swap to a different map.
  mod._resetForTests();

  const newMap = JSON.stringify({
    'prod-9': { gcpProjectId: 'easytrack-prod-9', region: 'eu-west1', saKeyEnv: 'GCP_SA_KEY_PROD_9' },
  });
  withEnv({ MANAGED_SHARDS: newMap, GCP_SA_KEY_PROD_9: 'key-9' }, () => {
    const s = mod.getShard('prod-9');
    assert.equal(s.id, 'prod-9');
    assert.equal(s.saKeyJson, 'key-9');
  });
});
