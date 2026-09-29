'use strict';

/**
 * A received invoice with all its data on the concept line was saved with a
 * 0.00 total, so /stats received-invoices and the treasury showed it as 0.
 *
 * v5 persists the lines component before the db lifecycle runs and leaves only
 * `{ id, __pivot }` references in `data.lines`; the ported arithmetic read
 * `base`/`quantity`/`vat` off those references and summed zeros. The same
 * factory serves received-expense, received-income, diet and ticket.
 */

jest.mock('../src/api/project/services/totalsRefreshScheduler', () => ({
  scheduleFromEntityProjects: jest.fn(),
}));

const { createDocumentLifecycles } = require('../src/services/document-lifecycle');

const UID = 'api::received-invoice.received-invoice';
const COMPONENT = 'invoice-line.invoice-line-expenses';

const storedLines = [
  { id: 11, base: 100, quantity: 2, vat: 21, irpf: 15 },
  { id: 12, base: 50, quantity: 1, vat: 10, discount: 10 },
];

function mockStrapi({ existing = { id: 1, updatable: true } } = {}) {
  const componentQuery = {
    findMany: jest.fn(async ({ where }) => storedLines.filter((l) => where.id.$in.includes(l.id))),
  };
  const documentQuery = {
    findOne: jest.fn(async () => existing),
    findMany: jest.fn(async () => []),
  };
  global.strapi = {
    contentTypes: {
      [UID]: { attributes: { lines: { type: 'component', repeatable: true, component: COMPONENT } } },
    },
    db: {
      query: jest.fn((uid) => (uid === COMPONENT ? componentQuery : documentQuery)),
    },
  };
  return { componentQuery };
}

const lifecycles = createDocumentLifecycles({ uid: UID, entity: 'received-invoice', hasLines: true });

// 200 + 21% vat - 15% irpf; 45 + 10% vat
const EXPECTED = { total_base: 245, total_vat: 46.5, total_irpf: 30, total: 261.5 };

afterEach(() => {
  delete global.strapi;
});

describe('document lifecycle totals', () => {
  it('reads the line values back when v5 hands over bare references (create)', async () => {
    const { componentQuery } = mockStrapi();
    const data = { lines: [{ id: 11, __pivot: {} }, { id: 12, __pivot: {} }] };
    await lifecycles.beforeCreate({ params: { data } });

    expect(componentQuery.findMany).toHaveBeenCalled();
    for (const [key, value] of Object.entries(EXPECTED)) {
      expect(data[key]).toBeCloseTo(value, 6);
    }
  });

  it('reads the line values back on update too', async () => {
    mockStrapi();
    const data = { lines: [{ id: 11, __pivot: {} }, { id: 12, __pivot: {} }] };
    await lifecycles.beforeUpdate({ params: { where: { id: 1 }, data } });
    expect(data.total).toBeCloseTo(EXPECTED.total, 6);
  });

  it('still accepts raw line objects', async () => {
    const { componentQuery } = mockStrapi();
    const data = { lines: storedLines.map(({ id: _id, ...rest }) => rest) };
    await lifecycles.beforeCreate({ params: { data } });
    expect(componentQuery.findMany).not.toHaveBeenCalled();
    expect(data.total).toBeCloseTo(EXPECTED.total, 6);
  });

  it('keeps the stored totals on an update that does not send the lines', async () => {
    mockStrapi();
    const data = { projects: [3] };
    await lifecycles.beforeUpdate({ params: { where: { id: 1 }, data } });
    expect(data).not.toHaveProperty('total');
    expect(data).not.toHaveProperty('total_base');
  });

  it('zeroes the totals when the lines are emptied', async () => {
    mockStrapi();
    const data = { lines: [] };
    await lifecycles.beforeUpdate({ params: { where: { id: 1 }, data } });
    expect(data.total).toBe(0);
  });
});
