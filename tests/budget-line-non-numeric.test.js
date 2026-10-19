'use strict';

/**
 * issues/224 (redesign review 5, 2026-10-19): a budget line quantity typed as
 * 1.000,5 reached `PUT /projects/:id` as "1.000.5"; the decimal column threw
 * and the save answered a 500 «Internal Server Error». A non-numeric quantity
 * or price is now a 400 that names the line, before anything is written.
 */

const { isStorableNumber, invalidLineValueMessage } = require('../src/services/budget-line');

describe('budget line numbers (issues/224)', () => {
  it('accepts empty values and numbers, also as text', () => {
    for (const v of [null, undefined, 0, 7.25, '7.25', '-1.2346', ' 3 ']) expect(isStorableNumber(v)).toBe(true);
  });

  it('refuses what the decimal column would throw on', () => {
    for (const v of ['1.000.5', '1.000,5', '12 u', '', ' ', NaN, Infinity, {}]) expect(isStorableNumber(v)).toBe(false);
  });

  it('names the first wrong line', () => {
    const phases = [
      { incomes: [{ concept: 'Disseny', quantity: '2', amount: 10 }], expenses: [{ concept: 'Impremta', quantity: '1.000.5', amount: 3 }] },
    ];
    expect(invalidLineValueMessage(phases)).toBe('La quantitat de «Impremta» no és un número vàlid: «1.000.5»');
    expect(invalidLineValueMessage([{ incomes: [{ quantity: 1, amount: 'abc' }] }])).toBe('El preu no és un número vàlid: «abc»');
    expect(invalidLineValueMessage([{ incomes: [{ quantity: 1, amount: 2 }], expenses: [] }])).toBe(null);
    expect(invalidLineValueMessage(undefined)).toBe(null);
  });
});

describe('PUT /projects/:id with a non-numeric line (issues/224)', () => {
  let controller;
  let transaction;
  let superUpdate;

  beforeEach(() => {
    jest.resetModules();
    superUpdate = jest.fn(async () => ({ data: { id: 5 } }));
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (_uid, build) => Object.setPrototypeOf(build({ strapi: global.strapi }), { update: superUpdate }),
      },
    }));
    transaction = jest.fn(async (fn) => fn());
    global.strapi = {
      contentType: () => ({ attributes: {} }),
      db: { transaction },
    };
    controller = require('../src/api/project/controllers/project');
  });

  afterEach(() => {
    delete global.strapi;
    jest.dontMock('@strapi/strapi');
  });

  const ctx = (data) => ({
    params: { id: '5' },
    query: {},
    state: {},
    request: { body: { data } },
    badRequest: jest.fn((message) => ({ status: 400, message })),
  });

  it('answers 400 and writes nothing', async () => {
    const c = ctx({
      _project_phases_updated: true,
      project_phases: [{ name: 'F1', incomes: [{ concept: 'Disseny', quantity: '1.000.5', amount: 10 }], expenses: [] }],
      project_phases_info: {},
    });
    const res = await controller.update(c);
    expect(c.badRequest).toHaveBeenCalledWith('La quantitat de «Disseny» no és un número vàlid: «1.000.5»');
    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('checks the original plan too', async () => {
    const c = ctx({
      _project_original_phases_updated: true,
      project_original_phases: [{ name: 'F1', incomes: [], expenses: [{ quantity: 1, amount: '' }] }],
      project_original_phases_info: {},
    });
    await controller.update(c);
    expect(c.badRequest).toHaveBeenCalledWith('El preu no és un número vàlid: «»');
  });

  it('a project save without phase edits goes through', async () => {
    const c = ctx({ name: 'P-1', project_phases: [{ incomes: [{ quantity: 'stale' }] }] });
    await controller.update(c);
    expect(c.badRequest).not.toHaveBeenCalled();
    expect(superUpdate).toHaveBeenCalled();
  });
});
