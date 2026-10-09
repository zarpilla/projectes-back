'use strict';

/**
 * Regression: issues/022 — quotes were saved with every total at 0.
 *
 * v5 persists the lines component before the db lifecycle runs and leaves only
 * `{ id, __pivot }` references in `data.lines`; the quote lifecycle summed
 * `base`/`quantity`/`vat` off those references. The other documents already
 * read the lines back (document-lifecycle.js); quotes now do too. Quotes never
 * carry IRPF: total = base + VAT. An update that doesn't send the lines (e.g.
 * marking it accepted) keeps the stored totals instead of zeroing them.
 * Found by the front's e2e tests on 2026-10-09.
 */

const UID = 'api::quote.quote';
const COMPONENT = 'invoice-line.invoice-line';

const storedLines = [
  { id: 21, base: 100, quantity: 2, vat: 21, irpf: 15, discount: 10 },
  { id: 22, base: 50, quantity: 1, vat: 10 },
];

function mockStrapi({ quotes = [] } = {}) {
  const componentQuery = {
    findMany: jest.fn(async ({ where }) => storedLines.filter((l) => where.id.$in.includes(l.id))),
  };
  const quoteQuery = {
    findMany: jest.fn(async () => quotes),
    findOne: jest.fn(async () => null),
  };
  const updates = [];
  global.strapi = {
    contentTypes: { [UID]: { attributes: { lines: { type: 'component', repeatable: true, component: COMPONENT } } } },
    db: {
      query: jest.fn((uid) => (uid === COMPONENT ? componentQuery : quoteQuery)),
      metadata: { get: () => ({ tableName: 'quotes' }) },
      connection: jest.fn(() => ({ where: (w) => ({ update: async (v) => updates.push({ ...w, ...v }) }) })),
    },
    log: { info: jest.fn() },
  };
  return { componentQuery, updates };
}

// 2 × 100 − 10 % = 180 + 21 % VAT 37.8; 50 + 10 % VAT 5
const EXPECTED = { total_base: 230, total_vat: 42.8, total_irpf: 0, total: 272.8 };

describe('quote totals (issues/022)', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => { delete global.strapi; });

  const lifecycles = () => require('../src/api/quote/content-types/quote/lifecycles');

  it('reads the line values back when v5 hands over bare references (create)', async () => {
    mockStrapi();
    const data = { code: 'Q-1', lines: [{ id: 21, __pivot: {} }, { id: 22, __pivot: {} }] };
    await lifecycles().beforeCreate({ params: { data } });
    expect(data.total_base).toBeCloseTo(EXPECTED.total_base, 6);
    expect(data.total_vat).toBeCloseTo(EXPECTED.total_vat, 6);
    expect(data.total_irpf).toBe(0);
    expect(data.total).toBeCloseTo(EXPECTED.total, 6);
  });

  it('recomputes them on an update that sends the lines', async () => {
    mockStrapi();
    const data = { code: 'Q-1', lines: [{ id: 22, __pivot: {} }] };
    await lifecycles().beforeUpdate({ params: { data } });
    expect([data.total_base, data.total_vat, data.total]).toEqual([50, 5, 55]);
  });

  it('keeps the stored totals on an update without lines', async () => {
    mockStrapi();
    const data = { code: 'Q-1', accepted: true };
    await lifecycles().beforeUpdate({ params: { data } });
    expect(data).toEqual({ code: 'Q-1', accepted: true });
  });

  it('repairs quotes stored at 0 whose lines add up to something (startup script)', async () => {
    const { updates } = mockStrapi({
      quotes: [
        { id: 5, code: 'Q-5', total: 0, total_base: 0, total_vat: 0, lines: storedLines },
        { id: 6, code: 'Q-6', total: 0, total_base: 0, total_vat: 0, lines: [] },
      ],
    });
    await require('../src/services/recalc-zero-quote-totals').recalcZeroQuoteTotals();
    expect(updates).toEqual([{ id: 5, total_base: 230, total_vat: 42.8, total_irpf: 0, total: 272.8 }]);
  });
});
