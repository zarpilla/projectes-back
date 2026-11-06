'use strict';

/**
 * 2026-11-06: «Esborrar projecte» sent to the trash a project with invoices,
 * expenses or hours. Tresoreria and IVA kept counting its documents and each
 * person's views its hours, while the reports by project (Ingressos/Despeses,
 * Preu hora, Dedicació) left them out: they no longer added up. And a numbered
 * project gave its number back to the series, so a code already on an invoice
 * would be taken again. Such a project can't go to the trash any more.
 */

describe('project trash guard', () => {
  let counts;
  let stored;
  let service;

  beforeEach(() => {
    jest.resetModules();
    counts = {};
    stored = { id: 7, trashed: false };
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: async () => (uid === 'api::project.project' ? stored : null),
          count: async ({ where }) => {
            // documents linked by `project` or by `projects`
            if (uid.startsWith('api::emitted-invoice') || uid.startsWith('api::received-invoice') ||
                uid.startsWith('api::received-expense') || uid.startsWith('api::received-income')) {
              expect(where).toEqual({ $or: [{ project: { id: 7 } }, { projects: { id: 7 } }] });
            } else {
              expect(where).toEqual({ project: { id: 7 } });
            }
            return counts[uid] || 0;
          },
        }),
      },
    };
    service = require('../src/api/project/services/project-trash');
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('lets an empty project go to the trash', async () => {
    expect(await service.trashError(7)).toBeNull();
  });

  it('refuses a project with documents or hours, naming them', async () => {
    counts['api::emitted-invoice.emitted-invoice'] = 2;
    counts['api::received-expense.received-expense'] = 1;
    counts['api::activity.activity'] = 42;
    expect(await service.trashError(7)).toBe(
      "No es pot esborrar el projecte: té 2 factures emeses, 1 despesa i 42 registres d'hores. " +
        "Si ja no hi treballeu, tanca'l canviant-ne l'estat.",
    );
  });

  it('refuses a project with hours only', async () => {
    counts['api::activity.activity'] = 1;
    expect(await service.trashError('7')).toMatch(/té 1 registre d'hores\./);
  });

  it('every kind of document blocks it', async () => {
    for (const { uid } of service.BLOCKERS) {
      counts = { [uid]: 1 };
      expect(await service.trashError(7)).not.toBeNull();
    }
  });

  it('a project already in the trash is not checked again', async () => {
    stored = { id: 7, trashed: true };
    counts['api::activity.activity'] = 3;
    expect(await service.trashError(7)).toBeNull();
  });
});

describe('PUT /projects/:id with trashed', () => {
  let trashError;
  let controller;

  beforeEach(() => {
    jest.resetModules();
    trashError = jest.fn();
    jest.doMock('../src/api/project/services/project-trash', () => ({ trashError }));
    jest.doMock('../src/api/project/services/project-series', () => ({ numberUpdatedProject: jest.fn() }));
    const superUpdate = jest.fn(async () => ({ data: { id: 7 } }));
    global.strapi = {
      db: { transaction: async (fn) => fn({}) },
    };
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (_uid, build) =>
          Object.setPrototypeOf(build({ strapi: global.strapi }), { update: superUpdate }),
      },
    }));
    controller = require('../src/api/project/controllers/project');
  });

  afterEach(() => {
    jest.dontMock('@strapi/strapi');
    delete global.strapi;
  });

  const ctx = (data) => ({
    params: { id: '7' },
    query: {},
    state: {},
    request: { body: { data } },
    badRequest: jest.fn((message) => ({ status: 400, message })),
  });

  it('answers 400 with the reason', async () => {
    trashError.mockResolvedValue('No es pot esborrar el projecte: té 1 despesa.');
    const c = ctx({ trashed: true });
    const result = await controller.update(c);
    expect(trashError).toHaveBeenCalledWith('7');
    expect(c.badRequest).toHaveBeenCalledWith('No es pot esborrar el projecte: té 1 despesa.');
    expect(result.status).toBe(400);
  });

  it('a plain save never counts the documents', async () => {
    const c = ctx({ description: 'x' });
    await controller.update(c);
    expect(trashError).not.toHaveBeenCalled();
    expect(c.badRequest).not.toHaveBeenCalled();
  });
});
