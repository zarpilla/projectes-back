'use strict';

/**
 * issues/431 (Joel, la Diligència, 2026-11-10): every incidence gets a cause
 * from a list the admins keep («Categories d'incidència», Taules auxiliars), so
 * they can be grouped and reported. Picked in the incidence modal (from the
 * order and from the albarà's QR, which opens the same order page); the free
 * text stays, now optional. The incidences export carries the category, the
 * delivery point and the replies as «Usuària - data - missatge».
 */

const fs = require('fs');
const path = require('path');

const CATEGORY = 'api::incidence-category.incidence-category';
const INCIDENCE = 'api::incidence.incidence';

function fakeDb({ categories = [], orders = 0, incidences = [] } = {}) {
  const created = [];
  const updated = [];
  const query = (uid) => ({
    findMany: async () => (uid === CATEGORY ? categories : uid === INCIDENCE ? incidences : []),
    count: async () => (uid === CATEGORY ? categories.length : uid === 'api::order.order' ? orders : 0),
    create: async ({ data }) => {
      created.push({ uid, data });
      return { id: 100 + created.length, ...data };
    },
    update: async ({ where, data }) => {
      updated.push({ uid, where, data });
      return { ...where, ...data };
    },
  });
  return { query, created, updated };
}

function setStrapi(db) {
  global.strapi = { log: { warn: () => {}, info: () => {}, error: () => {} }, db: { query: db.query } };
}

afterEach(() => {
  delete global.strapi;
  jest.resetModules();
});

describe('a new incidence needs a category (issues/431)', () => {
  const load = (db) => {
    setStrapi(db);
    return require('../src/api/incidence/utils/category');
  };

  it('is required once the entity has categories', async () => {
    const { categoryRefusal } = load(fakeDb({ categories: [{ id: 1 }, { id: 2 }] }));
    expect(await categoryRefusal([{ description: 'x', state: 'open' }])).toMatch(/categoria/);
    expect(await categoryRefusal([{ description: 'x', category: '' }])).toMatch(/categoria/);
    expect(await categoryRefusal([{ description: 'x', category: 9 }])).toMatch(/no existeix/);
    expect(await categoryRefusal([{ category: 2 }])).toBeNull();
    expect(await categoryRefusal([{ category: { id: '1' } }])).toBeNull();
  });

  it('leaves the incidences that already exist alone', async () => {
    const { categoryRefusal } = load(fakeDb({ categories: [{ id: 1 }] }));
    expect(await categoryRefusal([{ id: 7, description: 'old', state: 'closed' }])).toBeNull();
    expect(await categoryRefusal([{ id: 7, category: 5 }])).toMatch(/no existeix/);
  });

  it('asks nothing of an entity without categories', async () => {
    const { categoryRefusal } = load(fakeDb({ categories: [] }));
    expect(await categoryRefusal([{ description: 'x' }])).toBeNull();
  });
});

describe('the order save writes the category (issues/431)', () => {
  it('on a new incidence and on a corrected one', async () => {
    const db = fakeDb({ incidences: [{ id: 7, state: 'open' }] });
    setStrapi(db);
    const { processIncidences } = require('../src/api/order/services/order-incidences');
    await processIncidences(3, [
      { description: '', state: 'open', category: 4 },
      { id: 7, description: 'old', state: 'open', category: { id: 2 } },
    ], { id: 11 });
    expect(db.created[0].data).toMatchObject({ order: 3, category: 4, created_user: 11 });
    expect(db.updated[0]).toMatchObject({ where: { id: 7 }, data: { category: 2 } });
  });

  it('does not clear the category of an incidence sent without it', async () => {
    const db = fakeDb({ incidences: [{ id: 7, state: 'open' }] });
    setStrapi(db);
    const { processIncidences } = require('../src/api/order/services/order-incidences');
    await processIncidences(3, [{ id: 7, description: 'old', state: 'open' }], null);
    expect(db.updated[0].data).not.toHaveProperty('category');
  });

  it('PUT /orders/:id refuses a new incidence without category', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/api/order/controllers/order.js'), 'utf8');
    const update = source.slice(source.indexOf('async update(ctx)'));
    expect(update.indexOf('categoryRefusal(incidences)')).toBeGreaterThan(-1);
    expect(update.indexOf('categoryRefusal(incidences)')).toBeLessThan(update.indexOf('super.update(ctx)'));
  });
});

