'use strict';

/**
 * issues/458 (2026-11-24): «Taules auxiliars › Estats de tasca» answered
 * "Error guardant: Forbidden" to admins, on create and on update. The router
 * already kept the writes for admins (isAdmin policy), but the permission
 * matrix granted Authenticated only find/findOne, so users-permissions refused
 * the request before the policy ran.
 *
 * Rule checked here for every API: when the core router puts isAdmin on
 * create/update/delete, the matrix must grant that action to Authenticated —
 * otherwise nobody, not even an admin, can write that table.
 */

const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, '../src/api');
const ACTIONS = ['create', 'update', 'delete'];
// writes refused on purpose: the tenant's settings row and filed Verifactu records
const NEVER_GRANTED = ['me.delete', 'verifactu.delete', 'verifactu-declaration.update', 'verifactu-declaration.delete'];

// "<api>" -> actions the core router guards with isAdmin
function adminGuardedWrites() {
  const out = {};
  for (const api of fs.readdirSync(API_DIR)) {
    const file = path.join(API_DIR, api, 'routes', `${api}.js`);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!/createCoreRouter/.test(text)) continue;
    const guarded = ACTIONS.filter((a) =>
      new RegExp(`\\b${a}\\s*:\\s*\\{\\s*policies\\s*:\\s*\\[[^\\]]*'global::isAdmin'`).test(text),
    );
    if (guarded.length) out[api] = guarded;
  }
  return out;
}

async function grantedToAuthenticated(apis) {
  const calls = [];
  // every API registers the five core actions
  const registered = {};
  for (const api of apis) {
    registered[`api::${api}`] = {
      controllers: { [api]: { find: {}, findOne: {}, create: {}, update: {}, delete: {} } },
    };
  }
  global.strapi = {
    service: (name) =>
      name === 'plugin::users-permissions.users-permissions'
        ? { getActions: async () => registered }
        : { updateRole: async (id, body) => calls.push({ id, body }) },
    query: () => ({ findOne: async ({ where }) => ({ id: where.type === 'public' ? 1 : 2, type: where.type }) }),
    log: { warn: () => {}, info: () => {} },
  };
  jest.resetModules();
  const { importSeedPermissions } = require('../src/services/bootstrap-permissions');
  await importSeedPermissions();
  delete global.strapi;
  return calls.find((c) => c.id === 2).body.permissions;
}

describe('admin-only writes are granted to Authenticated (issues/458)', () => {
  it('lets admins create, rename and delete task states', async () => {
    const granted = await grantedToAuthenticated(['task-state']);
    expect(Object.keys(granted['api::task-state'].controllers['task-state']).sort()).toEqual(
      ['create', 'delete', 'find', 'findOne', 'update'],
    );
  });

  it('lets admins edit the regions too', async () => {
    const granted = await grantedToAuthenticated(['region']);
    expect(Object.keys(granted['api::region'].controllers.region)).toEqual(expect.arrayContaining(ACTIONS));
  });

  it('grants every write a core router keeps for admins', async () => {
    const guarded = adminGuardedWrites();
    expect(guarded['task-state']).toEqual(ACTIONS);
    const granted = await grantedToAuthenticated(Object.keys(guarded));
    const missing = [];
    for (const [api, actions] of Object.entries(guarded)) {
      const ctl = granted[`api::${api}`]?.controllers?.[api] || {};
      for (const a of actions) if (!ctl[a] && !NEVER_GRANTED.includes(`${api}.${a}`)) missing.push(`${api}.${a}`);
    }
    expect(missing).toEqual([]);
  });
});
