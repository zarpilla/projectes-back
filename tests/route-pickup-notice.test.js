'use strict';

/**
 * issues/313 (2026-10-21): La Diligència wants the deposit conditions (when a
 * parcel must be left at the warehouse to make the route) per destination route
 * and origin warehouse, shown prominently in the order form. The only text was
 * the warehouse's own `message`, one per warehouse whatever the route.
 * New table «Avisos de dipòsit» (route-pickup-notice): routes, warehouse, text;
 * edited in Taules auxiliars › Logística like the route rates, read by every
 * logistics user (the order form).
 */

const fs = require('fs');
const path = require('path');

describe('«Avisos de dipòsit» in the admin tables (issues/313)', () => {
  beforeEach(() => {
    jest.resetModules();
    const permissions = { 1: ['admin'], 2: ['orders_admin'] };
    global.strapi = {
      dirs: { app: { root: path.join(__dirname, '..') } },
      db: { query: () => ({ findOne: async ({ where }) => ({ id: where.id, permissions: (permissions[where.id] || []).map((permission) => ({ permission })) }) }) },
    };
  });
  afterEach(() => { delete global.strapi; });

  const load = async (userId) => {
    const controller = require('../src/api/entity-metadata/controllers/entity-metadata');
    const body = await controller.adminEntities({ state: { user: { id: userId } } });
    return { body, byName: Object.fromEntries(body.entities.map((e) => [e.name, e])) };
  };

  it('lists it in Catalan, with the routes ticked in the form', async () => {
    const { byName, body } = await load(1);
    const notice = byName['route-pickup-notice'];
    expect(notice).toMatchObject({ apiPath: 'route-pickup-notices', displayName: 'Avisos de dipòsit' });
    expect(body.entityToApiPath['route-pickup-notice']).toBe('route-pickup-notices');
    expect(Object.keys(notice.attributes)).toEqual(['name', 'routes', 'pickup', 'message']);
    expect(notice.attributes.routes).toMatchObject({ label: 'Rutes', editable: true });
    expect(notice.attributes.pickup.label).toBe('Recollida (magatzem)');
    expect(notice.attributes.message.label).toBe('Avís');
  });

  it('opens it to the logistics office', async () => {
    const { byName } = await load(2);
    expect(byName['route-pickup-notice']).toBeDefined();
  });
});

describe('who reads and writes the notices (issues/313)', () => {
  const UID = 'api::route-pickup-notice.route-pickup-notice';

  it('is read by every logistics user (the order form) and written by the office', () => {
    jest.resetModules();
    const { isAllowed } = require('../src/services/app-access-rules');
    for (const p of ['orders', 'orders_admin', 'orders_delivery']) {
      expect(isAllowed(`${UID}.find`, [p])).toBe(true);
      expect(isAllowed(`${UID}.findOne`, [p])).toBe(true);
    }
    expect(isAllowed(`${UID}.find`, ['hours'])).toBe(false);
    for (const action of ['create', 'update', 'delete']) {
      expect(isAllowed(`${UID}.${action}`, ['orders_admin'])).toBe(true);
      expect(isAllowed(`${UID}.${action}`, ['orders'])).toBe(false);
      expect(isAllowed(`${UID}.${action}`, ['orders_delivery'])).toBe(false);
    }
  });

  it('guards the writes with isAdminOrOffice and grants the API actions', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/api/route-pickup-notice/routes/route-pickup-notice.js'), 'utf8');
    for (const action of ['create', 'update', 'delete']) {
      expect(source).toMatch(new RegExp(`${action}: \\{ policies: \\['global::isAdminOrOffice'\\] \\}`));
    }
    const matrix = fs.readFileSync(path.join(__dirname, '../src/services/bootstrap-permissions.js'), 'utf8');
    expect(matrix).toContain("'route-pickup-notice': ['find', 'findOne', 'create', 'update', 'delete'],");
  });
});
