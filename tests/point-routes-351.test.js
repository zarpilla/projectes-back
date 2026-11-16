'use strict';

/**
 * issues/351 (La Diligència, 2026-11-16): the office changes the routes of one
 * delivery point: an extraordinary route (a route that doesn't go to the
 * town, with its own time slot), the main route (one, listed first) and a
 * cancelled route (one of the town's not offered there). A member's order can
 * only go on the point's routes; the office puts any route.
 */
const path = require('path');

const src = (...p) => path.join(__dirname, '..', 'src', ...p);

// Vic (70) has the Monday (1) and Wednesday (2) routes; Thursday (3) doesn't go there.
const ROUTES = [
  { id: 1, name: 'DILLUNS', active: true, monday: true },
  { id: 2, name: 'DIMECRES', active: true, wednesday: true },
  { id: 3, name: 'DIJOUS', active: true, thursday: true },
  { id: 4, name: 'VELLA', active: false, friday: true },
];
let POINT_ROUTES;
let CLOSURES;
let PERMISSIONS;

const matchesId = (value, cond) => {
  const id = value && typeof value === 'object' ? value.id : value;
  if (cond && typeof cond === 'object') {
    if (cond.id) return matchesId(value, cond.id);
    if ('$in' in cond) return cond.$in.includes(id);
    if ('$ne' in cond) return id !== cond.$ne;
  }
  return id === cond;
};
const matches = (row, where = {}) => Object.entries(where).every(([k, cond]) => matchesId(row[k], cond));

function stubStrapi() {
  const query = (uid) => ({
    findOne: async ({ where } = {}) => {
      if (uid === 'api::contact.contact') return { id: where.id, city: [9, 11].includes(where.id) ? 'Vic' : 'Manlleu' };
      if (uid === 'api::route.route') return ROUTES.find((r) => r.id === where.id) || null;
      if (uid === 'api::route-festive.route-festive') return CLOSURES.find((c) => matches(c, where)) || null;
      if (uid === 'plugin::users-permissions.user') {
        return { id: where.id, permissions: PERMISSIONS.map((permission) => ({ permission })) };
      }
      if (uid === 'api::point-route.point-route') return POINT_ROUTES.find((r) => matches(r, where)) || null;
      return null;
    },
    findMany: async ({ where } = {}) => {
      if (uid === 'api::city.city') return [{ id: 70, name: 'Vic' }, { id: 71, name: 'Manlleu' }];
      if (uid === 'api::city-route.city-route') {
        return [
          { id: 11, city: { id: 70 }, route: { id: 1 }, time_from: '09:00:00.000' },
          { id: 12, city: { id: 70 }, route: { id: 2 }, time_from: '10:00:00.000' },
          { id: 13, city: { id: 71 }, route: { id: 3 } },
        ];
      }
      if (uid === 'api::route.route') {
        return where && where.id ? ROUTES.filter((r) => matches(r, { id: where.id }) && (!where.active || r.active)) : ROUTES;
      }
      if (uid === 'api::point-route.point-route') return POINT_ROUTES.filter((r) => matches(r, where));
      return [];
    },
    update: async ({ where, data }) => {
      const row = POINT_ROUTES.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }) => {
      POINT_ROUTES = POINT_ROUTES.filter((r) => r.id !== where.id);
    },
  });
  global.strapi = { db: { query }, log: { info() {}, warn() {}, error() {} } };
}

const row = (id, routeId, flags, extra = {}) => ({ id, contact: { id: 9 }, route: { id: routeId }, ...flags, ...extra });

beforeEach(() => {
  jest.resetModules();
  POINT_ROUTES = [];
  CLOSURES = [];
  PERMISSIONS = ['orders'];
  stubStrapi();
});
afterAll(() => {
  delete global.strapi;
});

describe('the routes of a delivery point', () => {
  const { effectiveRoutes } = require('../src/services/point-routes');
  const town = ROUTES.slice(0, 2);

  it("are its town's when the office set nothing, all at the same level", () => {
    const routes = effectiveRoutes({ townRoutes: town, rows: [], allRoutes: ROUTES });
    expect(routes.map((r) => [r.route.id, r.extra, r.main])).toEqual([
      [1, false, false],
      [2, false, false],
    ]);
  });

  it('lose a cancelled one, take the extraordinary ones and put the main one first', () => {
    const rows = [row(1, 1, { cancelled: true }), row(2, 3, { extra: true, main: true, time_from: '15:00' })];
    const routes = effectiveRoutes({ townRoutes: town, rows, allRoutes: ROUTES });
    expect(routes.map((r) => [r.route.id, r.extra, r.main])).toEqual([
      [3, true, true],
      [2, false, false],
    ]);
    expect(routes[0].row.time_from).toBe('15:00');
  });

  it('a main town route goes first; an inactive extraordinary one is not offered', () => {
    const rows = [row(1, 2, { main: true }), row(2, 4, { extra: true })];
    const routes = effectiveRoutes({ townRoutes: town, rows, allRoutes: ROUTES });
    expect(routes.map((r) => r.route.id)).toEqual([2, 1]);
  });
});

