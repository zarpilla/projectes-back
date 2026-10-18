'use strict';

/**
 * issues/139 and issues/140 (2026-10-18): the holiday types and the route rates
 * could only be changed on the server. They are now auxiliary tables:
 * - «Tipus de festiu» and «Tarifes de ruta» come in the admin metadata, labelled;
 * - a route rate shows only the current tiers (ratev2), never the old
 *   less15/less30/additional30, and its routes can be picked in the form;
 * - every rate written is a ratev2 one, so a new rate isn't priced with the old
 *   tiers nobody sees;
 * - writes to both are for admins, like the other auxiliary tables.
 */

const path = require('path');

describe('admin metadata of the new tables', () => {
  beforeEach(() => {
    jest.resetModules();
    global.strapi = { dirs: { app: { root: path.join(__dirname, '..') } } };
  });
  afterEach(() => { delete global.strapi; });

  const load = async () => {
    const controller = require('../src/api/entity-metadata/controllers/entity-metadata');
    const body = await controller.adminEntities({});
    const byName = Object.fromEntries(body.entities.map((e) => [e.name, e]));
    return { body, byName };
  };

  it('lists the holiday types with labels', async () => {
    const { byName, body } = await load();
    const ft = byName['festive-type'];
    expect(ft).toBeTruthy();
    expect(ft.apiPath).toBe('festive-types');
    expect(ft.displayName).toBe('Tipus de festiu');
    expect(ft.attributes.personal.label).toBe('Personal');
    expect(ft.attributes.max.label).toBe('Màxim de dies');
    expect(ft.attributes.max.help).toMatch(/Festius d'usuari/);
    expect(body.entityToApiPath['festive-type']).toBe('festive-types');
  });

  it('shows only the current tiers of a route rate', async () => {
    const { byName, body } = await load();
    const rr = byName['route-rate'];
    expect(rr).toBeTruthy();
    expect(rr.displayName).toBe('Tarifes de ruta');
    const names = Object.keys(rr.attributes);
    for (const legacy of ['less15', 'less30', 'additional30', 'ratev2']) expect(names).not.toContain(legacy);
    for (const current of ['name', 'less10', 'more10', 'from10to20', 'from50to60', 'additional60', 'pickup_point']) {
      expect(names).toContain(current);
    }
    expect(rr.attributes.routes.editable).toBe(true);
    expect(rr.attributes.routes.label).toBe('Rutes');
    expect(body.entityToApiPath.route).toBe('routes');
    expect(body.entityToApiPath.pickup).toBe('pickups');
    expect(body.entityToApiPath['delivery-type']).toBe('delivery-types');
  });

  it('lists the tiers by weight, as the price is worked out', async () => {
    const { byName } = await load();
    const names = Object.keys(byName['route-rate'].attributes);
    const tiers = ['less10', 'more10', 'from10to20', 'from20to30', 'from30to40', 'from40to50', 'from50to60', 'additional60'];
    expect(names.filter((n) => tiers.includes(n))).toEqual(tiers);
    expect(names[0]).toBe('name');
  });
});

describe('route rate lifecycle', () => {
  const lifecycle = require('../src/api/route-rate/content-types/route-rate/lifecycles');

  it('creates every rate as a current one', () => {
    const event = { params: { data: { name: 'Girona', less10: 8 } } };
    lifecycle.beforeCreate(event);
    expect(event.params.data.ratev2).toBe(true);
  });

  it('turns an edited old rate into a current one', () => {
    const event = { params: { data: { ratev2: false, more10: 9 } } };
    lifecycle.beforeUpdate(event);
    expect(event.params.data.ratev2).toBe(true);
  });
});

describe('admin-only writes', () => {
  it('grants the actions to logged-in users (an ungranted action 403s before the policy)', () => {
    const matrix = require('fs').readFileSync(path.join(__dirname, '../src/services/bootstrap-permissions.js'), 'utf8');
    for (const name of ['festive-type', 'route-rate']) {
      const line = matrix.split('\n').find((l) => l.trim().startsWith(`'${name}':`));
      for (const action of ['find', 'findOne', 'create', 'update', 'delete']) expect(line).toContain(`'${action}'`);
    }
  });

  for (const name of ['route-rate', 'festive-type']) {
    it(`guards the writes of ${name}`, () => {
      jest.resetModules();
      let config;
      jest.doMock('@strapi/strapi', () => ({ factories: { createCoreRouter: (uid, opts) => { config = opts && opts.config; return {}; } } }));
      require(`../src/api/${name}/routes/${name}`);
      for (const action of ['create', 'update', 'delete']) expect(config[action].policies).toEqual(['global::isAdmin']);
      expect(config.find).toBeUndefined();
    });
  }
});
