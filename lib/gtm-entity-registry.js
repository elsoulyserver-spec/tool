'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// gtm-entity-registry.js
//
// Enforces global name uniqueness across a single GTM container export
// (variables/macros, tags, triggers, folders, built-in variables, custom
// templates). GTM's "Import Container" rejects any file containing two
// entities of the same kind that share a name ("File format is invalid.
// Macros cannot have duplicate names.") — this module is the single place
// that guards against that class of bug.
//
// Two ways to use it:
//   1. Generation-time: call registry.registerVariable(entity) etc. as each
//      entity is built — it mutates entity.name to a guaranteed-unique name
//      before you push the entity onto your array. Always use the returned
//      entity.name (not the name you passed in) for any {{Name}} reference
//      you bake into other entities afterward. Note this only guarantees
//      *uniqueness*, not de-duplication: if you intend to skip pushing an
//      entity when an identical one already exists, call
//      registry.ensureUniqueName(kind, name, entity) directly and check
//      `.reused` before deciding whether to push.
//   2. Post-hoc safety net: call finalizeContainer(container) once the whole
//      containerVersion is assembled. It walks every entity list, drops
//      exact-config duplicates (reusing the surviving entity and remapping
//      any trigger-id references to it), renames genuine name collisions
//      with a deterministic " (2)", " (3)" suffix, rewrites any {{Name}}
//      references the rename affects, and returns a diagnostics block safe
//      to embed in the export. This is the path both generators use.
// ─────────────────────────────────────────────────────────────────────────────

const ENTITY_ID_KEYS = {
  variable:        'variableId',
  tag:             'tagId',
  trigger:         'triggerId',
  folder:          'folderId',
  builtInVariable: 'name', // built-in vars are keyed by type, no separate id
  template:        'templateId',
};

// Structural fingerprint of an entity's configuration, ignoring the
// identity/name fields so two entities with identical settings compare equal.
function configKey(entity) {
  const clone = Object.assign({}, entity);
  delete clone.name;
  delete clone.variableId;
  delete clone.tagId;
  delete clone.triggerId;
  delete clone.templateId;
  delete clone.folderId;
  delete clone.fingerprint;
  delete clone.accountId;
  delete clone.containerId;
  delete clone.path;
  delete clone.notes;
  return JSON.stringify(clone);
}

class EntityRegistry {
  constructor() {
    this._byKind = {};
    this.diagnostics = { duplicatesRemoved: 0, warnings: [] };
  }

  _bucket(kind) {
    if (!this._byKind[kind]) this._byKind[kind] = new Map();
    return this._byKind[kind];
  }

  // Returns the existing { name, configKey, entity } record for an exact
  // name match, or undefined. Mirrors the "getExisting()" entry point
  // requested for the registry's public API.
  getExisting(kind, name) {
    const list = this._bucket(kind).get(name);
    return list ? list[0] : undefined;
  }

  // Registers `entity` under `kind`/`entity.name`, resolving collisions:
  //   - No prior entity with this name       -> keep name as-is.
  //   - Prior entity, identical config        -> reuse: caller should DROP
  //                                              this entity and use the
  //                                              returned name/isDuplicate flag.
  //   - Prior entity, different config        -> append a deterministic
  //                                              " (2)", " (3)", ... suffix.
  // Returns { name, isDuplicate, reused } — `name` is always the final,
  // globally-unique name to assign to the entity.
  ensureUniqueName(kind, desiredName, entity) {
    const bucket = this._bucket(kind);
    const key = configKey(entity || {});

    if (!bucket.has(desiredName)) {
      bucket.set(desiredName, [{ name: desiredName, configKey: key, entity }]);
      return { name: desiredName, isDuplicate: false, reused: false };
    }

    const existingList = bucket.get(desiredName);
    const match = existingList.find(e => e.configKey === key);
    if (match) {
      this.diagnostics.duplicatesRemoved++;
      this.diagnostics.warnings.push(
        `${kind} "${desiredName}" duplicated with identical config — reused existing entity.`
      );
      return { name: match.name, isDuplicate: true, reused: true };
    }

    let n = 2;
    let candidate;
    do {
      candidate = `${desiredName} (${n})`;
      n++;
    } while (bucket.has(candidate));
    bucket.set(candidate, [{ name: candidate, configKey: key, entity }]);
    existingList.push({ name: candidate, configKey: key, entity });
    this.diagnostics.duplicatesRemoved++;
    this.diagnostics.warnings.push(
      `${kind} "${desiredName}" had a conflicting definition — renamed to "${candidate}". Review references manually.`
    );
    return { name: candidate, isDuplicate: true, reused: false };
  }