describe('the Diligència list (issues/431)', () => {
  it('is loaded once on an entity with orders', async () => {
    const db = fakeDb({ orders: 12 });
    setStrapi(db);
    const { seedIncidenceCategories, DEFAULT_CATEGORIES } = require('../src/api/incidence/utils/category');
    await seedIncidenceCategories();
    expect(DEFAULT_CATEGORIES).toHaveLength(12);
    expect(db.created.map((c) => c.data.name)).toEqual(DEFAULT_CATEGORIES);
    expect(db.created.map((c) => c.data.order)).toEqual(DEFAULT_CATEGORIES.map((_, i) => i + 1));
    expect(DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length - 1]).toBe('Altres causes');
  });

  it('not on an entity without orders, nor where there are categories already', async () => {
    let db = fakeDb({ orders: 0 });
    setStrapi(db);
    await require('../src/api/incidence/utils/category').seedIncidenceCategories();
    expect(db.created).toHaveLength(0);

    jest.resetModules();
    db = fakeDb({ orders: 5, categories: [{ id: 1 }] });
    setStrapi(db);
    await require('../src/api/incidence/utils/category').seedIncidenceCategories();
    expect(db.created).toHaveLength(0);
  });

  it('runs at startup', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
    expect(source).toContain("['seedIncidenceCategories', seedIncidenceCategories, { runOnce: true }]");
  });
});

describe('who reads and writes the categories (issues/431)', () => {
  it('read by every logistics user, written only by admins', () => {
    const { isAllowed } = require('../src/services/app-access-rules');
    for (const p of ['orders', 'orders_admin', 'orders_delivery', 'admin']) {
      expect(isAllowed(`${CATEGORY}.find`, [p])).toBe(true);
    }
    expect(isAllowed(`${CATEGORY}.find`, ['hours'])).toBe(false);
    for (const action of ['create', 'update', 'delete']) {
      expect(isAllowed(`${CATEGORY}.${action}`, ['admin'])).toBe(true);
      for (const p of ['orders', 'orders_admin', 'orders_delivery']) {
        expect(isAllowed(`${CATEGORY}.${action}`, [p])).toBe(false);
      }
    }
  });

  it('guards the writes with isAdmin and grants the API actions', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/api/incidence-category/routes/incidence-category.js'), 'utf8');
    for (const action of ['create', 'update', 'delete']) {
      expect(source).toMatch(new RegExp(`${action}: \\{ policies: \\['global::isAdmin'\\] \\}`));
    }
    const matrix = fs.readFileSync(path.join(__dirname, '../src/services/bootstrap-permissions.js'), 'utf8');
    expect(matrix).toContain("'incidence-category': ['find', 'findOne', 'create', 'update', 'delete'],");
  });

  it('is in Taules auxiliars for admins, not for the office', async () => {
    const permissions = { 1: ['admin'], 2: ['orders_admin'] };
    global.strapi = {
      dirs: { app: { root: path.join(__dirname, '..') } },
      db: { query: () => ({ findOne: async ({ where }) => ({ id: where.id, permissions: (permissions[where.id] || []).map((permission) => ({ permission })) }) }) },
    };
    const controller = require('../src/api/entity-metadata/controllers/entity-metadata');
    const admin = await controller.adminEntities({ state: { user: { id: 1 } } });
    const entity = admin.entities.find((e) => e.name === 'incidence-category');
    expect(entity).toMatchObject({ apiPath: 'incidence-categories', displayName: "Categories d'incidència", listSort: ['order', 'asc'] });
    expect(entity.attributes.name).toMatchObject({ label: 'Nom', required: true });
    expect(entity.attributes.order.label).toBe('Ordre');
    jest.resetModules();
    const office = await require('../src/api/entity-metadata/controllers/entity-metadata').adminEntities({ state: { user: { id: 2 } } });
    expect(office.entities.map((e) => e.name)).not.toContain('incidence-category');
  });

  it('members and drivers may set the category of an incidence they can edit', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/middlewares/app-permissions.js'), 'utf8');
    expect(source).toContain("const INCIDENCE_FIELDS = ['description', 'state', 'incidence_response', 'category'];");
  });
});

