'use strict';

/**
 * issues/307 — the master tables' GET routes answered from the read cache.
 * What must hold:
 *   - only the listed read actions get the cache middleware, after
 *     app-permissions (access checked and the answer cleaned for the caller on
 *     every request); writes and GET /activity-types/global (which writes)
 *     never get it;
 *   - answers are kept per role (or Public), route, parameters and query; any
 *     other way of authenticating is not cached;
 *   - the same query in another key order is the same answer;
 *   - an answer depends on its content type's tables (own, link, component)
 *     and on the role permission tables;
 *   - the middleware serves a kept answer without running the controller,
 *     keeps only 200 JSON answers, and stays out of the way when off.
 */

const routesModule = require('../src/services/read-cache/routes');

const {
  registerReadCacheRoutes,
  callerOf,
  routeCacheKey,
  stableJson,
  tablesOf,
  uidOfRoute,
  CACHED_ROUTES,
  PERMISSION_TABLES,
  MIDDLEWARE,
} = routesModule;

function fakeStrapi(apis) {
  return { apis, api: (name) => apis[name] };
}

const route = (method, path, handler, middlewares = ['global::app-permissions']) => ({
  method,
  path,
  handler,
  config: { middlewares: [...middlewares] },
});

describe('registerReadCacheRoutes', () => {
  it('adds the middleware to the listed GET reads only, after app-permissions', () => {
    const core = {
      routes: [
        route('GET', '/project-types', 'api::project-type.project-type.find'),
        route('GET', '/project-types/:id', 'api::project-type.project-type.findOne'),
        route('POST', '/project-types', 'api::project-type.project-type.create'),
        route('PUT', '/project-types/:id', 'api::project-type.project-type.update'),
        route('DELETE', '/project-types/:id', 'api::project-type.project-type.delete'),
      ],
    };
    const custom = {
      routes: [
        route('GET', '/activity-types/basic', 'activity-type.getBasic'),
        route('GET', '/activity-types/global', 'activity-type.updateGlobal'),
      ],
    };
    const strapi = fakeStrapi({
      'project-type': { routes: { 'project-type': core } },
      // a router factory, instantiated the way Strapi would
      'activity-type': { routes: { '01-custom': () => custom } },
      contact: { routes: { contact: { routes: [route('GET', '/contacts', 'api::contact.contact.find')] } } },
    });
    expect(registerReadCacheRoutes(strapi)).toBe(3);
    const mws = (r) => r.config.middlewares;
    expect(mws(core.routes[0])).toEqual(['global::app-permissions', MIDDLEWARE]);
    expect(mws(core.routes[1])).toEqual(['global::app-permissions', MIDDLEWARE]);
    for (const r of core.routes.slice(2)) expect(mws(r)).not.toContain(MIDDLEWARE);
    expect(mws(custom.routes[0])).toEqual(['global::app-permissions', MIDDLEWARE]);
    expect(mws(custom.routes[1])).not.toContain(MIDDLEWARE); // writes
    expect(strapi.api('contact').routes.contact.routes[0].config.middlewares).not.toContain(MIDDLEWARE);
    // twice is the same
    registerReadCacheRoutes(strapi);
    expect(mws(core.routes[0])).toEqual(['global::app-permissions', MIDDLEWARE]);
  });

  it('lists no write and no per-person table', () => {
    expect(CACHED_ROUTES['user-festive']).toBeUndefined();
    for (const actions of Object.values(CACHED_ROUTES)) {
      for (const a of actions) expect(['find', 'findOne', 'getBasic', 'basic']).toContain(a);
    }
  });

  it('every listed api exists, and its custom reads are GET routes', () => {
    const fs = require('fs');
    const path = require('path');
    for (const [name, actions] of Object.entries(CACHED_ROUTES)) {
      const dir = path.join(__dirname, '..', 'src', 'api', name);
      expect(fs.existsSync(dir)).toBe(true);
      for (const action of actions.filter((a) => a !== 'find' && a !== 'findOne')) {
        const custom = fs.readdirSync(path.join(dir, 'routes')).filter((f) => f.startsWith('01-'));
        const routes = custom.flatMap((f) => require(path.join(dir, 'routes', f)).routes);
        const found = routes.find((r) => r.handler === `${name}.${action}`);
        expect(found && found.method).toBe('GET');
      }
    }
  });
});

