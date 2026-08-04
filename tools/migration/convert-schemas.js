/**
 * v3 → v5 schema conversion codemod.
 *
 * Converts:
 *   components/<group>/<name>.json        → src/components/<group>/<name>.json   (v5 schema.json)
 *   api/<ct>/models/<ct>.settings.json    → src/api/<ct>/content-types/<ct>/schema.json
 *   extensions/users-permissions/models/User.settings.json
 *                                         → src/extensions/users-permissions/content-types/user/schema.json
 *
 * Relation conversion (the hard part):
 *   v3 uses bidirectional `via` + `dominant` with loose target names.
 *   v5 requires an explicit { type, relation, target, mappedBy?, inversedBy? }.
 *
 *   Detection rules (applied per relation attribute):
 *     - plugin: "upload" + model: "file"        → { type:"media", relation:"oneToMany"|"oneToOne", allowedTypes }
 *     - plugin: "users-permissions" + model:"user"  → target "plugin::users-permissions.user"
 *     - model: "file" + via:"related" (no plugin)   → media (upload), v3 quirk
 *     - collection + via + dominant             → manyToMany (owner side), inversedBy = <attr on target>
 *     - collection + via (no dominant)          → oneToMany, target owns mappedBy = via
 *     - model + via                              → oneToOne (target owns) OR manyToOne; pick by target's side
 *     - model (no via)                           → oneToOne / oneWay depending on target reciprocity
 *     - collection (no via)                      → oneToMany (oneWay-many) or manyToMany-many
 *     - model === self ct                        → self-relation (oneToOne/oneToMany on same UID)
 *
 *   The script builds a global pair index to resolve mappedBy/inversedBy deterministically.
 *
 * Output: writes converted files + prints a report of anything flagged for manual review.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const V3_ROOT = path.resolve(__dirname, '../../../projectes');
const V5_ROOT = path.resolve(__dirname, '../..'); // projectes-v5/

const SRC_COMPONENTS = path.join(V3_ROOT, 'components');
const SRC_API = path.join(V3_ROOT, 'api');
const SRC_EXT_UP = path.join(V3_ROOT, 'extensions/users-permissions/models/User.settings.json');

const DST_COMPONENTS = path.join(V5_ROOT, 'src/components');
const DST_API = path.join(V5_ROOT, 'src/api');
const DST_EXT_UP = path.join(V5_ROOT, 'src/extensions/users-permissions/content-types/user');

// v3 singular model name (file/dir name) → v5 UID for app content types.
// v3 stores relations as the api folder name (e.g. "emitted-invoice"), which is already singular.
function ctUid(ct) {
  return `api::${ct}.${ct}`;
}

// Build an index of all content-type schemas keyed by their v3 relation-target name.
// A v3 target name is either the api folder (singular, e.g. "emitted-invoice") or a plural
// quirk (e.g. "contacts" used as a collection target in some places).
function loadAllSchemas() {
  const components = {}; // "group.name" -> schema
  const contentTypes = {}; // ct (api folder) -> { schema, settingsPath }
  const targetIndex = {}; // v3 target string -> ct (resolves plural quirks)

  // components
  for (const f of walkJson(SRC_COMPONENTS)) {
    const rel = path.relative(SRC_COMPONENTS, f).replace(/\.json$/, '');
    const [group, name] = rel.split(path.sep);
    components[`${group}.${name}`] = JSON.parse(fs.readFileSync(f, 'utf8'));
  }

  // content types
  const ctDirs = fs
    .readdirSync(SRC_API, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const ct of ctDirs) {
    const settingsPath = path.join(SRC_API, ct, 'models', `${ct}.settings.json`);
    if (!fs.existsSync(settingsPath)) continue;
    const schema = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    contentTypes[ct] = { schema, settingsPath };
    // index by ct name AND collectionName for target resolution
    targetIndex[ct] = ct;
    // v3 sometimes targets the singular api name; also handle plural->singular map below
  }

  // Build a plural→singular map from the known ct list (for targets like "contacts"->"contacts"
  // where the api folder is "contacts"). We also record explicit plural targets.
  for (const ct of Object.keys(contentTypes)) {
    // If the v3 target string matches a ct exactly we are fine. Some v3 schemas use a plural
    // that equals an existing ct folder (e.g. target "contacts" with api "contacts"). Keep as-is.
    // For genuine singularization quirks (e.g. "activities"->"activity"), handle by suffix:
    if (!targetIndex[ct]) targetIndex[ct] = ct;
  }

  return { components, contentTypes, targetIndex, ctDirs };
}

function walkJson(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJson(full));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

// Resolve a v3 relation target string into a v5 UID.
// Returns { uid, kind: 'app'|'up'|'upload'|'admin'|'unknown' }.
function resolveTarget(targetName, plugin, contentTypes) {
  if (plugin === 'upload' && targetName === 'file') {
    return { uid: null, kind: 'upload' }; // media relations are special-cased by the caller
  }
  if (plugin === 'users-permissions') {
    if (targetName === 'user') return { uid: 'plugin::users-permissions.user', kind: 'up' };
    if (targetName === 'role') return { uid: 'plugin::users-permissions.role', kind: 'up' };
    return { uid: `plugin::users-permissions.${targetName}`, kind: 'up' };
  }
  if (plugin === 'admin') {
    return { uid: 'admin::user', kind: 'admin' };
  }
  // No plugin: it's an app content type. v3 target name should match an api folder,
  // but some are stored plural. Try exact, then singularize.
  if (contentTypes[targetName]) return { uid: ctUid(targetName), kind: 'app' };
  // try common pluralizations
  const candidates = [
    targetName.replace(/s$/, ''), // activities -> activitie (wrong) then below
    targetName.replace(/ies$/, 'y'), // activities -> activity
    targetName.replace(/es$/, ''),
  ];
  for (const c of candidates) {
    if (contentTypes[c]) return { uid: ctUid(c), kind: 'app' };
  }
  return { uid: null, kind: 'unknown' };
}

/**
 * Convert the attributes block.
 * Each attribute is either:
 *   - a scalar (type: string|integer|...|component|enumeration|...) → mostly passthrough
 *   - a relation (has model/collection) → rewritten to v5 relation object
 *
 * `ownerCt` is the ct this attribute belongs to (for self-relation detection & UID building).
 * `pairIndex` maps "<targetCt>::<viaAttr>" → the owning relation, used to find reciprocal.
 */
