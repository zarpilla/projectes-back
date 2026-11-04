'use strict';

/**
 * A POST or PUT of a received invoice (or any document of the shared
 * lifecycle) without `serial` answered 500: the code numbering looked the
 * series up with `findOne({ where: { id: undefined } })`, which v5 refuses.
 * The form always sends a series, so it only showed through the API (found
 * while writing the model 303 e2e, 2026-11-04). Without a series the document
 * is saved without a code, as quotes and emitted invoices already did.
 */

jest.mock('../src/api/project/services/totalsRefreshScheduler', () => ({
  scheduleFromEntityProjects: jest.fn(),
}));

const { createDocumentLifecycles } = require('../src/services/document-lifecycle');

const UID = 'api::received-invoice.received-invoice';

function mockStrapi({ existing = [] } = {}) {
  const serieQuery = {
    // what v5 does with an undefined id in a where clause
    findOne: jest.fn(async ({ where }) => {
      if (where.id === undefined) throw new Error('Undefined attribute level operator id');
      return where.id === 7 ? { id: 7, name: 'REB', leadingZeros: 4 } : null;
    }),
  };
  const documentQuery = {
    findOne: jest.fn(async () => ({ id: 1, updatable: true })),
    findMany: jest.fn(async () => existing),
  };
  global.strapi = {
    contentTypes: { [UID]: { attributes: {} } },
    db: { query: jest.fn((uid) => (uid === 'api::serie.serie' ? serieQuery : documentQuery)) },
  };
  return { serieQuery };
}

const lifecycles = createDocumentLifecycles({ uid: UID, entity: 'received-invoice', hasLines: true });
const lines = [{ concept: 'compra', quantity: 1, base: 200, vat: 21 }];

afterEach(() => {
  delete global.strapi;
});

describe('document without a series', () => {
  it('is created without a code instead of failing', async () => {
    const { serieQuery } = mockStrapi();
    const data = { lines };
    await expect(lifecycles.beforeCreate({ params: { data } })).resolves.not.toThrow();
    expect(serieQuery.findOne).not.toHaveBeenCalled();
    expect(data.code).toBeUndefined();
    expect(data.total).toBeCloseTo(242, 6);
  });

  it('is updated without a code instead of failing', async () => {
    const { serieQuery } = mockStrapi();
    const data = { lines };
    await expect(lifecycles.beforeUpdate({ params: { where: { id: 1 }, data } })).resolves.not.toThrow();
    expect(serieQuery.findOne).not.toHaveBeenCalled();
    expect(data.total).toBeCloseTo(242, 6);
  });

  it('with a series still gets the next code of the series', async () => {
    mockStrapi({ existing: [{ id: 1 }, { id: 2 }] });
    const data = { serial: 7, lines };
    await lifecycles.beforeCreate({ params: { data } });
    expect(data).toMatchObject({ number: 3, code: 'REB-0003' });
  });

  it('keeps a code it already has without looking the series up', async () => {
    const { serieQuery } = mockStrapi();
    const data = { serial: 7, code: 'REB-0001', lines };
    await lifecycles.beforeCreate({ params: { data } });
    expect(serieQuery.findOne).not.toHaveBeenCalled();
    expect(data.code).toBe('REB-0001');
  });
});