  _registerGeneric(kind, entity) {
    if (!entity || !entity.name) {
      throw new Error(`EntityRegistry: entity of kind "${kind}" is missing a name`);
    }
    const result = this.ensureUniqueName(kind, entity.name, entity);
    entity.name = result.name;
    return entity;
  }

  registerVariable(entity)        { return this._registerGeneric('variable', entity); }
  registerTag(entity)             { return this._registerGeneric('tag', entity); }
  registerTrigger(entity)         { return this._registerGeneric('trigger', entity); }
  registerFolder(entity)          { return this._registerGeneric('folder', entity); }
  registerTemplate(entity)        { return this._registerGeneric('template', entity); }
  registerBuiltInVariable(entity) { return this._registerGeneric('builtInVariable', entity); }
}

// ─────────────────────────────────────────────────────────────────────────────
// {{Variable Name}} reference scanning helpers
// ─────────────────────────────────────────────────────────────────────────────

const REF_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

function scanRefsInString(str, cb) {
  if (typeof str !== 'string') return;
  REF_PATTERN.lastIndex = 0;
  let m;
  while ((m = REF_PATTERN.exec(str))) cb(m[1].trim());
}

function walkParamValues(params, cb) {
  (params || []).forEach(p => {
    if (!p) return;
    if (typeof p.value === 'string') cb(p.value, p);
    if (Array.isArray(p.list)) {
      p.list.forEach(item => walkParamValues(item.map || [item], cb));
    }
    if (Array.isArray(p.map)) walkParamValues(p.map, cb);
  });
}

function rewriteParamValues(params, oldName, newName) {
  const token = `{{${oldName}}}`;
  const replacement = `{{${newName}}}`;
  (params || []).forEach(p => {
    if (!p) return;
    if (typeof p.value === 'string' && p.value.indexOf(token) !== -1) {
      p.value = p.value.split(token).join(replacement);
    }
    if (Array.isArray(p.list)) p.list.forEach(item => rewriteParamValues(item.map || [item], oldName, newName));
    if (Array.isArray(p.map)) rewriteParamValues(p.map, oldName, newName);
  });
}

// Rewrites {{oldName}} -> {{newName}} across an entity's tag/variable
// parameter list AND its trigger filter conditions (customEventFilter/filter),
// which live outside `.parameter` but carry the same {{Name}} token syntax.
function rewriteEntityRefs(entity, oldName, newName) {
  rewriteParamValues(entity.parameter, oldName, newName);
  (entity.customEventFilter || []).forEach(f => rewriteParamValues(f.parameter, oldName, newName));
  (entity.filter || []).forEach(f => rewriteParamValues(f.parameter, oldName, newName));
}

// ─────────────────────────────────────────────────────────────────────────────
// validateContainer — pre-export validation pass.
// Checks duplicate names, invalid trigger/variable references, orphan
// variables, and malformed entity objects. Never mutates the container.
// ─────────────────────────────────────────────────────────────────────────────

// GTM built-in trigger IDs / built-in variable names referenced by convention
// (e.g. the numeric "All Pages" pageview trigger, {{Client IP}}, {{_event}}).
// These are not declared entities in the export, so reference checks must not
// flag them.
const BUILTIN_TRIGGER_IDS = new Set(['2147479553']);
const BUILTIN_VAR_PREFIX = '_'; // {{_event}}, {{_url}}, etc.

