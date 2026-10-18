'use strict';

/**
 * issues/103 (2026-10-17): Taules auxiliars showed English column headers
 * («CAN ASSIGN ACTIVITIES», «NAME TREASURY», «LEADING ZEROS», «VAT PCT»…)
 * for the fields the Catalan label list missed. Every field of every admin
 * table now has a label.
 */

const path = require('path');

describe('admin entity labels (issues/103)', () => {
  beforeEach(() => {
    jest.resetModules();
    // an admin: the office gets only the logistics tables (issues/159)
    global.strapi = { dirs: { app: { root: path.join(__dirname, '..') } }, db: { query: () => ({ findOne: async () => ({ permissions: [{ permission: 'admin' }] }) }) } };
  });
  afterEach(() => { delete global.strapi; });

  it('labels every field of every auxiliary table', async () => {
    const controller = require('../src/api/entity-metadata/controllers/entity-metadata');
    const ctx = { send: jest.fn((v) => { ctx.body = v; }), body: undefined, state: { user: { id: 1 } } };
    const result = await controller.adminEntities(ctx);
    const body = ctx.body || result;
    const entities = (body && (body.data || body.entities || body)) || [];
    const list = Array.isArray(entities) ? entities : Object.values(entities);
    expect(list.length).toBeGreaterThan(10);
    const missing = list.flatMap((e) =>
      Object.entries(e.attributes || {}).filter(([, a]) => !a.label).map(([name]) => `${e.name}.${name}`),
    );
    expect(missing).toEqual([]);
  });
});
