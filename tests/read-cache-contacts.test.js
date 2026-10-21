'use strict';

/**
 * issues/307 — `contacts/basic` and `contacts/for-orders` are answered from the
 * read cache, and contacts are delicate: every role reads them differently
 * (middlewares/app-permissions.js). A member gets her own delivery points and
 * the shared ones (a filter added to the query before the controller); a
 * worker gets only names (the answer cut after the controller); the logistics
 * staff and the full-access users get everything, cleaned per person after.
 *
 * These tests chain the real app-permissions middleware, the real read-cache
 * middleware and a fake controller over a contacts table, and run the same
 * random sequence of requests (seven people, the queries the screens send)
 * and writes (contacts edited, a person's app permissions changed) twice: with
 * the cache and without it. Every answer must be the same. Also: a member never
 * gets another member's points, a worker never gets more than names, and no
 * kept entry holds a user's secrets.
 */

const KEY_CACHE = Symbol.for('esstrapis.readCache.cache');
const { ChangeTracker } = require('../src/services/read-cache/change-tracker');
const { ReadCache } = require('../src/services/read-cache/read-cache');
const { stripUserSecrets } = require('../src/middlewares/strip-user-secrets');

const USER = 'plugin::users-permissions.user';
const CONTACT = 'api::contact.contact';
const MEMBER_A = 11;
const MEMBER_B = 12;
const WORKER = 13;
const OFFICE = 14;
const DRIVER = 15;
const ADMIN = 16;
const PROJECTS = 17;

let tracker;
let cache;
let permissions;
let contacts;
let appPermissions;
let readCache;
let controllerRuns;

const sql = (statement) => tracker.statementEnded('c1', tracker.statementStarted('c1', statement));

function makeStrapi() {
  return {
    contentTypes: {
      [CONTACT]: {
        attributes: {
          owner: { type: 'relation', target: USER },
          users_permissions_user: { type: 'relation', target: USER },
        },
      },
      [USER]: { attributes: {} },
    },
    components: {},
    db: {
      metadata: {
        get: (uid) =>
          ({
            [CONTACT]: { tableName: 'contacts', attributes: {} },
            [USER]: { tableName: 'users-permissions_user', attributes: {} },
          })[uid],
      },
      query: (uid) => ({
        findOne: async ({ where }) => {
          if (uid !== USER) return null;
          sql(
            'select * from `users-permissions_user` left join `users-permissions_user_cmps` on 1 left join `components_permissions_application_permissions` on 1',
          );
          return {
            id: where.id,
            permissions: (permissions[where.id] || []).map((permission) => ({ permission })),
          };
        },
        findMany: async () => [],
      }),
    },
  };
}

// the v3 `_where` clauses the screens and the member scope send
function matches(row, cond) {
  if (!cond || typeof cond !== 'object') return true;
  if (Array.isArray(cond._and)) return cond._and.every((c) => matches(row, c));
  if (Array.isArray(cond._or)) return cond._or.some((c) => matches(row, c));
  return Object.entries(cond).every(([key, value]) => {
    if (key === 'owner.id') return Boolean(row.owner) && row.owner.id === Number(value);
    if (key === 'users_permissions_user.id')
      return Boolean(row.users_permissions_user) && row.users_permissions_user.id === Number(value);
    if (key === 'multiowner_eq') return row.multiowner === (value === true || value === 'true');
    if (key === 'multidelivery_eq') return row.multidelivery === (value === true || value === 'true');
    if (key === 'owner_ne') return value === 'null' ? row.owner !== null : true;
    if (key === 'contact_types.id') return row.contact_types.some((t) => t.id === Number(value));
    return true;
  });
}

// what the controllers answer: fresh rows from the "database", reads recorded
const controllers = {
  'api::contact.contact.basic': (ctx) => {
    sql('select * from `contacts` left join `contacts_owner_lnk` on 1');
    let rows = contacts.filter((c) => matches(c, ctx.query._where));
    if (String(ctx.query._sort || '').startsWith('name'))
      rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
    return structuredClone(rows);
  },
  'api::contact.contact.forOrders': (ctx) => {
    sql('select * from `contacts`');
    let rows = contacts;
    if (['1', 'true'].includes(String(ctx.query.owned))) rows = rows.filter((c) => c.owner);
    if (['1', 'true'].includes(String(ctx.query.socies))) rows = rows.filter((c) => c.users_permissions_user);
    return structuredClone(rows);
  },
};

const ROUTES = {
  'api::contact.contact.basic': '/contacts/basic',
  'api::contact.contact.forOrders': '/contacts/for-orders',
};

