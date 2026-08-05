/**
 * Generate v5 core controllers, core services, and custom route files for all
 * 76 content types, ported from the v3 api/<ct>/config/routes.json.
 *
 * v5 idioms:
 *   - src/api/<ct>/controllers/<ct>.js  → createCoreController('api::<ct>.<ct>')
 *     (gives find/findOne/create/update/delete + count out of the box)
 *   - src/api/<ct>/services/<ct>.js     → createCoreService('api::<ct>.<ct>')
 *   - src/api/<ct>/routes/<ct>.js       → createCoreRouter('api::<ct>.<ct>')
 *     (auto-registers the standard CRUD routes at /api/<plural>)
 *   - src/api/<ct>/routes/custom-<ct>.js → custom (non-CRUD) routes, one per entry,
 *     each pointing to a controller method that throws "not yet ported (Phase 4)".
 *
 * Custom route paths are namespaced under /api/<plural>/... in v5 automatically.
 * Policies (global::isAdmin, plugins::users-permissions.isAuthenticated) are
 * preserved; the v5 policy reference for isAuthenticated is 'users-permissions.isAuthenticated'.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const V3_ROOT = path.resolve(__dirname, '../../../projectes');
const SRC_API = path.resolve(__dirname, '../../src/api');

const CORE_ACTIONS = new Set(['find', 'findOne', 'create', 'update', 'delete', 'count']);

// JS reserved words that can't be used as method names. Map them to a safe alias.
// (Custom actions only — core delete is handled by createCoreController, never stubbed.)
const RESERVED_ALIAS = {
  import: 'importData',
  class: 'classAction',
  export: 'exportData',
  return: 'returnAction',
  new: 'newAction',
};
function safeActionName(action) {
  return RESERVED_ALIAS[action] || action;
}

// Singularize the last hyphen-segment of a v3 api folder, matching the schema codemod's
// ctSingular() so folders/UIDs align (v3 "bank-accounts" -> v5 "bank-account").
function singularizeWord(word) {
  if (/ies$/.test(word) && word.length > 3) return word.slice(0, -3) + 'y';
  if (/ses$|xes$|zes$|ches$|shes$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}
function ctSingular(folder) {
  const parts = folder.split('-');
  parts[parts.length - 1] = singularizeWord(parts[parts.length - 1]);
  return parts.join('-');
}

// v5 path prefix is the pluralName from the schema. Schema lives at the singular folder.
function loadSchema(singular) {
  const p = path.join(SRC_API, singular, 'content-types', singular, 'schema.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadV3Routes(ct) {
  const p = path.join(V3_ROOT, 'api', ct, 'config', 'routes.json');
  if (!fs.existsSync(p)) return [];
  try {
    return require(p).routes || [];
  } catch {
    return [];
  }
}

// Convert a v3 policy reference to its v5 equivalent.
function convertPolicy(pol, ct) {
  if (pol === 'global::isAdmin') return 'global::isAdmin';
  if (pol === 'plugins::users-permissions.isAuthenticated') {
    return 'users-permissions.isAuthenticated';
  }
  return pol; // pass through anything else for manual review
}

function generateController(ct) {
  return `'use strict';

/**
 * ${ct} controller (v5). Core CRUD is provided by createCoreController.
 * Custom methods ported in Phase 4 are added below as needed.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::${ct}.${ct}', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
  // Add custom controller methods here as they are ported in Phase 4.
}));
`;
}

function generateService(ct) {
  return `'use strict';

/**
 * ${ct} service (v5). Core service methods provided by createCoreService.
 */
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::${ct}.${ct}', ({ strapi }) => ({
  // Default core service methods are inherited.
  // Add custom service logic here as it is ported in Phase 4.
}));
`;
}

function generateCoreRouter(ct, v3Routes) {
  // Collect v3 policies on CORE actions (find/findOne/create/update/delete/count)
  // so admin-gated writes are preserved (e.g. verifactu PUT/DELETE -> global::isAdmin).
  const corePolicies = {};
  for (const r of v3Routes) {
    const action = (r.handler || '').split('.')[1];
    if (!CORE_ACTIONS.has(action)) continue;
    const policies = r.config && r.config.policies;
    if (Array.isArray(policies) && policies.length) {
      corePolicies[action] = {
        policies: policies.map((p) => `'${convertPolicy(p, ct)}'`).join(', '),
      };
    }
  }
  const configArg =
    Object.keys(corePolicies).length === 0
      ? ''
      : `, {\n  config: {\n${Object.entries(corePolicies)
          .map(([a, c]) => `    ${a}: { policies: [${c.policies}] },`)
          .join('\n')}\n  },\n}`;

  return `'use strict';

