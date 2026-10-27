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
    for (const name of ['contact', 'projects']) expect(populate[name]).toBeTruthy();
  });
});

/**
 * issues/330 (2026-10-24): Ingressos (EmittedInvoicesTable) read whole
 * contacts, projects and document types for a period; it shows and exports
 * only these columns (as the Despeses lists of issues/325). Half the answer,
 * 2.5–3× faster locally.
 */
describe('Ingressos lists read only what they show (issues/330)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  const CONTACT = ['id', 'name', 'nif', 'address', 'postcode', 'city'];

  it('emitted invoices: contact and projects narrowed, no document type', async () => {
    const populate = await callFindBasic('emitted-invoice');
    expect(Object.keys(populate).sort()).toEqual(['contact', 'contact_info', 'lines', 'projects']);
    expect(populate.contact).toEqual({ select: CONTACT });
    expect(populate.projects).toEqual({ select: ['id', 'name'] });
  });

  it('received incomes: the document type narrowed too', async () => {
    const populate = await callFindBasic('received-income');
    expect(Object.keys(populate).sort()).toEqual(['contact', 'contact_info', 'document_type', 'lines', 'projects']);
    expect(populate.contact).toEqual({ select: CONTACT });
    expect(populate.projects).toEqual({ select: ['id', 'name'] });
    expect(populate.document_type).toEqual({ select: ['id', 'name'] });
  });

});
