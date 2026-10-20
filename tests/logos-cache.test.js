'use strict';

/**
 * issues/308 — every tenant's backend answered GET /api/logos every 30 s (the
 * Docker healthcheck used it as a "Strapi is up" probe), and each call read the
 * database: 6757 calls in ~3 h across the tenants, some taking seconds. The
 * healthcheck now uses /_health, and the logos list, which almost never
 * changes, is kept in memory until a logo is written.
 *
 * What must hold:
 *   - a second read without writes doesn't reach the database;
 *   - creating, editing or deleting a logo (or replacing its file) drops what
 *     is kept, so the next read returns the change;
 *   - answers are kept per query string and per caller;
 *   - a failed read is not kept; LOGOS_CACHE=false turns it off.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let rows;
let dbReads;
let subscribers;
let controller;

const findFromDb = jest.fn(async function (ctx) {
  dbReads += 1;
  return { data: rows.map((r) => ({ ...r })), meta: { query: ctx.query } };
});

const ctxFor = (querystring = '', user) => {
  const query = Object.fromEntries(new URLSearchParams(querystring));
  return { querystring, query, state: user ? { user } : {} };
};

// Runs the lifecycle hooks the cache registered, as a database write would.
const write = (uid, action) => {
  for (const s of subscribers) {
    if (s.models.includes(uid) && s[action]) s[action]({ model: { uid } });
  }
};

beforeEach(() => {
  jest.resetModules();
  delete process.env.LOGOS_CACHE;
  rows = [{ id: 1, url: 'https://a.example' }];
  dbReads = 0;
  subscribers = [];
  findFromDb.mockClear();
  global.strapi = { db: { lifecycles: { subscribe: (s) => subscribers.push(s) } } };
  jest.doMock('@strapi/strapi', () => ({
    factories: {
      createCoreController: (_uid, cfg) =>
        Object.setPrototypeOf(cfg({ strapi: global.strapi }), { find: findFromDb }),
    },
  }));
  controller = require('../src/api/logo/controllers/logo');
  require('../src/services/logos-cache').registerLogosCacheInvalidation();
});

afterEach(() => {
  delete global.strapi;
});

const read = (qs = 'populate=*&_limit=1', user) => controller.find(ctxFor(qs, user));

describe('GET /api/logos', () => {
  it('reads the database once, then answers from memory', async () => {
    const first = await read();
    const second = await read();
    expect(dbReads).toBe(1);
    expect(second).toEqual(first);
    expect(second.data).toEqual([{ id: 1, url: 'https://a.example' }]);
  });

  it('still translates v3 query params on the read that reaches the database', async () => {
    const body = await read('_limit=1');
    expect(body.meta.query).toEqual({ pagination: { limit: 1 } });
  });

  it('shares one read between requests arriving together', async () => {
    await Promise.all([read(), read(), read()]);
    expect(dbReads).toBe(1);
  });

  it.each([
    'afterCreate',
    'afterUpdate',
    'afterDelete',
    'afterCreateMany',
    'afterUpdateMany',
    'afterDeleteMany',
  ])('returns the change after a logo %s', async (action) => {
    await read();
    rows = [{ id: 2, url: 'https://b.example' }];
    write('api::logo.logo', action);
    const after = await read();
    expect(dbReads).toBe(2);
    expect(after.data).toEqual([{ id: 2, url: 'https://b.example' }]);
  });

  it("returns the change after an uploaded file is written (a logo's image replaced)", async () => {
    await read();
    write('plugin::upload.file', 'afterUpdate');
    await read();
    expect(dbReads).toBe(2);
  });

  it('is not dropped by writes to other tables', async () => {
    await read();
    write('api::order.order', 'afterUpdate');
    await read();
    expect(dbReads).toBe(1);
  });

  it('keeps answers per query string and per caller', async () => {
    await read('populate=*');
    await read('populate=*&filters[trashed]=false');
    await read('populate=*', { id: 7, role: { id: 1 } });
    await read('populate=*', { id: 8, role: { id: 1 } });
    await read('populate=*', { id: 9, role: { id: 3 } });
    expect(dbReads).toBe(4);
  });

  it('gives each caller its own copy', async () => {
    const first = await read();
    first.data[0].url = 'changed';
    const second = await read();
    expect(second.data[0].url).toBe('https://a.example');
  });

  it('does not keep a failed read', async () => {
    findFromDb.mockImplementationOnce(async () => {
      dbReads += 1;
      throw new Error('db down');
    });
    await expect(read()).rejects.toThrow('db down');
    await read();
    expect(dbReads).toBe(2);
  });

  it('reads the database every time with LOGOS_CACHE=false', async () => {
    process.env.LOGOS_CACHE = 'false';
    await read();
    await read();
    expect(dbReads).toBe(2);
  });
});

describe('the container healthcheck and deploy scripts', () => {
  it.each([
    'Dockerfile',
    'deploy/docker/deploy.sh',
    'deploy/docker/migrate-to-proxy.sh',
    'deploy/docker/create-tenant.sh',
    'tools/migration/vps-migrate-tenant.sh',
  ])('%s probes /_health, not /api/logos', (file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(text).not.toMatch(/\/api\/logos/);
    expect(text).toMatch(/\/_health/);
  });
});
