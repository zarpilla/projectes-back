'use strict';

/**
 * issues/159 (2026-10-18): pickup points, delivery types, towns, products,
 * document types, VAT types, activity types and the supporters' logos could
 * only be edited from the Strapi admin. They are now edited from the app:
 * - the auxiliary tables come in the admin metadata, labelled in Catalan;
 * - the logistics ones (pickup points, delivery types, towns) are written by
 *   the logistics office (`orders_admin`) besides full access, as routes are;
 * - the others are written by admins only (isAdmin on the route), but an
 *   activity type is still created by anybody from the project form;
 * - a town in use (routes, pickup points, contacts) can't be deleted;
 * - the contact form's messages are read by admins only.
 */

const fs = require('fs');
const path = require('path');

describe('admin metadata of the tables that needed the Strapi admin', () => {
  beforeEach(() => {
    jest.resetModules();
    const permissions = { 1: ['admin'], 2: ['orders_admin'] };
    global.strapi = {
      dirs: { app: { root: path.join(__dirname, '..') } },
      db: { query: () => ({ findOne: async ({ where }) => ({ id: where.id, permissions: (permissions[where.id] || []).map((permission) => ({ permission })) }) }) },
    };
  });
  afterEach(() => { delete global.strapi; });

  const load = async (userId = 1) => {
    const controller = require('../src/api/entity-metadata/controllers/entity-metadata');
    const body = await controller.adminEntities({ state: { user: { id: userId } } });
    const byName = Object.fromEntries(body.entities.map((e) => [e.name, e]));
    return { body, byName };
  };

  it.each([
    ['pickup', 'pickups', 'Punts de recollida'],
    ['delivery-type', 'delivery-types', 'Tipus de lliurament'],
    ['city', 'cities', 'Poblacions'],
    ['product', 'products', 'Productes'],
    ['document-type', 'document-types', 'Tipus de document'],
    ['vat-type', 'vat-types', "Tipus d'IVA"],
    ['activity-type', 'activity-types', "Tipus d'activitat"],
  ])('lists %s', async (name, apiPath, displayName) => {
    const { byName, body } = await load();
    expect(byName[name]).toMatchObject({ apiPath, displayName });
    expect(body.entityToApiPath[name]).toBe(apiPath);
  });

  it('shows a pickup point with its town, without its users (issues/159)', async () => {
    const { byName, body } = await load();
    const pickup = byName.pickup;
    expect(Object.keys(pickup.attributes).slice(0, 4)).toEqual(['name', 'alias', 'city', 'pickup']);
    expect(pickup.attributes.city).toMatchObject({ label: 'Població', target: 'api::city.city' });
    expect(pickup.attributes.pickup.label).toBe('Recollida a la finca');
    // nothing reads allowed_users, and as a one-to-many it moved users between points
    expect(pickup.attributes.allowed_users).toBeUndefined();
    // the relation targets resolve to an API path
    expect(body.entityToApiPath.city).toBe('cities');
    expect(body.entityToApiPath.user).toBe('users');
  });

  it('gives the logistics office only the Logística tables (issues/159)', async () => {
    const { byName } = await load(2);
    expect(Object.keys(byName).sort()).toEqual(['city', 'delivery-type', 'pickup', 'route-pickup-notice', 'route-rate']);
  });

  it('names the document types in Catalan and picks a project from the slim list', async () => {
    const { byName, body } = await load();
    expect(byName['document-type'].attributes.type.enumLabels).toEqual({ income: 'Ingrés', expense: 'Despesa' });
    expect(byName['vat-type'].attributes.value.label).toBe('% IVA');
    expect(Object.keys(byName['activity-type'].attributes).slice(0, 3)).toEqual(['name', 'global', 'project']);
    expect(body.entityToApiPath.project).toBe('projects/basic');
  });
});