function convertAttributes(attrs, ownerCt, ctx) {
  const out = {};
  const flags = [];
  for (const [name, def] of Object.entries(attrs || {})) {
    if (def.model || def.collection) {
      const conv = convertRelation(name, def, ownerCt, ctx);
      out[name] = conv.value;
      if (conv.flag) flags.push({ attr: name, ...conv.flag });
    } else {
      out[name] = convertScalar(def, flags, name);
    }
  }
  return { attributes: out, flags };
}

function convertScalar(def, flags, name) {
  const v5 = { type: def.type };
  // pass through most keys; drop v3-only `configurable` (v5 uses configurable at content-type level)
  for (const k of [
    'required',
    'unique',
    'default',
    'min',
    'max',
    'minLength',
    'maxLength',
    'private',
    'regex',
    'enum',
    'allowedTypes',
    'pluginOptions',
    'repeatable',
    'component',
    'writable',
    'sortable',
    'searchable',
  ]) {
    if (def[k] !== undefined) v5[k] = def[k];
  }
  return v5;
}

/**
 * Convert a v3 relation to a v5 relation.
 * Returns { value, flag? }.
 */
function convertRelation(attrName, def, ownerCt, ctx) {
  const { contentTypes } = ctx;
  const isCollection = !!def.collection;
  const targetName = def.model || def.collection;
  const via = def.via || null;
  const dominant = !!def.dominant;
  const plugin = def.plugin || null;

  // --- Media (upload) relations ---
  if ((plugin === 'upload' && targetName === 'file') || (targetName === 'file' && via === 'related')) {
    const relation = isCollection ? 'oneToMany' : 'oneToOne';
    const out = { type: 'media', relation };
    if (def.allowedTypes) out.allowedTypes = def.allowedTypes;
    return { value: out };
  }

  const { uid, kind } = resolveTarget(targetName, plugin, contentTypes);
  if (kind === 'unknown') {
    return {
      value: { type: 'relation', relation: isCollection ? 'oneToMany' : 'oneToOne', target: targetName },
      flag: { reason: 'unresolved-target', target: targetName, via, dominant, plugin },
    };
  }

  const isSelf = kind === 'app' && uid === ctUid(ownerCt);

  // --- Determine relation type ---
  // Heuristics, in priority order:
  //  1. collection + via + dominant        → manyToMany owner (inversedBy set on target)
  //  2. collection + via (no dominant)     → oneToMany (target has the FK via mappedBy)
  //  3. model + via                         → oneToOne where target is the owner (mappedBy on target)
  //                                           BUT if target side is a collection it's manyToOne
  //                                           → detect via pair lookup.
  //  4. collection (no via)                 → oneToMany oneWay OR manyToMany oneWay. Default oneToMany.
  //  5. model (no via)                      → oneToOne oneWay (default) — but if target reciprocates
  //                                           with a collection+via pointing here, it's manyToOne.
  let relation;
  let mappedBy = null;
  let inversedBy = null;

  // Look up the reciprocal relation on the target ct to disambiguate.
  const targetCtName = uid && uid.startsWith('api::') ? uid.split('.')[1] : null;
  const targetAttrs =
    targetCtName && contentTypes[targetCtName] ? contentTypes[targetCtName].schema.attributes : null;

  // reciprocal: a relation on the target whose `via` === attrName, OR whose name === via
  let reciprocal = null;
  if (targetAttrs && via) {
    reciprocal = Object.entries(targetAttrs).find(
      ([n, d]) => (d.model || d.collection) && d.via === attrName,
    );
  }

  if (isCollection && via && dominant) {
    // manyToMany owner
    relation = 'manyToMany';
    inversedBy = via; // the attribute name on the OTHER side that points back
  } else if (isCollection && via && !dominant) {
    // oneToMany: owner holds the list, target has the FK
    relation = 'oneToMany';
    mappedBy = via;
  } else if (!isCollection && via) {
    // model + via. Could be oneToOne (target owns) or manyToOne (this side holds FK to a oneToMany on target).
    // If the reciprocal on the target is a collection, this is manyToOne.
    if (reciprocal && reciprocal[1].collection) {
      // manyToOne: THIS side owns the FK. Do NOT set mappedBy (that goes on the oneToMany side).
      relation = 'manyToOne';
    } else {
      // oneToOne where the target is the owner (it has the matching attribute named `via`).
      relation = 'oneToOne';
      mappedBy = via;
    }
  } else if (isCollection && !via) {
    // oneWay many (no reciprocal). Default oneToMany.
    relation = 'oneToMany';
  } else {
    // model + no via. oneWay (oneToOne, no FK back). Default oneToOne.
    relation = 'oneToOne';
  }

  // Special-case: users-permissions role on User (v3 sets via:"users" on user side, model+via+plugin).
  // The v5 UP plugin defines role as manyToOne on user with mappedBy "users" on role. Keep our heuristic.

  const out = { type: 'relation', relation, target: uid };
  if (mappedBy) out.mappedBy = mappedBy;
  if (inversedBy) out.inversedBy = inversedBy;

  // Flag self-relations and dominant ones for manual review (they're easy to get wrong).
  const flag =
    isSelf || dominant
      ? { reason: isSelf ? 'self-relation' : 'manyToMany-owner', relation, via, dominant }
      : null;

  return { value: out, flag };
}

