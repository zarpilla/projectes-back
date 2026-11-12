'use strict';

/** issues/430: a member reads only her own notices (Avisos) and only marks them read. */

function load(rows) {
  jest.resetModules();
  const base = { find: jest.fn(async (ctx) => ctx.query), update: jest.fn(async (ctx) => ctx.request.body.data) };
  global.strapi = { db: { query: () => ({ findOne: async ({ where }) => rows[where.id] || null }) } };
  jest.doMock('@strapi/strapi', () => ({
    factories: { createCoreController: (_uid, cfg) => Object.setPrototypeOf(cfg({ strapi: global.strapi }), base) },
  }));
  return { ctrl: require('../src/api/member-notice/controllers/member-notice'), base };
}
const ctx = (userId, extra = {}) => ({ query: {}, params: {}, request: { body: {} }, state: { user: { id: userId } }, notFound: () => 'not found', unauthorized: () => 'unauthorized', ...extra });

afterEach(() => { delete global.strapi; });

describe('member notices (issues/430)', () => {
  it('lists only hers', async () => {
    const { ctrl } = load({});
    const query = await ctrl.find(ctx(5));
    expect(query.filters).toEqual({ $and: [{}, { user: { id: 5 } }] });
  });

  it("marks hers read, nothing else, and not someone else's", async () => {
    const { ctrl, base } = load({ 1: { id: 1, user: { id: 5 } }, 2: { id: 2, user: { id: 6 } } });
    expect(await ctrl.update(ctx(5, { params: { id: '1' }, request: { body: { data: { read: true, text: 'x', user: 6 } } } }))).toEqual({ read: true });
    expect(await ctrl.update(ctx(5, { params: { id: '2' }, request: { body: { data: { read: true } } } }))).toBe('not found');
    expect(base.update).toHaveBeenCalledTimes(1);
  });
});