function validateContainer(container) {
  const errors = [];
  const warnings = [];
  const cv = (container && container.containerVersion) || container || {};

  const variables = Array.isArray(cv.variable) ? cv.variable : [];
  const triggers  = Array.isArray(cv.trigger)  ? cv.trigger  : [];
  const tags      = Array.isArray(cv.tag)      ? cv.tag      : [];
  const folders   = Array.isArray(cv.folder)   ? cv.folder   : [];
  const builtIns  = Array.isArray(cv.builtInVariable) ? cv.builtInVariable : [];
  const templates = Array.isArray(cv.customTemplate)  ? cv.customTemplate  : [];

  function checkList(list, kind, idKey) {
    const seen = new Set();
    list.forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`malformed ${kind} entity at index ${i}`);
        return;
      }
      if (!item.name || typeof item.name !== 'string') {
        errors.push(`${kind} at index ${i} is missing a name`);
        return;
      }
      if (idKey && item[idKey] == null) {
        errors.push(`${kind} "${item.name}" is missing ${idKey}`);
      }
      if (seen.has(item.name)) {
        errors.push(`duplicate ${kind} name: "${item.name}"`);
      }
      seen.add(item.name);
    });
    return seen;
  }

  const varNames = checkList(variables, 'variable', 'variableId');
  checkList(triggers, 'trigger', 'triggerId');
  checkList(tags, 'tag', 'tagId');
  checkList(folders, 'folder', 'folderId');
  checkList(templates, 'template', 'templateId');
  checkList(builtIns, 'builtInVariable', null);

  // Invalid trigger references from tags (firingTriggerId / blockingTriggerId).
  const trigIds = new Set(triggers.map(t => t && t.triggerId != null ? String(t.triggerId) : null).filter(Boolean));
  tags.forEach((t, i) => {
    const label = `tag "${(t && t.name) || i}"`;
    ['firingTriggerId', 'blockingTriggerId'].forEach(key => {
      (t && t[key] || []).forEach(tid => {
        if (!trigIds.has(String(tid)) && !BUILTIN_TRIGGER_IDS.has(String(tid))) {
          errors.push(`${label} references unknown ${key} "${tid}"`);
        }
      });
    });
  });

  // {{Variable}} references must resolve to a declared variable (or a
  // recognized GTM built-in, which we can't fully enumerate — anything
  // prefixed with "_" is treated as a built-in and skipped).
  function checkRefs(list, kindLabel) {
    list.forEach(entity => {
      const label = `${kindLabel} "${entity.name}"`;
      walkParamValues(entity.parameter, value => {
        scanRefsInString(value, ref => {
          if (ref.charAt(0) === BUILTIN_VAR_PREFIX) return;
          if (!varNames.has(ref)) {
            warnings.push(`${label} references undeclared variable "{{${ref}}}"`);
          }
        });
      });
    });
  }
  checkRefs(variables, 'variable');
  checkRefs(tags, 'tag');

  // Orphan detection — variables never referenced anywhere in the container.
  const referenced = new Set();
  function markRefs(list) {
    list.forEach(entity => {
      walkParamValues(entity.parameter, value => {
        scanRefsInString(value, ref => referenced.add(ref));
      });
      (entity.customEventFilter || []).forEach(f => walkParamValues(f.parameter, v => scanRefsInString(v, ref => referenced.add(ref))));
      (entity.filter || []).forEach(f => walkParamValues(f.parameter, v => scanRefsInString(v, ref => referenced.add(ref))));
    });
  }
  markRefs(variables);
  markRefs(tags);
  markRefs(triggers);

  variables.forEach(v => {
    if (!referenced.has(v.name)) {
      warnings.push(`variable "${v.name}" is never referenced (orphan)`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    counts: {
      variables: variables.length,
      tags: tags.length,
      triggers: triggers.length,
      folders: folders.length,
      templates: templates.length,
      builtInVariables: builtIns.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// finalizeContainer — post-hoc dedup safety net.
// Mutates the given container in place: drops exact-duplicate entities
// (rewriting any trigger-id references to the surviving entity), renames
// genuine name collisions with a deterministic suffix (rewriting any
// {{Name}} references so the export stays internally consistent), then runs
// validateContainer() and returns verbose diagnostics.
// ─────────────────────────────────────────────────────────────────────────────

function dedupeList(list, kind, registry) {
  const kept = [];
  const idMap = {};    // removed id -> surviving id (only populated for exact-dup reuse)
  const renames = [];  // [{ from, to }] (only populated for genuine collisions)
  const idKey = ENTITY_ID_KEYS[kind];

  list.forEach(entity => {
    const originalName = entity.name;
    const result = registry.ensureUniqueName(kind, originalName, entity);

    if (result.reused) {
      const existing = registry.getExisting(kind, result.name);
      if (idKey && idKey !== 'name' && entity[idKey] != null && existing && existing.entity[idKey] != null) {
        idMap[String(entity[idKey])] = String(existing.entity[idKey]);
      }
      return; // drop — reuse the surviving entity
    }

    if (result.isDuplicate && result.name !== originalName) {
      entity.name = result.name;
      renames.push({ from: originalName, to: result.name });
    }
    kept.push(entity);
  });

  return { kept, idMap, renames };
}

function finalizeContainer(container) {
  const registry = new EntityRegistry();
  const cv = (container && container.containerVersion) || container || {};

  const before = {
    variables: Array.isArray(cv.variable) ? cv.variable.length : 0,
    tags:      Array.isArray(cv.tag)      ? cv.tag.length      : 0,
    triggers:  Array.isArray(cv.trigger)  ? cv.trigger.length  : 0,
  };

  let renamedVariables = []; // [{ from, to }]

  if (Array.isArray(cv.variable)) {
    const result = dedupeList(cv.variable, 'variable', registry);
    cv.variable = result.kept;
    renamedVariables = result.renames;
  }

  let triggerIdMap = {};
  if (Array.isArray(cv.trigger)) {
    const result = dedupeList(cv.trigger, 'trigger', registry);
    cv.trigger = result.kept;
    triggerIdMap = result.idMap;
  }

  if (Array.isArray(cv.tag)) {
    const result = dedupeList(cv.tag, 'tag', registry);
    cv.tag = result.kept;
  }

  if (Array.isArray(cv.folder)) {
    cv.folder = dedupeList(cv.folder, 'folder', registry).kept;
  }

  if (Array.isArray(cv.customTemplate)) {
    cv.customTemplate = dedupeList(cv.customTemplate, 'template', registry).kept;
  }

  if (Array.isArray(cv.builtInVariable)) {
    cv.builtInVariable = dedupeList(cv.builtInVariable, 'builtInVariable', registry).kept;
  }

  // Rewrite firingTriggerId/blockingTriggerId for any triggers that were
  // dropped as exact duplicates, so tags keep pointing at a live trigger.
  if (Object.keys(triggerIdMap).length && Array.isArray(cv.tag)) {
    cv.tag.forEach(t => {
      ['firingTriggerId', 'blockingTriggerId'].forEach(key => {
        if (Array.isArray(t[key])) {
          t[key] = t[key].map(id => triggerIdMap[String(id)] || id);
        }
      });
    });
  }

  // Rewrite {{OldName}} -> {{NewName}} for any variables that were renamed
  // due to a genuine (non-identical) collision.
  if (renamedVariables.length) {
    const allEntities = [].concat(cv.variable || [], cv.tag || [], cv.trigger || []);
    renamedVariables.forEach(({ from, to }) => {
      allEntities.forEach(e => rewriteEntityRefs(e, from, to));
    });
  }

  const validation = validateContainer(container);

  return {
    container,
    validation: {
      duplicatesRemoved: registry.diagnostics.duplicatesRemoved,
      variablesCreated:  before.variables,
      tagsCreated:       before.tags,
      triggersCreated:   before.triggers,
      warnings: registry.diagnostics.warnings.concat(validation.warnings),
      errors: validation.errors,
      valid: validation.valid,
    },
  };
}

module.exports = { EntityRegistry, validateContainer, finalizeContainer };
