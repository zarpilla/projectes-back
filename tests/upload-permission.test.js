'use strict';

/**
 * POST /api/upload returned 403 for authenticated users on v5.
 *
 * Every tenant's v3 database has exactly one upload permission enabled for the
 * authenticated role (upload.upload.upload); find/findOne/destroy/count/
 * search/getsettings/updatesettings are enabled=0 and public has none. That
 * grant was made through the admin UI and never written into the v3 seed, so
 * the permission matrix ported from that seed didn't carry it.
 *
 * It matters that the bootstrap owns this: it runs on every boot and
 * updateRole REPLACES the role's permission set, so a row added by hand to the
 * database is wiped on the next restart.
 */

const fs = require('fs');
const path = require('path');

const { setPermissions } = require('../src/services/bootstrap-permissions');

/** Two plugins registering a controller called "content-api" — upload really does. */
const REGISTERED = {
  'plugin::upload': {
    controllers: {
      'content-api': { upload: {}, find: {}, findPage: {}, findOne: {}, destroy: {} },
    },
  },
  'plugin::other': {
    controllers: {
      'content-api': { upload: {}, find: {} },
    },
  },
  'api::order': { controllers: { order: { find: {}, findOne: {} } } },
};

function stubStrapi() {
  const calls = [];
  global.strapi = {
    service: (name) =>
      name === 'plugin::users-permissions.users-permissions'
        ? { getActions: async () => REGISTERED }
        : { updateRole: async (id, body) => calls.push({ id, body }) },
    query: () => ({ findOne: async () => ({ id: 7, type: 'authenticated' }) }),
    log: { warn: () => {}, info: () => {} },
  };
  return calls;
}

afterEach(() => {
  delete global.strapi;
});

describe('upload permission', () => {
  it('grants POST /api/upload to authenticated', async () => {
    const calls = stubStrapi();
    await setPermissions('authenticated', { 'plugin::upload.content-api': ['upload'] });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.permissions).toEqual({
      'plugin::upload': { controllers: { 'content-api': { upload: { enabled: true } } } },
    });
  });

  it('binds to the upload plugin, not another plugin sharing the controller name', async () => {
    const calls = stubStrapi();
    await setPermissions('authenticated', { 'plugin::upload.content-api': ['upload'] });

    expect(Object.keys(calls[0].body.permissions)).toEqual(['plugin::upload']);
    expect(calls[0].body.permissions['plugin::other']).toBeUndefined();
  });

  it('still resolves ordinary unqualified api controllers', async () => {
    const calls = stubStrapi();
    await setPermissions('authenticated', { order: ['find'] });

    expect(calls[0].body.permissions).toEqual({
      'api::order': { controllers: { order: { find: { enabled: true } } } },
    });
  });

  it('keeps v3 parity — only `upload`, nothing destructive', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'bootstrap-permissions.js'),
      'utf8'
    );
    expect(source).toContain("'plugin::upload.content-api': ['upload'],");
    // v3 had destroy/find/findOne disabled; granting them would widen access.
    expect(source).not.toMatch(/'plugin::upload\.content-api':\s*\[[^\]]*destroy/);
    expect(source).not.toMatch(/'plugin::upload\.content-api':\s*\[[^\]]*find/);
  });
});