/**
 * ${ct} core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/custom-${ct}.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::${ct}.${ct}'${configArg});
`;
}

// Generate the custom routes file for a CT, based on the v3 non-CRUD routes.
// Returns null if the CT has no custom routes.
function generateCustomRoutes(singular, v3ct, v3Routes, plural) {
  const custom = v3Routes.filter((r) => {
    const action = (r.handler || '').split('.')[1];
    return !CORE_ACTIONS.has(action);
  });
  if (custom.length === 0) return null;

  // The controller must declare each custom handler; for now they throw a clear
  // "not yet ported" error so the route is registered but the logic lands in Phase 4.
  const routeEntries = custom
    .map((r) => {
      const action = (r.handler || '').split('.')[1];
      // strip the leading "/<plural>" from v3 path to get the relative suffix,
      // but keep it if it doesn't match (safer). v5 will namespace under /api/<plural>.
      const v5Path = relativizePath(r.path, plural);
      const policies = (r.config && r.config.policies ? r.config.policies : [])
        .map((p) => `'${convertPolicy(p, singular)}'`)
        .join(', ');
      const config = policies ? `, config: { policies: [${policies}] }` : '';
      return `    {
      method: '${r.method}',
      path: '${v5Path}',
      handler: '${singular}.${safeActionName(action)}'${config},
    }`;
    })
    .join(',\n');

  return `'use strict';

/**
 * ${singular} CUSTOM routes (v5). Ported from v3 api/${v3ct}/config/routes.json.
 * These are the ${custom.length} non-CRUD endpoints; their handlers are stubbed
 * and throw "not yet ported" until Phase 4 ports each controller method.
 *
 * v5 namespaces these under /api/${plural} automatically.
 */
module.exports = {
  routes: [
${routeEntries},
  ],
};
`;
}

// v3 path like "/orders/table" → v5 relative "table" (the core router mounts at /api/orders).
// v3 path like "/orders/:id" is a core route (handled by core router, not here).
function relativizePath(v3Path, plural) {
  // strip leading slash + plural
  let p = v3Path.replace(/^\/+/, '');
  // the v3 plural may be the collectionName-based path; remove it if it prefixes.
  const prefixes = [plural, plural.replace(/s$/, '')];
  for (const pre of prefixes) {
    if (p === pre) return '/';
    if (p.startsWith(pre + '/')) return p.slice(pre.length);
  }
  // fallback: keep as-is but ensure leading slash
  return p.startsWith('/') ? p : '/' + p;
}

function generateCustomControllerMethods(singular, v3ct, v3Routes) {
  // Collect unique custom action names so the controller exposes them (as stubs).
  const custom = v3Routes.filter((r) => {
    const action = (r.handler || '').split('.')[1];
    return !CORE_ACTIONS.has(action);
  });
  if (custom.length === 0) return null;
  const actions = [...new Set(custom.map((r) => (r.handler || '').split('.')[1]))];
  const methods = actions
    .map((a) => {
      const safe = safeActionName(a);
      return `  // TODO(P4): port ${v3ct}.${a} from v3 api/${v3ct}/controllers/${v3ct}.js\n  async ${safe}(ctx) {\n    ctx.status = 501;\n    ctx.body = { error: '${singular}.${a} not yet ported (Phase 4)' };\n  }`;
    })
    .join(',\n');
  return `'use strict';

/**
 * ${singular} controller (v5). Core CRUD inherited; custom methods stubbed until Phase 4.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::${singular}.${singular}', ({ strapi }) => ({
  // Default core actions (find/findOne/create/update/delete) are inherited.
${methods},
}));
`;
}

function main() {
  const report = {
    ct: 0,
    controllers: 0,
    services: 0,
    coreRouters: 0,
    customRoutes: 0,
    customControllers: 0,
    errors: [],
  };

  for (const v3ct of fs.readdirSync(path.join(V3_ROOT, 'api'))) {
    const singular = ctSingular(v3ct);
    const schema = loadSchema(singular);
    if (!schema) {
      report.errors.push(`${v3ct}: no v5 schema found`);
      continue;
    }
    const plural = schema.info.pluralName || singular + 's';
    const v3Routes = loadV3Routes(v3ct);
    report.ct++;

    const dirs = {
      controllers: path.join(SRC_API, singular, 'controllers'),
      services: path.join(SRC_API, singular, 'services'),
      routes: path.join(SRC_API, singular, 'routes'),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

    // controller (custom-aware if it has custom routes, else plain core)
    const customCtl = generateCustomControllerMethods(singular, v3ct, v3Routes);
    const ctlPath = path.join(dirs.controllers, `${singular}.js`);
    fs.writeFileSync(ctlPath, customCtl || generateController(singular));
    report.controllers++;

    // service
    fs.writeFileSync(path.join(dirs.services, `${singular}.js`), generateService(singular));
    report.services++;

    // core router (with v3 core-route policies preserved, e.g. isAdmin-gated writes)
    fs.writeFileSync(path.join(dirs.routes, `${singular}.js`), generateCoreRouter(singular, v3Routes));
    report.coreRouters++;

    // custom routes (if any)
    const customRoutes = generateCustomRoutes(singular, v3ct, v3Routes, plural);
    if (customRoutes) {
      fs.writeFileSync(path.join(dirs.routes, `custom-${singular}.js`), customRoutes);
      report.customRoutes++;
      report.customControllers++;
    }
  }

  console.log('── Generation summary ────────────────────────');
  console.log(`Content types:     ${report.ct}`);
  console.log(`Controllers:       ${report.controllers} (${report.customControllers} with custom stubs)`);
  console.log(`Services:          ${report.services}`);
  console.log(`Core routers:      ${report.coreRouters}`);
  console.log(`Custom route files:${report.customRoutes}`);
  if (report.errors.length) {
    console.log('Errors:');
    report.errors.forEach((e) => console.log('  ' + e));
  }
}

main();