describe('the incidences export (issues/431)', () => {
  function loadController(rows) {
    const base = { update: jest.fn(async () => ({ ok: true })), create: jest.fn(async () => ({ ok: true })) };
    global.strapi = {
      log: { warn: () => {}, info: () => {} },
      db: { query: (uid) => ({ findMany: async () => (uid === CATEGORY ? [{ id: 1 }, { id: 2 }] : rows) }) },
    };
    jest.doMock('@strapi/strapi', () => ({
      factories: { createCoreController: (_uid, cfg) => Object.setPrototypeOf(cfg({ strapi: global.strapi }), base) },
    }));
    return { ctrl: require('../src/api/incidence/controllers/incidence'), base };
  }

  it('gives the category, the delivery point and the replies', async () => {
    const { ctrl } = loadController([
      {
        id: 5,
        state: 'closed',
        createdAt: '2026-11-03T09:00:00.000Z',
        closed_date: '2026-11-04T12:00:00.000Z',
        description: 'Caixa 2 xafada',
        category: { id: 4, name: "S'ha malmès el contingut del paquet" },
        created_user: { id: 2, username: 'repartidora1', fullname: 'Anna Repartidora' },
        order: { id: 25770, owner: { id: 9, username: 'formatges' }, contact: { trade_name: 'Botiga Verda' } },
        incidence_response: [
          { text: 'Ho mirem', response_date: '2026-11-03T10:15:00.000Z', user: { fullname: 'Gestió' } },
          { text: "D'acord,\ngràcies", response_date: '2026-11-04T08:00:00.000Z', user: { username: 'formatges' } },
        ],
      },
      { id: 6, state: 'open', createdAt: '2026-11-05T09:00:00.000Z', order: { id: 2, contact_trade_name: 'Bar' } },
    ]);
    const [row, plain] = await ctrl.infoAll({ query: {} });
    expect(row).toMatchObject({
      category: "S'ha malmès el contingut del paquet",
      category_id: 4,
      establishment: 'Botiga Verda',
      owner_name: 'formatges',
      order_id: 25770,
      created_user: 'Anna Repartidora',
      created_at: '2026-11-03',
      closed_date: '2026-11-04',
      description: 'Caixa 2 xafada',
    });
    expect(row.replies.split('\n')).toEqual([
      expect.stringMatching(/^Gestió - 2026-11-03 \d\d:15 - Ho mirem$/),
      expect.stringMatching(/^formatges - 2026-11-04 \d\d:00 - D'acord, gràcies$/),
    ]);
    expect(plain).toMatchObject({ category: 'Sense categoria', establishment: 'Bar', replies: '' });
  });

  it('PUT /incidences/:id: a category can be corrected, not removed or made up', async () => {
    const { ctrl, base } = loadController([]);
    const ctx = (data) => ({ request: { body: { data } }, params: { id: '5' }, state: {}, badRequest: (m) => ({ refused: m }) });
    const empty = ctx({ category: null, description: 'x' });
    await ctrl.update(empty);
    expect(empty.request.body.data).not.toHaveProperty('category');
    expect(await ctrl.update(ctx({ category: 99 }))).toEqual({ refused: expect.stringMatching(/no existeix/) });
    await ctrl.update(ctx({ category: 2 }));
    expect(base.update).toHaveBeenCalledTimes(2);
  });

  it('POST /incidences needs a category too', async () => {
    const { ctrl, base } = loadController([]);
    const ctx = (data) => ({ request: { body: { data } }, badRequest: (m) => ({ refused: m }) });
    expect(await ctrl.create(ctx({ description: 'x', order: 1 }))).toEqual({ refused: expect.stringMatching(/categoria/) });
    await ctrl.create(ctx({ description: 'x', order: 1, category: 1 }));
    expect(base.create).toHaveBeenCalledTimes(1);
  });
});