describe('callerOf', () => {
  const up = { strategy: { name: 'users-permissions' } };
  it.each([
    ['no auth, no user: Public', {}, 'public'],
    ['users-permissions without a user: Public', { auth: up }, 'public'],
    ['a user: her role', { auth: up, user: { id: 7, role: { id: 1 } } }, 'role:1'],
    ['a user without a role: not cached', { auth: up, user: { id: 7 } }, null],
    ['an API token: not cached', { auth: { strategy: { name: 'api-token' } } }, null],
    ['a user without auth info: not cached', { user: { id: 1, role: { id: 1 } } }, null],
  ])('%s', (_label, state, expected) => {
    expect(callerOf({ state })).toBe(expected);
  });
});

describe('routeCacheKey', () => {
  const ctx = (query, params = {}) => ({
    params,
    query,
    state: { route: { method: 'GET', path: '/cities', handler: 'api::city.city.find' } },
  });
  it('the same query in another order is the same key', () => {
    expect(routeCacheKey(ctx({ a: 1, b: { c: 2, d: [3, 4] } }), 'role:1')).toBe(
      routeCacheKey(ctx({ b: { d: [3, 4], c: 2 }, a: 1 }), 'role:1'),
    );
  });
  it('the query, the parameters, the caller and the route are in it', () => {
    const base = routeCacheKey(ctx({ a: 1 }), 'role:1');
    expect(routeCacheKey(ctx({ a: 2 }), 'role:1')).not.toBe(base);
    expect(routeCacheKey(ctx({ a: 1 }, { id: 'x' }), 'role:1')).not.toBe(base);
    expect(routeCacheKey(ctx({ a: 1 }), 'role:2')).not.toBe(base);
    const other = ctx({ a: 1 });
    other.state.route.path = '/regions';
    expect(routeCacheKey(other, 'role:1')).not.toBe(base);
  });
  it('stableJson keeps arrays in order and tells undefined from null', () => {
    expect(stableJson([2, 1])).toBe('[2,1]');
    expect(stableJson({ a: undefined })).not.toBe(stableJson({ a: null }));
  });
});

describe('tablesOf', () => {
  const strapi = {
    db: {
      metadata: {
        get: (uid) =>
          ({
            'api::city.city': {
              tableName: 'cities',
              attributes: {
                name: { type: 'string' },
                region: { type: 'relation', joinTable: { name: 'cities_region_lnk' } },
                info: { type: 'component', component: 'shared.info', joinTable: { name: 'cities_cmps' } },
              },
            },
            'shared.info': { tableName: 'components_shared_infos', attributes: {} },
          })[uid],
      },
    },
  };
  it('its own table, its link tables and its components’ tables', () => {
    expect(tablesOf(strapi, 'api::city.city').sort()).toEqual(
      ['cities', 'cities_cmps', 'cities_region_lnk', 'components_shared_infos'].sort(),
    );
  });
  it('an unknown content type has no tables', () => {
    expect(tablesOf(strapi, 'api::nope.nope')).toEqual([]);
  });
  it('uidOfRoute reads core and custom handlers', () => {
    expect(uidOfRoute({ handler: 'api::city.city.find' })).toBe('api::city.city');
    expect(uidOfRoute({ handler: 'city-route.basic', info: { apiName: 'city-route' } })).toBe(
      'api::city-route.city-route',
    );
  });
  it('a route depends on its tables and on the role permissions', () => {
    const tables = routesModule.routeTables(strapi, { handler: 'api::city.city.find' });
    expect(tables).toEqual(expect.arrayContaining(['cities', ...PERMISSION_TABLES]));
  });
});

