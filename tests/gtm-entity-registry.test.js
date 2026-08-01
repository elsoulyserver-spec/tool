'use strict';

/**
 * gtm-entity-registry.test.js
 *
 * Unit tests for lib/gtm-entity-registry.js — the safety net that stops
 * GTM's "File format is invalid. Macros cannot have duplicate names."
 * import error by enforcing global name uniqueness across a container
 * export (variables/macros, tags, triggers, folders, templates).
 *
 * Run: node --test tests/gtm-entity-registry.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { EntityRegistry, validateContainer, finalizeContainer } = require('../lib/gtm-entity-registry');

// ─────────────────────────────────────────────────────────────────────────────
// EntityRegistry — ensureUniqueName / getExisting
// ─────────────────────────────────────────────────────────────────────────────

describe('EntityRegistry.ensureUniqueName', () => {
  test('first registration keeps the requested name', () => {
    const reg = new EntityRegistry();
    const r = reg.ensureUniqueName('variable', 'URL - gclid', { type: 'u', parameter: [{ key: 'queryKey', value: 'gclid' }] });
    assert.equal(r.name, 'URL - gclid');
    assert.equal(r.isDuplicate, false);
  });

  test('identical config under the same name is reused, not renamed', () => {
    const reg = new EntityRegistry();
    const entityA = { type: 'u', parameter: [{ type: 'TEMPLATE', key: 'queryKey', value: 'gclid' }] };
    const entityB = { type: 'u', parameter: [{ type: 'TEMPLATE', key: 'queryKey', value: 'gclid' }] };
    const a = reg.ensureUniqueName('variable', 'URL - gclid', entityA);
    const b = reg.ensureUniqueName('variable', 'URL - gclid', entityB);
    assert.equal(a.name, 'URL - gclid');
    assert.equal(b.name, 'URL - gclid');
    assert.equal(b.reused, true);
    assert.equal(reg.diagnostics.duplicatesRemoved, 1);
  });

  test('conflicting config under the same name gets a deterministic suffix', () => {
    const reg = new EntityRegistry();
    const entityA = { type: 'u', parameter: [{ type: 'TEMPLATE', key: 'queryKey', value: 'gclid' }] };
    const entityB = { type: 'u', parameter: [{ type: 'TEMPLATE', key: 'queryKey', value: 'gclid_v2' }] };
    const entityC = { type: 'u', parameter: [{ type: 'TEMPLATE', key: 'queryKey', value: 'gclid_v3' }] };
    const a = reg.ensureUniqueName('variable', 'URL - gclid', entityA);
    const b = reg.ensureUniqueName('variable', 'URL - gclid', entityB);
    const c = reg.ensureUniqueName('variable', 'URL - gclid', entityC);
    assert.equal(a.name, 'URL - gclid');
    assert.equal(b.name, 'URL - gclid (2)');
    assert.equal(c.name, 'URL - gclid (3)');
  });

  test('different kinds do not collide with each other', () => {
    const reg = new EntityRegistry();
    const v = reg.ensureUniqueName('variable', 'Purchase', { type: 'c' });
    const t = reg.ensureUniqueName('tag', 'Purchase', { type: 'html' });
    assert.equal(v.name, 'Purchase');
    assert.equal(t.name, 'Purchase');
  });

  test('getExisting returns the first-registered entity under a name', () => {
    const reg = new EntityRegistry();
    const entity = { type: 'c', parameter: [] };
    reg.ensureUniqueName('variable', 'ET - GA4 Measurement ID', entity);
    const existing = reg.getExisting('variable', 'ET - GA4 Measurement ID');
    assert.equal(existing.entity, entity);
  });
});

describe('EntityRegistry.register*', () => {
  test('registerVariable mutates entity.name to the final unique name', () => {
    const reg = new EntityRegistry();
    const v1 = { name: 'URL - gclid', type: 'u', parameter: [{ key: 'queryKey', value: 'gclid' }] };
    const v2 = { name: 'URL - gclid', type: 'u', parameter: [{ key: 'queryKey', value: 'DIFFERENT' }] };
    reg.registerVariable(v1);
    reg.registerVariable(v2);
    assert.equal(v1.name, 'URL - gclid');
    assert.equal(v2.name, 'URL - gclid (2)');
  });

  test('registerTag/registerTrigger/registerFolder/registerTemplate all enforce uniqueness', () => {
    const reg = new EntityRegistry();
    const tagA = { name: 'Meta CAPI - Purchase', type: 'html' };
    const tagB = { name: 'Meta CAPI - Purchase', type: 'html', notes: 'different' };
    reg.registerTag(tagA);
    reg.registerTag(tagB);
    assert.equal(tagA.name, 'Meta CAPI - Purchase');
    // notes is stripped from the config key, so tagB is treated as identical and reused.
    assert.equal(tagB.name, 'Meta CAPI - Purchase');

    const trigA = { name: 'All Events', type: 'CUSTOM_EVENT', customEventFilter: [{ x: 1 }] };
    const trigB = { name: 'All Events', type: 'CUSTOM_EVENT', customEventFilter: [{ x: 2 }] };
    reg.registerTrigger(trigA);
    reg.registerTrigger(trigB);
    assert.equal(trigB.name, 'All Events (2)');

    const folderA = { name: 'Ecommerce' };
    const folderB = { name: 'Ecommerce', description: 'x' };
    reg.registerFolder(folderA);
    reg.registerFolder(folderB);
    assert.equal(folderB.name, 'Ecommerce (2)');

    const tplA = { name: 'Universal HTTP Forwarder', templateData: 'AAA' };
    const tplB = { name: 'Universal HTTP Forwarder', templateData: 'BBB' };
    reg.registerTemplate(tplA);
    reg.registerTemplate(tplB);
    assert.equal(tplB.name, 'Universal HTTP Forwarder (2)');
  });

  test('registering an entity without a name throws', () => {
    const reg = new EntityRegistry();
    assert.throws(() => reg.registerVariable({ type: 'c' }), /missing a name/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateContainer
// ─────────────────────────────────────────────────────────────────────────────

function baseContainer(overrides) {
  return Object.assign({
    containerVersion: {
      variable: [],
      trigger: [],
      tag: [],
    },
  }, overrides);
}

describe('validateContainer', () => {
  test('flags duplicate variable names', () => {
    const container = baseContainer({
      containerVersion: {
        variable: [
          { name: 'URL - gclid', variableId: '1', type: 'u', parameter: [] },
          { name: 'URL - gclid', variableId: '2', type: 'u', parameter: [] },
        ],
        trigger: [],
        tag: [],
      },
    });
    const result = validateContainer(container);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('duplicate variable name: "URL - gclid"')));
  });

  test('flags duplicate trigger and tag names independently', () => {
    const container = baseContainer({
      containerVersion: {
        variable: [],
        trigger: [
          { name: 'All Pages', triggerId: '1', type: 'pageview' },
          { name: 'All Pages', triggerId: '2', type: 'pageview' },
        ],
        tag: [
          { name: 'GA4 Config', tagId: '1', type: 'gaawc', parameter: [] },
          { name: 'GA4 Config', tagId: '2', type: 'gaawc', parameter: [] },
        ],
      },
    });
    const result = validateContainer(container);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('duplicate trigger name: "All Pages"')));
    assert.ok(result.errors.some(e => e.includes('duplicate tag name: "GA4 Config"')));
  });

  test('flags a tag that fires on a trigger id that does not exist (orphan reference)', () => {
    const container = baseContainer({
      containerVersion: {
        variable: [],
        trigger: [{ name: 'All Pages', triggerId: '1', type: 'pageview' }],
        tag: [{ name: 'GA4 Config', tagId: '1', type: 'gaawc', parameter: [], firingTriggerId: ['999'] }],
      },
    });
    const result = validateContainer(container);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('unknown firingTriggerId "999"')));
  });

  test('does not flag the well-known "All Pages" built-in trigger id', () => {
    const container = baseContainer({
      containerVersion: {
        variable: [],
        trigger: [],
        tag: [{ name: 'Cookie Capture', tagId: '1', type: 'html', parameter: [], firingTriggerId: ['2147479553'] }],
      },
    });
    const result = validateContainer(container);
    assert.equal(result.valid, true);
  });

  test('warns on undeclared {{Variable}} references but keeps the container valid', () => {
    const container = baseContainer({
      containerVersion: {
        variable: [],
        trigger: [],
        tag: [{ name: 'GA4 Config', tagId: '1', type: 'gaawc', parameter: [{ type: 'TEMPLATE', key: 'measurementId', value: '{{Nonexistent Variable}}' }] }],
      },
    });
    const result = validateContainer(container);
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some(w => w.includes('undeclared variable "{{Nonexistent Variable}}"')));
  });

  test('warns on an orphan variable that no tag/trigger/variable references', () => {
    const container = baseContainer({
      containerVersion: {
        variable: [{ name: 'ET - Unused', variableId: '1', type: 'c', parameter: [] }],
        trigger: [],
        tag: [],
      },
    });
    const result = validateContainer(container);
    assert.ok(result.warnings.some(w => w.includes('"ET - Unused" is never referenced (orphan)')));
  });

  test('flags malformed entities (missing name / missing id)', () => {
    const container = baseContainer({
      containerVersion: {
        variable: [{ variableId: '1', type: 'c', parameter: [] }, { name: 'X', type: 'c', parameter: [] }],
        trigger: [],
        tag: [],
      },
    });
    const result = validateContainer(container);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('is missing a name')));
    assert.ok(result.errors.some(e => e.includes('"X" is missing variableId')));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// finalizeContainer — reproduces the reported bug patterns directly
// ─────────────────────────────────────────────────────────────────────────────

describe('finalizeContainer', () => {
  test('reproduces and fixes the reported bug: duplicate "URL - gclid" click-id variables', () => {
    const container = baseContainer({
      containerVersion: {
        variable: [
          { name: 'URL - gclid', variableId: '201', type: 'u', parameter: [{ type: 'TEMPLATE', key: 'component', value: 'QUERY' }, { type: 'TEMPLATE', key: 'queryKey', value: 'gclid' }] },
          { name: 'URL - fbclid', variableId: '202', type: 'u', parameter: [{ type: 'TEMPLATE', key: 'component', value: 'QUERY' }, { type: 'TEMPLATE', key: 'queryKey', value: 'fbclid' }] },
          // Duplicates injected by a second, redundant generation pass — identical config.
          { name: 'URL - gclid', variableId: '301', type: 'u', parameter: [{ type: 'TEMPLATE', key: 'component', value: 'QUERY' }, { type: 'TEMPLATE', key: 'queryKey', value: 'gclid' }] },
        ],
        trigger: [],
        tag: [],
      },
    });

    const { validation } = finalizeContainer(container);

    assert.equal(validation.duplicatesRemoved, 1);
    const preValidation = validateContainer(container);
    assert.equal(preValidation.valid, true);
    assert.equal(container.containerVersion.variable.length, 2);
    const names = container.containerVersion.variable.map(v => v.name);
    assert.deepEqual(names.sort(), ['URL - fbclid', 'URL - gclid']);
  });

  test('duplicate URL variables with DIFFERENT configs are renamed with a deterministic suffix', () => {
    const container = baseContainer({
      containerVersion: {
        variable: [
          { name: 'URL - gclid', variableId: '201', type: 'u', parameter: [{ type: 'TEMPLATE', key: 'queryKey', value: 'gclid' }] },
          { name: 'URL - gclid', variableId: '202', type: 'u', parameter: [{ type: 'TEMPLATE', key: 'queryKey', value: 'gclid_backup' }] },
        ],
        trigger: [],
        tag: [{ name: 'Uses second gclid var', tagId: '1', type: 'html', parameter: [{ type: 'TEMPLATE', key: 'html', value: '{{URL - gclid}}' }] }],
      },
    });

    const { validation } = finalizeContainer(container);
    const names = container.containerVersion.variable.map(v => v.name);
    assert.deepEqual(names, ['URL - gclid', 'URL - gclid (2)']);
    assert.equal(validation.duplicatesRemoved, 1);
    assert.ok(validation.warnings.some(w => w.includes('renamed to "URL - gclid (2)"')));

    const post = validateContainer(container);
    assert.equal(post.valid, true);
  });

  test('duplicate custom JS variables with identical bodies are deduped', () => {
    const jsBody = "function(){return {{ET - Cookie _ga}}.split('.').slice(-2).join('.');}";
    const container = baseContainer({
      containerVersion: {
        variable: [
          { name: 'ET - Cookie _ga', variableId: '1', type: 'k', parameter: [{ type: 'TEMPLATE', key: 'name', value: '_ga' }] },
          { name: 'ET - JS GA client_id', variableId: '2', type: 'jsm', parameter: [{ type: 'TEMPLATE', key: 'javascript', value: jsBody }] },
          { name: 'ET - JS GA client_id', variableId: '3', type: 'jsm', parameter: [{ type: 'TEMPLATE', key: 'javascript', value: jsBody }] },
        ],
        trigger: [],
        tag: [],
      },
    });
    const { validation } = finalizeContainer(container);
    assert.equal(validation.duplicatesRemoved, 1);
    assert.equal(container.containerVersion.variable.length, 2);
  });

  test('duplicate triggers are deduped and tag firingTriggerId is remapped to the survivor', () => {
    const container = baseContainer({
      containerVersion: {
        variable: [],
        trigger: [
          {
            name: 'ET - Event purchase', triggerId: '101', type: 'CUSTOM_EVENT',
            customEventFilter: [{ type: 'EQUALS', parameter: [{ type: 'TEMPLATE', key: 'arg0', value: '{{_event}}' }, { type: 'TEMPLATE', key: 'arg1', value: 'purchase' }] }],
          },
          {
            // Same logical trigger re-declared under the same name with identical filter.
            name: 'ET - Event purchase', triggerId: '102', type: 'CUSTOM_EVENT',
            customEventFilter: [{ type: 'EQUALS', parameter: [{ type: 'TEMPLATE', key: 'arg0', value: '{{_event}}' }, { type: 'TEMPLATE', key: 'arg1', value: 'purchase' }] }],
          },
        ],
        tag: [
          { name: 'GA4 Event - purchase', tagId: '1', type: 'gaawe', parameter: [], firingTriggerId: ['101'] },
          // This tag was built against the now-dropped duplicate trigger id.
          { name: 'Meta CAPI - Purchase', tagId: '2', type: 'html', parameter: [], firingTriggerId: ['102'] },
        ],
      },
    });

    const { validation } = finalizeContainer(container);
    assert.equal(validation.duplicatesRemoved, 1);
    assert.equal(container.containerVersion.trigger.length, 1);
    const survivorId = container.containerVersion.trigger[0].triggerId;
    container.containerVersion.tag.forEach(t => {
      assert.deepEqual(t.firingTriggerId, [survivorId]);
    });

    const post = validateContainer(container);
    assert.equal(post.valid, true);
  });

  test('a container with no duplicates is left untouched (idempotent)', () => {
    const container = baseContainer({
      containerVersion: {
        variable: [{ name: 'ET - GA4 Measurement ID', variableId: '1', type: 'c', parameter: [{ type: 'TEMPLATE', key: 'value', value: 'G-XXXX' }] }],
        trigger: [{ name: 'ET - All Pages', triggerId: '1', type: 'pageview' }],
        tag: [{ name: 'ET - GA4 Configuration', tagId: '1', type: 'gaawc', parameter: [{ type: 'TEMPLATE', key: 'measurementId', value: '{{ET - GA4 Measurement ID}}' }], firingTriggerId: ['1'] }],
      },
    });
    const { validation } = finalizeContainer(container);
    assert.equal(validation.duplicatesRemoved, 0);
    assert.equal(container.containerVersion.variable.length, 1);
    assert.equal(container.containerVersion.trigger.length, 1);
    assert.equal(container.containerVersion.tag.length, 1);
  });
});
