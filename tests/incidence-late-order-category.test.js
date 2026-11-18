'use strict';

/**
 * 2026-11-18 (Diligència): the incidences the server opens for a late order
 * (issues/363) go into «Comanda registrada fora de temps», a category found by
 * its system_key so the admins can rename it; the late incidences opened
 * before it, without a category, are moved into it once.
 */

const fs = require('fs');
const path = require('path');

const CATEGORY = 'api::incidence-category.incidence-category';
const INCIDENCE = 'api::incidence.incidence';

function fakeDb({ categories = [], incidences = [] } = {}) {
  const created = [];
  const updated = [];
  const query = (uid) => ({
    findMany: async () => (uid === CATEGORY ? categories : uid === INCIDENCE ? incidences : []),
    count: async () => (uid === CATEGORY ? categories.length : 0),
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

const setStrapi = (db) => {
  db.links = [];
  const connection = (table) => ({ insert: async (rows) => db.links.push({ table, rows }) });
  global.strapi = { log: { warn: () => {}, info: () => {}, error: () => {} }, db: { query: db.query, connection } };
};
const load = (db) => {
  setStrapi(db);
  return require('../src/api/incidence/utils/category');
};

afterEach(() => {
  delete global.strapi;
  jest.resetModules();
});

describe('the late-order category', () => {
  it('is found by its key, whatever its name', async () => {
    const db = fakeDb({ categories: [{ id: 1, name: 'Altres', order: 1 }, { id: 7, name: 'Fora de temps', order: 2, system_key: 'late_order' }] });
    expect(await load(db).lateOrderCategoryId()).toBe(7);
    expect(db.created).toHaveLength(0);
    expect(db.updated).toHaveLength(0);
  });

  it('one with its name takes the key', async () => {
    const db = fakeDb({ categories: [{ id: 3, name: 'comanda registrada FORA de temps ', order: 4 }] });
    expect(await load(db).lateOrderCategoryId()).toBe(3);
    expect(db.updated).toEqual([{ uid: CATEGORY, where: { id: 3 }, data: { system_key: 'late_order' } }]);
  });

  it('is created last when missing', async () => {
    const db = fakeDb({ categories: [{ id: 1, name: 'A', order: 1 }, { id: 2, name: 'B', order: 5 }] });
    expect(await load(db).lateOrderCategoryId()).toBe(101);
    expect(db.created[0].data).toEqual({ name: 'Comanda registrada fora de temps', order: 6, system_key: 'late_order' });
  });

  it('is not added to an entity without categories', async () => {
    const db = fakeDb();
    expect(await load(db).lateOrderCategoryId()).toBeNull();
    expect(db.created).toHaveLength(0);
  });

  it('is in the Diligència list, before «Altres causes»', () => {
    const { DEFAULT_CATEGORIES, LATE_ORDER_NAME } = load(fakeDb());
    expect(DEFAULT_CATEGORIES.slice(-2)).toEqual([LATE_ORDER_NAME, 'Altres causes']);
  });

  it('its key is not in Taules auxiliars', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/api/entity-metadata/controllers/entity-metadata.js'), 'utf8');
    expect(source).toContain("'incidence-category': ['system_key']");
  });

  it('is private: not in the API, not writable from it', () => {
    const schema = require('../src/api/incidence-category/content-types/incidence-category/schema.json');
    expect(schema.attributes.system_key).toMatchObject({ type: 'string', private: true });
  });
});

describe('the late incidence gets it', () => {
  const late = {
    lateOrder: true,
    payload: { estimated_delivery_date: '2026-11-19', late_surcharge: 0 },
    rules: { timeZone: 'Europe/Madrid', nextDayLimitHour: 14 },
    now: new Date('2026-11-18T15:00:00Z'),
  };

  it('with the category on an entity that has them', async () => {
    const db = fakeDb({ categories: [{ id: 7, name: 'X', system_key: 'late_order' }] });
    setStrapi(db);
    const { openLateIncidence } = require('../src/api/order/services/late-incidence');
    await openLateIncidence(55, late, { id: 2 });
    const incidence = db.created.find((c) => c.uid === INCIDENCE).data;
    expect(incidence).toMatchObject({ order: 55, state: 'open', category: 7, created_user: 2 });
    expect(incidence.description).toMatch(/^Comanda fora de temps:/);
  });

  it('without one where there are no categories', async () => {
    const db = fakeDb();
    setStrapi(db);
    const { openLateIncidence } = require('../src/api/order/services/late-incidence');
    await openLateIncidence(55, late, null);
    const incidence = db.created.find((c) => c.uid === INCIDENCE).data;
    expect(incidence).not.toHaveProperty('category');
  });
});

describe('the late incidences opened before', () => {
  it('without a category go into it, without the lifecycles (no mails); the others stay', async () => {
    const db = fakeDb({
      categories: [{ id: 7, name: 'X', system_key: 'late_order' }],
      incidences: [
        { id: 1, description: 'Comanda fora de temps: informada dimecres 18/11 a les 15:00 per a dijous 19/11', category: null },
        { id: 2, description: 'Recollida informada tard: informada …', category: null },
        { id: 3, description: 'Comanda fora de temps: …', category: { id: 4 } },
        { id: 4, description: 'Paquet trencat', category: null },
      ],
    });
    await load(db).categorizeLateIncidences();
    expect(db.updated).toHaveLength(0);
    expect(db.links).toEqual([{
      table: 'incidences_category_lnk',
      rows: [{ incidence_id: 1, incidence_category_id: 7 }, { incidence_id: 2, incidence_category_id: 7 }],
    }]);
  });

  it('nothing on an entity without categories', async () => {
    const db = fakeDb({ incidences: [{ id: 1, description: 'Comanda fora de temps: …', category: null }] });
    await load(db).categorizeLateIncidences();
    expect(db.links).toHaveLength(0);
    expect(db.created).toHaveLength(0);
  });

  it('runs once at startup, after the seed', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
    const seed = source.indexOf("['seedIncidenceCategories'");
    const late = source.indexOf("['categorizeLateIncidences', categorizeLateIncidences, { runOnce: true }]");
    expect(late).toBeGreaterThan(seed);
    expect(seed).toBeGreaterThan(-1);
  });
});