function makeCtx(handler, userId, query) {
  return {
    method: 'GET',
    path: `/api${ROUTES[handler]}`,
    query: structuredClone(query),
    params: {},
    status: 404,
    body: undefined,
    request: { body: undefined },
    state: {
      user: { id: userId, role: { id: 1 } },
      auth: { strategy: { name: 'users-permissions' } },
      route: { method: 'GET', path: ROUTES[handler], handler, info: { apiName: 'contact' } },
    },
  };
}

// a request through app-permissions → read-cache → controller
async function request(handler, userId, query, { useCache }) {
  const ctx = makeCtx(handler, userId, query);
  cache.enabled = useCache;
  await appPermissions(ctx, () =>
    readCache(ctx, async () => {
      controllerRuns++;
      ctx.body = controllers[handler](ctx);
      ctx.status = 200;
    }),
  );
  cache.enabled = true;
  // the global middleware every /api answer goes through on its way out
  stripUserSecrets(ctx.body);
  return JSON.parse(JSON.stringify(ctx.body));
}

function seedContacts() {
  const user = (id) => ({ id, username: `u${id}`, password: '$2a$10$hash', resetPasswordToken: 'secret' });
  return [
    {
      id: 1,
      name: 'Botiga A',
      trade_name: 'BA',
      nif: 'B1',
      partner_amount: 10,
      owner: user(MEMBER_A),
      users_permissions_user: user(MEMBER_A),
      multiowner: false,
      multidelivery: false,
      contact_types: [{ id: 2 }],
    },
    {
      id: 2,
      name: 'Botiga B',
      trade_name: 'BB',
      nif: 'B2',
      partner_amount: 20,
      owner: user(MEMBER_B),
      users_permissions_user: null,
      multiowner: false,
      multidelivery: false,
      contact_types: [{ id: 1 }],
    },
    {
      id: 3,
      name: 'Punt compartit',
      trade_name: 'PC',
      nif: 'B3',
      partner_amount: 0,
      owner: user(OFFICE),
      users_permissions_user: null,
      multiowner: true,
      multidelivery: false,
      contact_types: [{ id: 2 }],
    },
    {
      id: 4,
      name: 'Client',
      trade_name: 'CL',
      nif: 'B4',
      partner_amount: 99,
      owner: null,
      users_permissions_user: null,
      multiowner: false,
      multidelivery: false,
      contact_types: [{ id: 1 }],
    },
    {
      id: 5,
      name: 'Sòcia B',
      trade_name: 'SB',
      nif: 'B5',
      partner_amount: 5,
      owner: user(MEMBER_B),
      users_permissions_user: user(MEMBER_B),
      multiowner: false,
      multidelivery: true,
      contact_types: [{ id: 2 }],
    },
  ];
}

beforeEach(() => {
  jest.resetModules();
  tracker = new ChangeTracker();
  tracker.setLogger({ warn: () => {} });
  tracker.setSchema({
    tables: [
      'contacts',
      'contacts_owner_lnk',
      'users-permissions_user',
      'users-permissions_user_cmps',
      'components_permissions_application_permissions',
      'up_permissions',
      'up_roles',
      'up_permissions_role_lnk',
    ],
  });
  cache = new ReadCache({ tracker, log: { warn: () => {}, error: () => {} } });
  cache.enable();
  globalThis[KEY_CACHE] = cache;
  permissions = {
    [MEMBER_A]: ['orders'],
    [MEMBER_B]: ['orders'],
    [WORKER]: ['hours'],
    [OFFICE]: ['orders_admin'],
    [DRIVER]: ['orders_delivery'],
    [ADMIN]: ['admin'],
    [PROJECTS]: ['projects', 'hours'],
  };
  contacts = seedContacts();
  const strapi = makeStrapi();
  global.strapi = strapi;
  appPermissions = require('../src/middlewares/app-permissions')({}, { strapi });
  readCache = require('../src/middlewares/read-cache')({}, { strapi });
  controllerRuns = 0;
});

afterEach(() => {
  delete globalThis[KEY_CACHE];
  delete global.strapi;
});

const BASIC = 'api::contact.contact.basic';
const FOR_ORDERS = 'api::contact.contact.forOrders';
const QUERIES = {
  [BASIC]: [
    { _limit: '-1', _sort: 'name:ASC' },
    { _limit: '-1', _sort: 'name:ASC', _where: { owner_ne: 'null' } },
    { _limit: '-1', _sort: 'name:ASC', _where: { 'contact_types.id': '2' } },
  ],
  [FOR_ORDERS]: [{}, { owned: '1' }, { socies: '1' }],
};
const PEOPLE = [MEMBER_A, MEMBER_B, WORKER, OFFICE, DRIVER, ADMIN, PROJECTS];