describe('the read-cache middleware', () => {
  const { ChangeTracker } = require('../src/services/read-cache/change-tracker');
  const { ReadCache } = require('../src/services/read-cache/read-cache');
  const KEY = Symbol.for('esstrapis.readCache.cache');
  let tracker;
  let cache;
  let middleware;
  let controllerRuns;

  const strapi = {
    db: {
      metadata: { get: (uid) => (uid === 'api::city.city' ? { tableName: 'cities', attributes: {} } : null) },
    },
  };

  beforeEach(() => {
    jest.resetModules();
    tracker = new ChangeTracker();
    tracker.setLogger({ warn: () => {} });
    tracker.setSchema({ tables: ['cities', ...PERMISSION_TABLES] });
    cache = new ReadCache({ tracker });
    cache.enable();
    globalThis[KEY] = cache;
    middleware = require('../src/middlewares/read-cache')({}, { strapi });
    controllerRuns = 0;
  });

  afterEach(() => {
    delete globalThis[KEY];
  });

  const sql = (statement) => tracker.statementEnded('c1', tracker.statementStarted('c1', statement));

  function request({ method = 'GET', query = {}, role = 1, auth = 'users-permissions' } = {}) {
    return {
      method,
      query,
      params: {},
      status: 404,
      body: undefined,
      state: {
        route: { method, path: '/cities', handler: 'api::city.city.find' },
        auth: { strategy: { name: auth } },
        user: { id: 3, role: { id: role } },
      },
    };
  }

  // the controller: reads the table and answers
  const controller =
    (ctx, answer = { data: [{ id: 1, name: 'Vic' }] }, status = 200) =>
    async () => {
      controllerRuns++;
      sql('select * from `cities`');
      ctx.status = status;
      ctx.body = typeof answer === 'function' ? answer() : structuredClone(answer);
    };

  it('the second request is answered without the controller, with its own copy', async () => {
    const a = request();
    await middleware(a, controller(a));
    const b = request();
    await middleware(b, controller(b));
    expect(controllerRuns).toBe(1);
    expect(b.body).toEqual({ data: [{ id: 1, name: 'Vic' }] });
    expect(b.body).not.toBe(a.body);
  });

  it('a write to the table makes the next request run the controller', async () => {
    const a = request();
    await middleware(a, controller(a));
    sql('update `cities` set name = ?');
    const b = request();
    await middleware(b, controller(b, { data: [{ id: 1, name: 'Vic 2' }] }));
    expect(controllerRuns).toBe(2);
    expect(b.body.data[0].name).toBe('Vic 2');
  });

  it('a change of the role permissions too', async () => {
    const a = request();
    await middleware(a, controller(a));
    sql('update `up_permissions` set action = ?');
    const b = request();
    await middleware(b, controller(b));
    expect(controllerRuns).toBe(2);
  });

  it('each role and each query is kept apart', async () => {
    for (const r of [request(), request({ role: 2 }), request({ query: { _limit: '-1' } })]) {
      await middleware(r, controller(r));
    }
    expect(controllerRuns).toBe(3);
  });

  it('only 200 JSON answers are kept', async () => {
    const a = request();
    await middleware(a, controller(a, { error: 'x' }, 404));
    const b = request();
    await middleware(
      b,
      controller(b, () => Buffer.from('pdf')),
    );
    const c = request();
    await middleware(
      c,
      controller(c, () => Buffer.from('pdf')),
    );
    expect(controllerRuns).toBe(3);
    expect(cache.entries.size).toBe(0);
  });

  it('a controller error reaches Koa and nothing is kept', async () => {
    const a = request();
    await expect(
      middleware(a, async () => {
        sql('select * from `cities`');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(cache.entries.size).toBe(0);
  });

  it.each([
    ['not a GET', { method: 'PUT' }],
    ['an API token', { auth: 'api-token' }],
  ])('%s goes straight to the controller', async (_label, options) => {
    for (let i = 0; i < 2; i++) {
      const r = request(options);
      await middleware(r, controller(r));
    }
    expect(controllerRuns).toBe(2);
  });

  it('when the cache is off, every request reaches the controller', async () => {
    cache.disable();
    for (let i = 0; i < 2; i++) {
      const r = request();
      await middleware(r, controller(r));
    }
    expect(controllerRuns).toBe(2);
  });
});
