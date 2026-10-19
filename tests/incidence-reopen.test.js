'use strict';

/**
 * issues/226: reopening a closed incidence as a full-access office user sent
 * only `{ state }`, so closed_date and closed_user stayed and the panel still
 * said «Tancada …». app-permissions clears them only for the users without
 * full access (issues/190); the controller now does it for everyone.
 */

const path = require('path');

function load(stored) {
  jest.resetModules();
  const base = { update: jest.fn(async () => ({ data: {} })) };
  const findOne = jest.fn(async () => stored);
  global.strapi = { db: { query: () => ({ findOne }) } };
  jest.doMock('@strapi/strapi', () => ({
    factories: {
      createCoreController: (_uid, cfg) => Object.setPrototypeOf(cfg({ strapi: global.strapi }), base),
    },
  }));
  const ctrl = require(path.join(__dirname, '..', 'src', 'api', 'incidence', 'controllers', 'incidence'));
  return { ctrl, base, findOne };
}

const ctxWith = (data) => ({
  params: { id: 'doc50' },
  state: { user: { id: 100 }, v3: { numericId: 50 } },
  request: { body: { data } },
});

afterEach(() => {
  delete global.strapi;
});

describe('reopening an incidence (issues/226)', () => {
  it('clears who closed it and when', async () => {
    const { ctrl, base, findOne } = load({ id: 50, state: 'closed' });
    const ctx = ctxWith({ state: 'open' });
    await ctrl.update(ctx);
    expect(findOne.mock.calls[0][0].where).toEqual({ id: 50 });
    expect(ctx.request.body.data).toEqual({ state: 'open', closed_date: null, closed_user: null });
    expect(base.update).toHaveBeenCalledTimes(1);
  });

  it('also when it goes back to «En procés»', async () => {
    const { ctrl } = load({ id: 50, state: 'closed' });
    const ctx = ctxWith({ state: 'wip' });
    await ctrl.update(ctx);
    expect(ctx.request.body.data).toMatchObject({ closed_date: null, closed_user: null });
  });

  it('leaves an incidence that was not closed, and closing it, alone', async () => {
    const open = load({ id: 50, state: 'open' });
    const toWip = ctxWith({ state: 'wip' });
    await open.ctrl.update(toWip);
    expect(toWip.request.body.data).toEqual({ state: 'wip' });

    const closing = load({ id: 50, state: 'open' });
    const close = ctxWith({ state: 'closed', closed_date: '2026-10-19T10:00:00.000Z', closed_user: 100 });
    await closing.ctrl.update(close);
    expect(close.request.body.data).toEqual({ state: 'closed', closed_date: '2026-10-19T10:00:00.000Z', closed_user: 100 });
    expect(closing.findOne).not.toHaveBeenCalled();
  });
});