describe('a point-route setting', () => {
  it('needs a point, a route and something to say', async () => {
    const { checkPointRoute } = require('../src/services/point-routes');
    await expect(checkPointRoute({ route: 1, main: true })).rejects.toThrow("Cal indicar el punt d'entrega");
    await expect(checkPointRoute({ contact: 9, main: true })).rejects.toThrow('Cal indicar la ruta');
    await expect(checkPointRoute({ contact: 9, route: 1 })).rejects.toThrow('extraordinària, principal o anul·lada');
    await expect(checkPointRoute({ contact: 9, route: 1, cancelled: true, main: true })).rejects.toThrow(
      'Una ruta anul·lada no pot ser extraordinària ni principal',
    );
  });

  it('is one per point and route', async () => {
    POINT_ROUTES = [row(1, 1, { cancelled: true })];
    const { checkPointRoute } = require('../src/services/point-routes');
    await expect(checkPointRoute({ contact: 9, route: 1, main: true })).rejects.toThrow('ja té aquesta ruta');
    // the same row saved again is fine
    await expect(checkPointRoute({ cancelled: true }, POINT_ROUTES[0])).resolves.toBeUndefined();
  });

  it('keeps its own time slot only on an extraordinary route, with both ends', async () => {
    const { checkPointRoute } = require('../src/services/point-routes');
    const data = { contact: 9, route: 2, main: true, time_from: '15:00', time_to: '16:00' };
    await checkPointRoute(data);
    expect(data.time_from).toBeNull();
    await expect(checkPointRoute({ contact: 9, route: 3, extra: true, time_from: '15:00' })).rejects.toThrow(
      'franja',
    );
    const extra = { contact: 9, route: 3, extra: true, time_from: '15:00', time_to: '16:00' };
    await checkPointRoute(extra);
    // as Strapi stores a time
    expect(extra.time_from).toBe('15:00:00.000');
  });

  it('as the main route unsets the point’s other main one', async () => {
    POINT_ROUTES = [row(1, 2, { main: true }), row(2, 3, { extra: true, main: true }), row(3, 1, { extra: false, main: true })];
    const { clearOtherMains } = require('../src/services/point-routes');
    await clearOtherMains(POINT_ROUTES[1]);
    // a row that was only the main one goes; one that is also extraordinary stays
    expect(POINT_ROUTES.map((r) => [r.id, Boolean(r.main)])).toEqual([[2, true]]);
    POINT_ROUTES = [row(1, 3, { extra: true, main: true }), row(2, 2, { main: true })];
    await clearOtherMains(POINT_ROUTES[1]);
    expect(POINT_ROUTES.map((r) => [r.id, Boolean(r.main)])).toEqual([
      [1, false],
      [2, true],
    ]);
  });
});

describe("a member's order on a route of the point", () => {
  const load = () => require('../src/services/point-routes').pointRouteRefusal;

  it("goes on the town's routes, not on another town's", async () => {
    const refusal = load();
    expect(await refusal({ contactId: 9, routeId: 1, date: '2026-11-23' })).toBeNull();
    expect(await refusal({ contactId: 9, routeId: 3, date: '2026-11-26' })).toBe(
      "La ruta «DIJOUS» no passa pel punt d'entrega (Vic). Tria'n una de les que s'hi ofereixen.",
    );
  });

  it('not on a cancelled one; on an extraordinary one', async () => {
    POINT_ROUTES = [row(1, 1, { cancelled: true }), row(2, 3, { extra: true })];
    const refusal = load();
    expect(await refusal({ contactId: 9, routeId: 1, date: '2026-11-23' })).toMatch(/DILLUNS/);
    expect(await refusal({ contactId: 9, routeId: 3, date: '2026-11-26' })).toBeNull();
    // another point of the same town keeps the Monday route, and not the extraordinary one
    expect(await refusal({ contactId: 11, routeId: 1, date: '2026-11-23' })).toBeNull();
    expect(await refusal({ contactId: 11, routeId: 3, date: '2026-11-26' })).toMatch(/DIJOUS/);
  });

  it("on the substitute of a closure of one of the point's routes, on its day (issues/355)", async () => {
    CLOSURES = [{ id: 1, route: { id: 2 }, substitute_route: { id: 3 }, substitute_date: '2026-11-27' }];
    const refusal = load();
    expect(await refusal({ contactId: 9, routeId: 3, date: '2026-11-27' })).toBeNull();
    expect(await refusal({ contactId: 9, routeId: 3, date: '2026-11-26' })).toMatch(/DIJOUS/);
  });
});

