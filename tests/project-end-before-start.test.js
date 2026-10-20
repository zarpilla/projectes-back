'use strict';

/**
 * issues/212 (redesign review 4, 2026-10-19): Project › Dades with Final
 * 01/01/2025 and Inici 01/01/2026 saved as «Guardat» and date_end was stored.
 * Creating or updating a project whose end comes before its start is now a 400;
 * an update with only one date is checked against the stored other one.
 */

const { projectDatesError, PROJECT_DATES_MESSAGE } = require('../src/services/project-dates');

describe('project dates (issues/212)', () => {
  it('refuses an end before the start', () => {
    expect(projectDatesError({ date_start: '2026-01-01', date_end: '2025-01-01' })).toBe(PROJECT_DATES_MESSAGE);
  });
  it('accepts the same day, later ends and missing dates', () => {
    expect(projectDatesError({ date_start: '2026-01-01', date_end: '2026-01-01' })).toBe(null);
    expect(projectDatesError({ date_start: '2026-01-01', date_end: '2026-12-31' })).toBe(null);
    expect(projectDatesError({ date_start: '2026-01-01', date_end: null })).toBe(null);
    expect(projectDatesError({})).toBe(null);
  });
  it('merges the request over the stored dates', () => {
    expect(projectDatesError({ date_end: '2025-01-01' }, { date_start: '2026-01-01', date_end: '2026-12-31' })).toBe(PROJECT_DATES_MESSAGE);
    expect(projectDatesError({ date_start: '2025-01-01' }, { date_start: '2026-01-01', date_end: '2025-06-01' })).toBe(null);
  });
});

describe('POST / PUT /projects with the end before the start (issues/212)', () => {
  let controller;
  let superUpdate;
  let superCreate;
  let findOne;

  beforeEach(() => {
    jest.resetModules();
    superUpdate = jest.fn(async () => ({ data: { id: 5 } }));
    superCreate = jest.fn(async () => ({ data: { id: 6 } }));
    findOne = jest.fn(async () => ({ date_start: '2026-01-01', date_end: '2026-12-31' }));
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (_uid, build) =>
          Object.setPrototypeOf(build({ strapi: global.strapi }), { update: superUpdate, create: superCreate }),
      },
    }));
    global.strapi = {
      contentType: () => ({ attributes: {} }),
      db: { transaction: async (fn) => fn(), query: () => ({ findOne }) },
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

  it('refuses the update and writes nothing', async () => {
    const c = ctx({ name: 'P', date_start: '2026-01-01', date_end: '2025-01-01' });
    const res = await controller.update(c);
    expect(res.status).toBe(400);
    expect(c.badRequest).toHaveBeenCalledWith(PROJECT_DATES_MESSAGE);
    expect(superUpdate).not.toHaveBeenCalled();
  });

  it('checks a single date against the stored one', async () => {
    const c = ctx({ date_end: '2025-01-01' });
    await controller.update(c);
    expect(c.badRequest).toHaveBeenCalledWith(PROJECT_DATES_MESSAGE);
    expect(superUpdate).not.toHaveBeenCalled();
  });

  it('lets valid dates and saves without dates through', async () => {
    await controller.update(ctx({ date_start: '2026-01-01', date_end: '2026-01-01' }));
    await controller.update(ctx({ name: 'P' }));
    expect(superUpdate).toHaveBeenCalledTimes(2);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('refuses the create', async () => {
    const c = ctx({ name: 'P', date_start: '2026-01-01', date_end: '2025-01-01' });
    const res = await controller.create(c);
    expect(res.status).toBe(400);
    expect(superCreate).not.toHaveBeenCalled();
    await controller.create(ctx({ name: 'P', date_start: '2026-01-01', date_end: '2026-12-31' }));
    expect(superCreate).toHaveBeenCalledTimes(1);
  });
});
