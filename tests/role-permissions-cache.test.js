'use strict';

/**
 * issues/016 — every authenticated request re-read the 336 permissions of the
 * Authenticated role and rebuilt its ability from them: about 10 of the 26 ms
 * of server CPU of a small request (measured locally, 2026-10-11), on a backend
 * that is one Node thread. A page that sends 15 requests paid it 15 times.
 *
 * The permissions of a role and the ability built from a list of actions are
 * now kept in memory. What must hold, and is guarded here:
 *   - the same question is answered once, also when requests arrive together;
 *   - a write to a role or a permission drops what is kept (a revoked
 *     permission must stop working), and so does the TTL;
 *   - a different list of actions never gets another list's ability;
 *   - a failed read is not kept;
 *   - ROLE_PERMISSIONS_CACHE=false turns it off.
 */

const path = require('path');

const MODULE = path.join(__dirname, '..', 'src', 'services', 'role-permissions-cache.js');
const EXTENSION = path.join(__dirname, '..', 'src', 'extensions', 'users-permissions', 'strapi-server.js');

let cache;

const permissionService = (
  rows = { 1: [{ action: 'api::order.order.find' }], 2: [{ action: 'api::logo.logo.find' }] },
) => ({
  rows,
  findRolePermissions: jest.fn(async function (roleID) {
    return this.rows[roleID];
  }),
  findPublicPermissions: jest.fn(async function () {
    return this.rows[2];
  }),
  toContentAPIPermission: ({ action }) => ({ action }),
});

beforeEach(() => {
  jest.resetModules();
  delete process.env.ROLE_PERMISSIONS_CACHE;
  cache = require(MODULE);
});