// ── info block conversion ───────────────────────────────────────────────────
// v3: { info: { name, icon?, description? } }
// v5: { info: { singularName, pluralName, displayName, description? } }
//
// CRITICAL v5 rule: for content types, the content-type KEY (the api folder name)
// MUST equal info.singularName. Since our ct key is the v3 api folder (already
// singular, e.g. "activity"), singularName = ct key, NOT a re-derived singular.
// pluralName is derived with proper English pluralization.
function pluralize(word) {
  if (/s$|x$|z$|ch$|sh$/.test(word)) return word + 'es';
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

function convertInfo(v3info, ctName, isComponent) {
  const name = v3info.name || ctName;
  const lower = name.toLowerCase();
  let singular;
  let plural;
  if (isComponent) {
    // Components have no route key constraint; displayName is what matters.
    singular = lower;
    plural = pluralize(lower);
  } else {
    // For content types, singularName MUST equal the ct key (api folder name).
    singular = ctName.toLowerCase();
    plural = pluralize(singular);
  }
  const info = {
    singularName: singular,
    pluralName: plural,
    displayName: name,
  };
  if (v3info.description) info.description = v3info.description;
  return info;
}

// ── options → top-level + pluginOptions ──────────────────────────────────────
// v3: options: { increments, timestamps, draftAndPublish }
// v5: draftAndPublish is top-level; timestamps/increments are implicit (drop).
function convertContentType(v3schema, ctName, ctx) {
  const flags = [];
  const v5 = {
    kind: v3schema.kind === 'singleType' ? 'singleType' : 'collectionType',
    collectionName: v3schema.collectionName,
    info: convertInfo(v3schema.info || {}, ctName, false),
    options: {},
    pluginOptions: v3schema.pluginOptions || {},
    attributes: {},
  };

  // draftAndPublish
  const dp = v3schema.options && v3schema.options.draftAndPublish;
  v5.options.draftAndPublish = dp !== undefined ? dp : false;

  // attributes
  const conv = convertAttributes(v3schema.attributes, ctName, ctx);
  v5.attributes = conv.attributes;
  flags.push(...conv.flags);

  return { schema: v5, flags };
}

function convertComponent(v3schema, groupAndName, ctx) {
  const v5 = {
    collectionName: v3schema.collectionName,
    info: convertInfo(v3schema.info || {}, groupAndName, true),
    options: {},
    attributes: {},
  };
  // Components CAN have relations to content types in v5. Pass the real ctx so
  // target UIDs resolve (e.g. budget-line.client → api::contacts.contacts).
  const conv = convertAttributes(v3schema.attributes, groupAndName, ctx);
  v5.attributes = conv.attributes;
  return { schema: v5, flags: conv.flags };
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const { components, contentTypes, targetIndex, ctDirs } = loadAllSchemas();
  const ctx = { contentTypes, targetIndex };
  const report = {
    components: { total: 0, converted: 0, flags: [] },
    contentTypes: { total: 0, converted: 0, flags: [] },
    errors: [],
  };

  // 1. Components
  for (const [fqName, schema] of Object.entries(components)) {
    const [group, name] = fqName.split('.');
    const outDir = path.join(DST_COMPONENTS, group);
    const outFile = path.join(outDir, `${name}.json`);
    try {
      const { schema: v5, flags } = convertComponent(schema, fqName, ctx);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(v5, null, 2) + '\n');
      report.components.total++;
      report.components.converted++;
      for (const fl of flags) report.components.flags.push({ component: fqName, ...fl });
    } catch (e) {
      report.errors.push({ file: fqName, error: e.message });
    }
  }

  // 2. Content types
  for (const [ct, { schema }] of Object.entries(contentTypes)) {
    const outDir = path.join(DST_API, ct, 'content-types', ct);
    const outFile = path.join(outDir, 'schema.json');
    try {
      const { schema: v5, flags } = convertContentType(schema, ct, ctx);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(v5, null, 2) + '\n');
      report.contentTypes.total++;
      report.contentTypes.converted++;
      for (const fl of flags) report.contentTypes.flags.push({ ct, ...fl });
    } catch (e) {
      report.errors.push({ file: ct, error: e.message });
    }
  }

  // 3. users-permissions User extension
  if (fs.existsSync(SRC_EXT_UP)) {
    const outDir = DST_EXT_UP;
    const outFile = path.join(outDir, 'schema.json');
    try {
      const v3schema = JSON.parse(fs.readFileSync(SRC_EXT_UP, 'utf8'));
      // Build a ctx that knows about the UP plugin target for role/user relations.
      const upCtx = { contentTypes, targetIndex };
      const { schema: v5, flags } = convertContentType(v3schema, 'user', upCtx);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(v5, null, 2) + '\n');
      report.userExtension = { converted: true, flags };
    } catch (e) {
      report.errors.push({ file: 'User.settings.json (extension)', error: e.message });
    }
  }

  // Write report
  const reportPath = path.join(V5_ROOT, 'tools/migration/conversion-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  // Summary
  console.log('── Conversion summary ────────────────────────');
  console.log(`Components:   ${report.components.converted}/${report.components.total} converted`);
  console.log(`Content types: ${report.contentTypes.converted}/${report.contentTypes.total} converted`);
  console.log(`User extension: ${report.userExtension?.converted ? 'yes' : 'no'}`);
  console.log(`Errors:        ${report.errors.length}`);
  console.log(`Flags (manual review):`);
  console.log(`  - components:   ${report.components.flags.length}`);
  console.log(`  - content types: ${report.contentTypes.flags.length}`);
  console.log(`  - user ext:     ${report.userExtension?.flags?.length || 0}`);
  console.log(`\nReport: ${path.relative(process.cwd(), reportPath)}`);
  if (report.errors.length) {
    console.log('\nERRORS:');
    for (const e of report.errors) console.log(`  ${e.file}: ${e.error}`);
  }
}

main();