describe('the order controller (issues/351)', () => {
  function loadRules() {
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: () => ({}) } }));
    return require(src('api', 'order', 'controllers', 'order')).orderRules;
  }
  const user = { id: 50 };

  it("refuses a member's order on a route that doesn't stop at the point", async () => {
    POINT_ROUTES = [row(1, 1, { cancelled: true })];
    const { routeRefusal } = loadRules();
    expect(await routeRefusal({ contact: 9, route: 1, estimated_delivery_date: '2026-11-23' }, user)).toMatch(
      /DILLUNS/,
    );
    expect(await routeRefusal({ contact: 9, route: 2, estimated_delivery_date: '2026-11-25' }, user)).toBeNull();
  });

  it('lets the office put any route', async () => {
    PERMISSIONS = ['orders_admin'];
    const { routeRefusal } = loadRules();
    expect(await routeRefusal({ contact: 9, route: 3, estimated_delivery_date: '2026-11-26' }, user)).toBeNull();
  });

  it('judges an update only when the route, the point or the day change', async () => {
    POINT_ROUTES = [row(1, 1, { cancelled: true })];
    const { routeRefusal } = loadRules();
    const stored = { contact: { id: 9 }, route: { id: 1 }, estimated_delivery_date: '2026-11-23' };
    // the form sends them all again: the order keeps the route it had
    expect(await routeRefusal({ contact: 9, route: 1, estimated_delivery_date: '2026-11-23', units: 3 }, user, stored)).toBeNull();
    expect(await routeRefusal({ estimated_delivery_date: '2026-11-30' }, user, stored)).toMatch(/DILLUNS/);
  });

  it("checks a farm pickup's route against the collection point", async () => {
    const { routeRefusal } = loadRules();
    const payload = { contact: 9, route: 1, estimated_delivery_date: '2026-11-23', collection_point: 10, collection_pickup_route: 1 };
    expect(await routeRefusal(payload, user)).toMatch(/ruta de recollida «DILLUNS».*Manlleu/);
  });

  it('offers a collection point its own routes, the main one first, with an extraordinary slot', async () => {
    POINT_ROUTES = [row(1, 1, { cancelled: true }), row(2, 3, { extra: true, main: true, time_from: '15:00:00.000', time_to: '16:00:00.000' })];
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (_uid, cfg) => cfg({ strapi: global.strapi }) },
    }));
    const ctrl = require(src('api', 'order', 'controllers', 'order'));
    const routes = await ctrl.collectionPointRoutes({ query: { collection_point: 9 }, badRequest: jest.fn() });
    expect(routes.map((r) => [r.id, r.point_main, r.pickup_time_from])).toEqual([
      [3, true, '15:00:00.000'],
      [2, false, '10:00:00.000'],
    ]);
  });
});

describe('the integrations API (issues/351)', () => {
  it("assigns the point's main route first on its day and never a cancelled one", async () => {
    // Wednesday 2026-11-25: the town's DIMECRES and the point's extraordinary DIMECRES TARDA, its main one
    ROUTES.push({ id: 5, name: 'DIMECRES TARDA', active: true, wednesday: true });
    POINT_ROUTES = [row(1, 5, { extra: true, main: true }), row(2, 1, { cancelled: true })];
    const { assignRouteDay } = require('../src/api/integration/services/route-assignment');
    const { createLookups } = require('../src/api/integration/services/lookups');
    const point = { id: 9, city: 'Vic' };
    const wed = await assignRouteDay(point, '2026-11-25', { lookups: createLookups(), today: '2026-11-20' });
    expect([wed.route.id, wed.date]).toEqual([5, '2026-11-25']);
    // Monday is cancelled for the point: the next day a route of it runs
    const mon = await assignRouteDay(point, '2026-11-23', { lookups: createLookups(), today: '2026-11-20' });
    expect([mon.route.id, mon.date]).toEqual([5, '2026-11-25']);
    ROUTES.pop();
  });
});