describe('who writes them', () => {
  const matrix = fs.readFileSync(path.join(__dirname, '../src/services/bootstrap-permissions.js'), 'utf8');
  const line = (key) => matrix.split('\n').find((l) => l.trim().startsWith(`${key}:`));

  it.each([
    ['pickups'], ["'delivery-type'"], ['city'], ['product'], ["'document-type'"], ["'vat-type'"], ["'activity-type'"], ['logos'],
  ])('grants %s to logged-in users (an ungranted action 403s first)', (key) => {
    // the last one: the authenticated role (logos is also read by the public one)
    const lines = matrix.split('\n').filter((l) => l.trim().startsWith(`${key}:`));
    const granted = lines[lines.length - 1];
    for (const action of ['find', 'findOne', 'create', 'update', 'delete']) expect(granted).toContain(`'${action}'`);
  });

  it('keeps the activity-type create grant (inline from the project form)', () => {
    expect(line("'activity-type'")).toContain("'getBasic'");
  });

  const routerConfig = (name) => {
    jest.resetModules();
    let opts;
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreRouter: (uid, o) => { opts = o || {}; return {}; } } }));
    require(`../src/api/${name}/routes/${name}`);
    return opts;
  };

  it.each([['product'], ['document-type'], ['vat-type'], ['logo']])('only admins write %s', (name) => {
    const { config } = routerConfig(name);
    for (const action of ['create', 'update', 'delete']) expect(config[action].policies).toEqual(['global::isAdmin']);
    expect(config.find).toBeUndefined();
  });

  it('only admins rename or delete an activity type; anybody creates one', () => {
    const { config } = routerConfig('activity-type');
    expect(config.update.policies).toEqual(['global::isAdmin']);
    expect(config.delete.policies).toEqual(['global::isAdmin']);
    expect(config.create).toBeUndefined();
  });

  it('only admins read the contact form messages', () => {
    const { config, only } = routerConfig('form-submission');
    expect(only).toEqual(['find', 'findOne', 'create']);
    expect(config.find.policies).toEqual(['global::isAdmin']);
    expect(config.create).toBeUndefined();
  });

  it('lets the logistics office write the logistics tables, and nobody else', () => {
    jest.resetModules();
    const { isAllowed } = require('../src/services/app-access-rules');
    for (const uid of ['api::pickup.pickup', 'api::delivery-type.delivery-type']) {
      for (const action of ['create', 'update', 'delete']) {
        expect(isAllowed(`${uid}.${action}`, ['orders_admin'])).toBe(true);
        expect(isAllowed(`${uid}.${action}`, ['orders_delivery'])).toBe(false);
        expect(isAllowed(`${uid}.${action}`, ['orders'])).toBe(false);
      }
    }
    expect(isAllowed('api::city.city.update', ['orders_admin'])).toBe(true);
    expect(isAllowed('api::city.city.delete', ['orders_admin'])).toBe(true);
    expect(isAllowed('api::city.city.delete', ['orders_delivery'])).toBe(false);
    // the drivers still add a town inline
    expect(isAllowed('api::city.city.create', ['orders_delivery'])).toBe(true);
    // the admin-only tables: not for the office
    expect(isAllowed('api::product.product.create', ['orders_admin'])).toBe(false);
    expect(isAllowed('api::logo.logo.update', ['orders_admin'])).toBe(false);
  });
});

describe('deleting a town (issues/159)', () => {
  let lifecycles;
  let counts;
  let calls;

  beforeEach(() => {
    jest.resetModules();
    counts = {};
    calls = [];
    global.strapi = {
      db: {
        query: (uid) => ({
          findMany: async () => [{ id: 7, name: 'Vic' }],
          count: async (args) => { calls.push([uid, args]); return counts[uid] || 0; },
        }),
      },
    };
    lifecycles = require('../src/api/city/content-types/city/lifecycles');
  });
  afterEach(() => { delete global.strapi; });

  it('deletes a town nobody uses', async () => {
    await expect(lifecycles.beforeDelete({ params: { where: { id: 7 } } })).resolves.toBeUndefined();
    expect(calls).toEqual(expect.arrayContaining([
      ['api::city-route.city-route', { where: { city: 7 } }],
      ['api::pickup.pickup', { where: { city: 7 } }],
      ['api::contact.contact', { where: { city: { $eqi: 'Vic' } } }],
    ]));
  });

  it('refuses a town with routes, pickup points or contacts, saying what uses it', async () => {
    counts = { 'api::city-route.city-route': 2, 'api::pickup.pickup': 1, 'api::contact.contact': 5 };
    await expect(lifecycles.beforeDelete({ params: { where: { id: 7 } } })).rejects.toThrow(
      'No es pot esborrar la població «Vic»: la fan servir 2 rutes, 1 punt de recollida i 5 contactes.',
    );
  });

  it('guards a delete of many too', async () => {
    counts = { 'api::contact.contact': 1 };
    await expect(lifecycles.beforeDeleteMany({ params: { where: { id: { $in: [7] } } } })).rejects.toThrow('1 contacte');
  });
});

describe('the logistics office opens Taules auxiliars › Logística (issues/159)', () => {
  beforeEach(() => jest.resetModules());

  it('writes the route rates and reads the tables metadata', () => {
    const { isAllowed } = require('../src/services/app-access-rules');
    for (const action of ['create', 'update', 'delete']) {
      expect(isAllowed(`api::route-rate.route-rate.${action}`, ['orders_admin'])).toBe(true);
      expect(isAllowed(`api::route-rate.route-rate.${action}`, ['orders'])).toBe(false);
    }
    expect(isAllowed('api::entity-metadata.entity-metadata.adminEntities', ['orders_admin'])).toBe(true);
    expect(isAllowed('api::entity-metadata.entity-metadata.adminEntities', ['orders_delivery'])).toBe(false);
  });

  it('lets admins and the office through isAdminOrOffice, nobody else', async () => {
    const perms = { 1: ['admin'], 2: ['orders_admin'], 3: ['orders', 'projects'] };
    global.strapi = { db: { query: () => ({ findOne: async ({ where }) => ({ permissions: perms[where.id].map((permission) => ({ permission })) }) }) } };
    const policy = require('../src/policies/isAdminOrOffice');
    await expect(policy({ state: { user: { id: 1 } } })).resolves.toBe(true);
    await expect(policy({ state: { user: { id: 2 } } })).resolves.toBe(true);
    await expect(policy({ state: { user: { id: 3 } } })).rejects.toThrow('admin privileges');
    await expect(policy({ state: {} })).rejects.toThrow('authenticated');
    delete global.strapi;
  });
});
