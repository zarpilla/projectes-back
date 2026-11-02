'use strict';

/**
 * issues/354, 355 (2026-10-27): a route closed for a holiday runs another day
 * on a substitute route («DJ - Alt Empordà / Festiu 23 octubre» on the 22nd),
 * and the office says why. A closure (route-festive) now keeps `reason`,
 * `substitute_route` and `substitute_date`; the route needs its date, the
 * date its route, and the substitute can't be the closed route that day.
 */

jest.mock('../src/services/relation-input', () => jest.requireActual('../src/services/relation-input'));

beforeEach(() => jest.resetModules());
afterEach(() => delete global.strapi);

describe('route closure with a substitute route (issues/355)', () => {
  it('trims the reason and accepts a substitute route with its date', () => {
    const { checkClosure } = require('../src/services/route-closure');
    const data = { date: '2026-10-23', route: 5, reason: '  Festiu local  ', substitute_route: 9, substitute_date: '2026-10-22' };
    checkClosure(data);
    expect(data).toMatchObject({ reason: 'Festiu local', substitute_route: 9, substitute_date: '2026-10-22' });
    const blank = { reason: '   ' };
    checkClosure(blank);
    expect(blank.reason).toBeNull();
  });

  it('refuses a route without a date, a date without a route, or the closed route itself', () => {
    const { checkClosure } = require('../src/services/route-closure');
    expect(() => checkClosure({ date: '2026-10-23', route: 5, substitute_route: 9 })).toThrow('dia de la ruta alternativa');
    expect(() => checkClosure({ date: '2026-10-23', route: 5, substitute_date: '2026-10-22' })).toThrow('Cal indicar la ruta alternativa');
    expect(() =>
      checkClosure({ date: '2026-10-23', route: 5, substitute_route: { id: 5 }, substitute_date: '2026-10-23' }),
    ).toThrow('mateixa ruta');
  });

  it('on update, judges the fields sent with the stored ones; clearing both is fine', () => {
    const { checkClosure } = require('../src/services/route-closure');
    const stored = { date: '2026-10-23', route: { id: 5 }, substitute_route: { id: 9 }, substitute_date: '2026-10-22' };
    expect(() => checkClosure({ substitute_date: null }, stored)).toThrow('dia de la ruta alternativa');
    const clear = { substitute_route: null, substitute_date: null };
    checkClosure(clear, stored);
    expect(clear).toEqual({ substitute_route: null, substitute_date: null });
    expect(() => checkClosure({ reason: 'Pont' }, stored)).not.toThrow();
  });

  it('the lifecycle checks creates and updates', async () => {
    global.strapi = {
      db: { query: () => ({ findOne: async () => ({ date: '2026-10-23', route: { id: 5 }, substitute_route: null, substitute_date: null }) }) },
    };
    const lifecycles = require('../src/api/route-festive/content-types/route-festive/lifecycles');
    expect(() => lifecycles.beforeCreate({ params: { data: { route: 5, substitute_route: 9 } } })).toThrow();
    await expect(lifecycles.beforeUpdate({ params: { where: { id: 1 }, data: { substitute_date: '2026-10-22' } } })).rejects.toThrow(
      'Cal indicar la ruta alternativa',
    );
  });
});
