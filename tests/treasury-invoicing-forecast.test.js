'use strict';

/**
 * Informes › Previsió facturació (new report, 2026-10-17): which planned incomes
 * count as "still to invoice", which date they take, and the invoiced base per
 * month. Also checks the controller populates what the rows read and that the
 * Authenticated role gets the new action.
 */

const fs = require('fs');
const path = require('path');
const {
  isPending,
  pendingInvoicingRows,
  invoicedByMonth,
  PROJECT_POPULATE,
} = require('../src/api/treasury/services/invoicing-forecast');

const income = (extra = {}) => ({ id: 1, concept: 'Sessions', total_amount: '1000.00', paid: false, ...extra });
const project = (incomes, extra = {}) => ({
  id: 7,
  name: 'Projecte',
  project_state: { id: 1, name: 'Actiu' },
  leader: { id: 3, username: 'laia', fullname: 'Laia Puig' },
  clients: [{ id: 9, name: 'Ateneu' }],
  project_phases: [{ name: 'Fase 1', incomes }],
  ...extra,
});

describe('isPending', () => {
  it('keeps an unpaid income with no document', () => {
    expect(isPending(income())).toBe(true);
  });
  it('drops paid, invoiced, documented and zero incomes', () => {
    expect(isPending(income({ paid: true }))).toBe(false);
    expect(isPending(income({ invoice: { id: 4 } }))).toBe(false);
    expect(isPending(income({ income: { id: 5 } }))).toBe(false);
    expect(isPending(income({ total_amount: '0.00' }))).toBe(false);
    expect(isPending(income({ total_amount: null }))).toBe(false);
  });
  it('keeps a planned credit (negative amount)', () => {
    expect(isPending(income({ total_amount: '-200' }))).toBe(true);
  });
});

describe('pendingInvoicingRows', () => {
  it('dates a row by the "Previsió fac." and falls back to the payment date', () => {
    const rows = pendingInvoicingRows([
      project([
        income({ id: 1, date_estimate_document: '2026-10-31', date: '2026-11-30' }),
        income({ id: 2, date: '2026-12-31' }),
        income({ id: 3 }),
      ]),
    ]);
    expect(rows.map((r) => [r.id, r.date, r.date_source])).toEqual([
      [1, '2026-10-31', 'invoice'],
      [2, '2026-12-31', 'payment'],
      [3, null, null],
    ]);
  });

  it('adds VAT from the line, else from its income type', () => {
    const rows = pendingInvoicingRows([
      project([
        income({ id: 1, vat_pct: 21 }),
        income({ id: 2, vat_pct: null, income_type: { id: 2, name: 'Subvenció pública', vat_pct: '0.00' } }),
        income({ id: 3, vat_pct: 0, income_type: { id: 1, name: 'Factura', vat_pct: '21.00' } }),
      ]),
    ]);
    expect(rows.map((r) => [r.base, r.total])).toEqual([
      [1000, 1210],
      [1000, 1000],
      [1000, 1000],
    ]);
    expect(rows[1].income_type_name).toBe('Subvenció pública');
  });

  it('carries the project, its state and leader, and the client (line first, then project)', () => {
    const [own, fallback] = pendingInvoicingRows([
      project([income({ id: 1, client: { id: 2, name: 'Ajuntament' } }), income({ id: 2 })]),
    ]);
    expect(own).toMatchObject({
      project_id: 7,
      state_id: 1,
      state_name: 'Actiu',
      leader_name: 'Laia Puig',
      client_name: 'Ajuntament',
      client_from_project: false,
      phase_name: 'Fase 1',
    });
    expect(fallback).toMatchObject({ client_name: 'Ateneu', client_from_project: true });
  });

  it('leaves out mother projects and tolerates missing relations', () => {
    const rows = pendingInvoicingRows([
      project([income()], { is_mother: true }),
      { id: 8, name: 'Sense res', project_phases: [{ incomes: [income({ id: 9 })] }] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 9, state_id: null, leader_name: null, client_name: null });
  });
});

describe('invoicedByMonth', () => {
  it('sums the base per month from the given date, rectifying invoices subtracting', () => {
    expect(
      invoicedByMonth(
        [
          { emitted: '2026-05-03', total_base: '100.10' },
          { emitted: '2026-05-20', total_base: '-20.05' },
          { emitted: '2026-06-01', total_base: '50' },
          { emitted: '2025-01-01', total_base: '999' },
          { emitted: null, total_base: '1' },
        ],
        '2025-11-01',
      ),
    ).toEqual({ '2026-05': 80.05, '2026-06': 50 });
  });
});

describe('wiring', () => {
  it('populates every relation the rows read', () => {
    expect(Object.keys(PROJECT_POPULATE)).toEqual(
      expect.arrayContaining(['project_state', 'leader', 'clients', 'project_phases']),
    );
    expect(Object.keys(PROJECT_POPULATE.project_phases.populate.incomes.populate)).toEqual(
      expect.arrayContaining(['client', 'income_type', 'invoice', 'income']),
    );
  });

  it('grants the action to logged-in users', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/bootstrap-permissions.js'), 'utf8');
    expect(src).toMatch(/treasury: \[[^\]]*'invoicingForecast'/);
  });

  it('answers rows and invoiced months from the controller', async () => {
    jest.resetModules();
    const findMany = jest.fn(async () => []);
    findMany.mockResolvedValueOnce([project([income()])]);
    findMany.mockResolvedValueOnce([{ emitted: '2099-01-01', total_base: '10' }]);
    global.strapi = { db: { query: () => ({ findMany }) } };
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, fn) => fn({ strapi: global.strapi }) } }));
    const controller = require('../src/api/treasury/controllers/treasury');
    const ctx = { query: {} };
    await controller.invoicingForecast(ctx);
    expect(ctx.body.rows).toHaveLength(1);
    expect(ctx.body.invoiced_by_month).toEqual({ '2099-01': 10 });
    expect(findMany.mock.calls[0][0].populate).toEqual(PROJECT_POPULATE);
  });
});
