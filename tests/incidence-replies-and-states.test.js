'use strict';

/**
 * issues/154 (2026-10-18): incidence 96 of the logistics copy showed its two
 * replies as «Usuari desconegut». GET /api/incidences/:id gets the v3 default
 * `populate=*`, which reaches the `incidence_response` component but not the
 * `user` relation inside it. And the incidences report labelled «En procés»
 * (wip) incidences «Tancada».
 */

const path = require('path');

function load(rows = []) {
  jest.resetModules();
  const base = {
    findOne: jest.fn(async (ctx) => ({ data: { query: ctx.query } })),
  };
  global.strapi = {
    log: { warn: () => {}, info: () => {} },
    db: { query: () => ({ findMany: async () => rows }) },
  };
  jest.doMock('@strapi/strapi', () => ({
    factories: {
      createCoreController: (_uid, cfg) => Object.setPrototypeOf(cfg({ strapi: global.strapi }), base),
    },
  }));
  const ctrl = require(path.join(__dirname, '..', 'src', 'api', 'incidence', 'controllers', 'incidence'));
  return { ctrl, base };
}

afterEach(() => {
  delete global.strapi;
});

describe('GET /api/incidences/:id (issues/154)', () => {
  it('populates the author of every reply', async () => {
    const { ctrl, base } = load();
    const ctx = { query: { populate: '*' }, state: { v3DefaultPopulate: true }, params: { id: 'abc' } };
    await ctrl.findOne(ctx);
    const { populate } = base.findOne.mock.calls[0][0].query;
    expect(populate.incidence_response).toEqual({ populate: { user: expect.anything() } });
    // and still what populate=* gave
    expect(populate).toMatchObject({ created_user: expect.anything(), closed_user: expect.anything(), order: true });
  });

  it("leaves a caller's own populate alone", async () => {
    const { ctrl, base } = load();
    await ctrl.findOne({ query: { populate: ['order'] }, state: {}, params: { id: 'abc' } });
    expect(base.findOne.mock.calls[0][0].query.populate).toEqual(['order']);
  });
});

describe('GET /api/incidences/infoall states (issues/154)', () => {
  it('labels an incidence in progress «En procés», not «Tancada»', async () => {
    const at = '2026-10-12T10:00:00.000Z';
    const { ctrl } = load([
      { id: 1, state: 'open', createdAt: at },
      { id: 2, state: 'wip', createdAt: at },
      { id: 3, state: 'closed', createdAt: at },
    ]);
    const rows = await ctrl.infoAll({ query: { _limit: '-1' } });
    expect(rows.map((r) => [r.state, r.state_raw])).toEqual([
      ['Oberta', 'open'],
      ['En procés', 'wip'],
      ['Tancada', 'closed'],
    ]);
  });
});