describe('the permissions of a role', () => {
  it('are read once, and the kept list is what the service returned', async () => {
    const service = permissionService();
    const read = service.findRolePermissions;
    cache.cachePermissionReads(service);

    const first = await service.findRolePermissions(1);
    const second = await service.findRolePermissions(1);

    expect(read).toHaveBeenCalledTimes(1);
    expect(first).toEqual([{ action: 'api::order.order.find' }]);
    expect(second).toBe(first);
  });

  it('work when called detached, the way the auth strategy calls them', async () => {
    const service = permissionService();
    cache.cachePermissionReads(service);
    const { findRolePermissions, findPublicPermissions } = service;

    await expect(Promise.resolve(1).then(findRolePermissions)).resolves.toEqual([
      { action: 'api::order.order.find' },
    ]);
    await expect(findPublicPermissions()).resolves.toEqual([{ action: 'api::logo.logo.find' }]);
  });

  it('are kept per role, and apart from the public ones', async () => {
    const service = permissionService();
    const read = service.findRolePermissions;
    const readPublic = service.findPublicPermissions;
    cache.cachePermissionReads(service);

    expect(await service.findRolePermissions(1)).toEqual([{ action: 'api::order.order.find' }]);
    expect(await service.findRolePermissions(2)).toEqual([{ action: 'api::logo.logo.find' }]);
    await service.findPublicPermissions();
    await service.findPublicPermissions();

    expect(read).toHaveBeenCalledTimes(2);
    expect(readPublic).toHaveBeenCalledTimes(1);
  });

  it('requests arriving together share one read', async () => {
    const service = permissionService();
    const read = service.findRolePermissions;
    cache.cachePermissionReads(service);

    await Promise.all([
      service.findRolePermissions(1),
      service.findRolePermissions(1),
      service.findRolePermissions(1),
    ]);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('are read again after the TTL', async () => {
    const service = permissionService();
    const read = service.findRolePermissions;
    let clock = 1000;
    cache.cachePermissionReads(service, { ttlMs: 30000, now: () => clock });

    await service.findRolePermissions(1);
    clock += 29999;
    await service.findRolePermissions(1);
    expect(read).toHaveBeenCalledTimes(1);

    service.rows[1] = [];
    clock += 1;
    expect(await service.findRolePermissions(1)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('the TTL stays short: it is how long a change made elsewhere can go unnoticed', () => {
    expect(cache.TTL_MS).toBeLessThanOrEqual(60 * 1000);
  });

  it('a failed read is not kept', async () => {
    const service = permissionService();
    service.findRolePermissions = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValue([{ action: 'api::order.order.find' }]);
    cache.cachePermissionReads(service);

    await expect(service.findRolePermissions(1)).rejects.toThrow('connection lost');
    await expect(service.findRolePermissions(1)).resolves.toEqual([{ action: 'api::order.order.find' }]);
  });
});

describe('a write to a role or a permission', () => {
  const subscribe = () => {
    const build = jest.fn(async (permissions) => ({ built: permissions.map((p) => p.action) }));
    const engine = { generateAbility: build };
    let subscriber;
    global.strapi = {
      contentAPI: { permissions: { engine } },
      db: { lifecycles: { subscribe: (s) => (subscriber = s) } },
    };
    cache.registerRolePermissionsInvalidation();
    return { engine, build, subscriber };
  };

  afterEach(() => {
    delete global.strapi;
  });

  it('is listened to on those two models only, for every kind of write', () => {
    const { subscriber } = subscribe();

    expect(subscriber.models.sort()).toEqual([
      'plugin::users-permissions.permission',
      'plugin::users-permissions.role',
    ]);
    for (const event of [
      'afterCreate',
      'afterCreateMany',
      'afterUpdate',
      'afterUpdateMany',
      'afterDelete',
      'afterDeleteMany',
    ]) {
      expect(typeof subscriber[event]).toBe('function');
    }
  });

  it('drops the kept permissions: a revoked permission is gone on the next request', async () => {
    const { subscriber } = subscribe();
    const service = permissionService();
    cache.cachePermissionReads(service);
    expect(await service.findRolePermissions(1)).toHaveLength(1);

    // what users-permissions' updateRole does when a permission is unticked
    service.rows[1] = [];
    subscriber.afterDelete({ model: { uid: 'plugin::users-permissions.permission' } });

    expect(await service.findRolePermissions(1)).toEqual([]);
  });

  it('drops the kept abilities too', async () => {
    const { engine, build, subscriber } = subscribe();
    // registerRolePermissionsInvalidation wrapped the engine
    expect(engine.generateAbility).not.toBe(build);

    await engine.generateAbility([{ action: 'a' }]);
    await engine.generateAbility([{ action: 'a' }]);
    expect(build).toHaveBeenCalledTimes(1);

    subscriber.afterCreate({});
    await engine.generateAbility([{ action: 'a' }]);
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe('the ability of a list of actions', () => {
  const engine = () => {
    const build = jest.fn(async (permissions) => ({ can: (a) => permissions.some((p) => p.action === a) }));
    return { build, engine: cache.cacheAbilities({ generateAbility: build }) };
  };

  it('is built once for the same list', async () => {
    const { build, engine: e } = engine();

    const first = await e.generateAbility([{ action: 'a' }, { action: 'b' }]);
    const second = await e.generateAbility([{ action: 'a' }, { action: 'b' }]);

    expect(build).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first.can('b')).toBe(true);
  });

  it("a different list never gets another list's ability", async () => {
    const { build, engine: e } = engine();

    const wide = await e.generateAbility([{ action: 'a' }, { action: 'b' }]);
    const narrow = await e.generateAbility([{ action: 'a' }]);
    const none = await e.generateAbility([]);
    // actions that would collide if the key were a plain concatenation
    const tricky = await e.generateAbility([{ action: 'ab' }]);

    expect(build).toHaveBeenCalledTimes(4);
    expect(wide.can('b')).toBe(true);
    expect(narrow.can('b')).toBe(false);
    expect(none.can('a')).toBe(false);
    expect(tricky.can('a')).toBe(false);
  });

  it('permissions with conditions, properties or options are built every time', async () => {
    const { build, engine: e } = engine();

    await e.generateAbility([{ action: 'a', conditions: ['isOwner'] }]);
    await e.generateAbility([{ action: 'a', conditions: ['isOwner'] }]);
    await e.generateAbility([{ action: 'a' }], { user: { id: 1 } });
    await e.generateAbility([{ action: 'a' }], { user: { id: 2 } });

    expect(build).toHaveBeenCalledTimes(4);
  });

  it('a failed build is not kept', async () => {
    const build = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ can: () => true });
    const e = cache.cacheAbilities({ generateAbility: build });

    await expect(e.generateAbility([{ action: 'a' }])).rejects.toThrow('boom');
    await expect(e.generateAbility([{ action: 'a' }])).resolves.toBeDefined();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('clearRolePermissionsCache drops them', async () => {
    const { build, engine: e } = engine();

    await e.generateAbility([{ action: 'a' }]);
    cache.clearRolePermissionsCache();
    await e.generateAbility([{ action: 'a' }]);

    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe('wiring', () => {
  it('ROLE_PERMISSIONS_CACHE=false leaves the service and the engine untouched', async () => {
    process.env.ROLE_PERMISSIONS_CACHE = 'false';
    const service = permissionService();
    const read = service.findRolePermissions;
    const build = jest.fn(async () => ({}));
    const e = { generateAbility: build };

    cache.cachePermissionReads(service);
    cache.cacheAbilities(e);

    expect(service.findRolePermissions).toBe(read);
    expect(e.generateAbility).toBe(build);
  });

  it("the users-permissions extension wraps the plugin's permission service", async () => {
    const service = permissionService();
    const read = service.findRolePermissions;
    const plugin = {
      controllers: {
        user: { create: jest.fn(), update: jest.fn() },
        auth: () => ({ forgotPassword: jest.fn() }),
      },
      services: { permission: jest.fn(() => service) },
    };
    const factory = plugin.services.permission;

    const extended = require(EXTENSION)(plugin);
    const deps = { strapi: {} };
    const wrapped = extended.services.permission(deps);

    expect(factory).toHaveBeenCalledWith(deps);
    await wrapped.findRolePermissions(1);
    await wrapped.findRolePermissions(1);
    expect(read).toHaveBeenCalledTimes(1);
    // the rest of the service is still there
    expect(wrapped.toContentAPIPermission({ action: 'x', id: 3 })).toEqual({ action: 'x' });
  });

  it('bootstrap registers the invalidation', () => {
    const index = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    expect(index).toContain('registerRolePermissionsInvalidation();');
  });
});