describe('contacts through app-permissions and the read cache', () => {
  it('a member gets her points and the shared ones, never another member’s; each her own entry', async () => {
    const a = await request(BASIC, MEMBER_A, QUERIES[BASIC][0], { useCache: true });
    const b = await request(BASIC, MEMBER_B, QUERIES[BASIC][0], { useCache: true });
    expect(a.map((c) => c.id).sort()).toEqual([1, 3, 5]); // 3 shared by its owner, 5 a multidelivery point
    expect(b.map((c) => c.id).sort()).toEqual([2, 3, 5]);
    const again = await request(BASIC, MEMBER_A, QUERIES[BASIC][0], { useCache: true });
    expect(again.map((c) => c.id).sort()).toEqual([1, 3, 5]);
    expect(controllerRuns).toBe(2); // the second request of A was a hit
  });

  it('a worker gets only names from an entry kept whole for the office', async () => {
    const office = await request(BASIC, OFFICE, QUERIES[BASIC][0], { useCache: true });
    const worker = await request(BASIC, WORKER, QUERIES[BASIC][0], { useCache: true });
    const office2 = await request(BASIC, OFFICE, QUERIES[BASIC][0], { useCache: true });
    expect(controllerRuns).toBe(1);
    for (const c of worker) expect(Object.keys(c).sort()).toEqual(['id', 'name', 'trade_name']);
    expect(office2).toEqual(office);
    expect(office[0].nif).toBeDefined();
  });

  it('no kept entry holds a user’s secrets', async () => {
    for (const who of [ADMIN, MEMBER_A, OFFICE])
      await request(BASIC, who, QUERIES[BASIC][0], { useCache: true });
    const kept = JSON.stringify([...cache.entries.values()].map((e) => e.value));
    expect(kept).not.toMatch(/password|resetPasswordToken|\$2a\$/);
  });

  it('a change of a person’s app permissions applies at her next request', async () => {
    await request(BASIC, WORKER, QUERIES[BASIC][0], { useCache: true });
    permissions[WORKER] = ['orders'];
    sql('update `users-permissions_user_cmps` set `cmp_id` = ? where `entity_id` = ?');
    const now = await request(BASIC, WORKER, QUERIES[BASIC][0], { useCache: true });
    expect(now.map((c) => c.id).sort()).toEqual([3, 5]); // a member now: only the shared points
  });

  it('a random sequence gives the same answers with and without the cache', async () => {
    let seed = 7;
    const rnd = (n) => {
      seed = (seed * 16807) % 2147483647;
      return seed % n;
    };
    const pick = (list) => list[rnd(list.length)];
    let compared = 0;
    for (let step = 0; step < 400; step++) {
      if (rnd(6) === 0) {
        // a write somewhere, as the hook would report it
        const c = pick(contacts);
        const change = rnd(4);
        if (change === 0) c.name = `${c.name.split(' #')[0]} #${step}`;
        if (change === 1) c.multiowner = !c.multiowner;
        if (change === 2)
          c.owner = c.owner ? null : { id: pick([MEMBER_A, MEMBER_B, OFFICE]), username: 'x', password: 'h' };
        if (change === 3)
          c.users_permissions_user = c.users_permissions_user ? null : { id: pick([MEMBER_A, MEMBER_B]) };
        sql('update `contacts` set `name` = ? where `id` = ?');
        if (change === 2) sql('update `contacts_owner_lnk` set `user_id` = ? where `contact_id` = ?');
        if (rnd(5) === 0) {
          const who = pick(PEOPLE);
          permissions[who] = pick([
            ['orders'],
            ['hours'],
            ['orders_admin'],
            ['projects'],
            ['orders', 'hours'],
            [],
          ]);
          sql('delete from `users-permissions_user_cmps` where `entity_id` = ?');
        }
        continue;
      }
      const handler = pick([BASIC, FOR_ORDERS]);
      const who = pick(PEOPLE);
      const query = pick(QUERIES[handler]);
      let withCache;
      let without;
      try {
        withCache = await request(handler, who, query, { useCache: true });
      } catch (error) {
        withCache = { refused: error.name };
      }
      try {
        without = await request(handler, who, query, { useCache: false });
      } catch (error) {
        without = { refused: error.name };
      }
      expect({ step, handler, who, query, answer: withCache }).toEqual({
        step,
        handler,
        who,
        query,
        answer: without,
      });
      compared++;
    }
    expect(compared).toBeGreaterThan(250);
    expect(cache.counts.hits).toBeGreaterThan(50); // the cache was really used
  });
});
