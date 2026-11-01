'use strict';

/**
 * issues/397 (security review round 3, 2026-11-01): `units` had no upper
 * bound and the labels PDF makes one page per box in a synchronous loop. On a
 * copy of La Diligència member 32 set 3,000 boxes on her pending order 24900:
 * its PDF took 1.9 s and 3 MB, growing linearly, so `units: 2000000000` would
 * hang the tenant (and the office's next print of that day). Guards: writes by
 * users without full access refuse more than 1,000 boxes on the order or a
 * line; the PDF caps its loops.
 */

const ME = 32;

function makeStrapi(permissions) {
  return {
    db: {
      query: jest.fn(() => ({
        findOne: jest.fn(async ({ where }) => ({ id: where.id, permissions: permissions.map((permission) => ({ permission })) })),
        findMany: jest.fn(async () => []),
      })),
    },
    contentTypes: {},
    components: {},
  };
}

async function write(permissions, handler, body, method = 'POST') {
  jest.resetModules();
  const strapi = makeStrapi(permissions);
  const middleware = require('../src/middlewares/app-permissions')({}, { strapi });
  const ctx = {
    method,
    query: {},
    params: {},
    request: { body },
    state: { user: { id: ME }, route: { handler, info: { apiName: 'order' } } },
  };
  const next = jest.fn(async () => {
    throw new Error('reached');
  });
  return middleware(ctx, next);
}

const refused = (p) => expect(p).rejects.toMatchObject({ name: 'ValidationError', message: expect.stringMatching(/1000 caixes/) });

describe('box limit on order writes (issues/397)', () => {
  it.each([
    ['member create', ['orders'], 'api::order.order.create', { data: { units: 2000000000 } }],
    ['member line', ['orders'], 'api::order.order.create', { data: { units: 1, lines: [{ units: 5000 }] } }],
    ['csv', ['orders'], 'api::order.order.createCSV', { units: '1001' }],
    ['driver update', ['orders_delivery', 'hours'], 'api::order.order.update', { data: { units: 1e6 } }],
    ['office', ['orders_admin'], 'api::order.order.create', { data: { units: 'molts' } }],
  ])('refuses %s', async (_label, permissions, handler, body) => {
    await refused(write(permissions, handler, body));
  });

  it('lets real counts through to the next checks', async () => {
    for (const body of [{ data: { units: 34, lines: [{ units: 99 }, { units: null }] } }, { data: { units: 1000 } }, { data: { comments: 'x' } }]) {
      const result = write(['orders_admin'], 'api::order.order.create', body);
      await expect(result).rejects.not.toMatchObject({ message: expect.stringMatching(/caixes/) });
    }
  });

  it('full users are not limited here', async () => {
    await expect(write(['projects'], 'api::order.order.create', { data: { units: 5000 } })).rejects.toThrow('reached');
  });
});

describe('labels PDF caps its loops (issues/397)', () => {
  it('boxesOf', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/api/order/controllers/order.js'), 'utf8');
    expect(src).toMatch(/pages: boxesOf\(order\.units\)/);
    expect(src).toMatch(/i < boxesOf\(line\.units\)/);
  });
});
