'use strict';

/**
 * issues/013 (2026-10-09): the income list's "Concepte" column was empty for
 * every row, and the income Excel export had no concept. The front reads
 * `document_concept || lines[0].concept`; most documents have no header
 * concept, so it relies on `lines`.
 *
 * The lists read `GET /api/<plural>/basic`. v3 populated components on every
 * query, so `lines` and `contact_info` came for free; the v5 `findBasic`
 * handlers use `strapi.db.query`, which only returns what `populate` names,
 * and listed only the relations. The same handler shape is shared by the four
 * document types, so all four are checked.
 *
 * The check is schema-driven: a component added to a document later has to be
 * populated here too, or it silently disappears from the list endpoints.
 */

const fs = require('fs');
const path = require('path');

const TYPES = ['emitted-invoice', 'received-income', 'received-invoice', 'received-expense'];

const componentsOf = (type) => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', 'src', 'api', type, 'content-types', type, 'schema.json'),
      'utf8'
    )
  );
  return Object.entries(schema.attributes)
    .filter(([, a]) => a.type === 'component')
    .map(([name]) => name);
};

const callFindBasic = async (type) => {
  const findMany = jest.fn().mockResolvedValue([]);
  const strapi = { db: { query: jest.fn(() => ({ findMany })) } };
  global.strapi = strapi;

  jest.doMock('@strapi/strapi', () => ({
    factories: { createCoreController: (_uid, cfg) => cfg({ strapi }) },
  }));
  const controller = require(`../src/api/${type}/controllers/${type}`);

  await controller.findBasic({ query: { _limit: '-1' } });
  expect(strapi.db.query).toHaveBeenCalledWith(`api::${type}.${type}`);
  return findMany.mock.calls[0][0].populate;
};

describe.each(TYPES)('%s/basic populate', (type) => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('finds the components in the schema', () => {
    // guards the test itself: if this ever empties, the assertions below pass vacuously
    expect(componentsOf(type)).toEqual(expect.arrayContaining(['lines', 'contact_info']));
  });

  it('populates every component, as v3 did', async () => {
    const populate = await callFindBasic(type);
    for (const name of componentsOf(type)) {
      expect(populate[name]).toBe(true);
    }
  });

  it('still populates the relations the lists read', async () => {
    const populate = await callFindBasic(type);
    expect(populate).toMatchObject({ contact: true, projects: true, document_type: true });
  });
});
