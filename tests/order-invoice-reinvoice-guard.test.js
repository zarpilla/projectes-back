'use strict';

/**
 * Regression: 2026-09-30 incident — invoiced orders flipped back to 'delivered'.
 *
 * Chain of events this guards against:
 *
 *   1. POST /api/orders/invoice ran twice on the same selection (slow 16s
 *      responses invited a second click). The second run created a duplicate
 *      ESBORRANY draft and stole the orders' link from the first draft,
 *      leaving the first draft orphaned.
 *   2. The duplicate drafts were later deleted from the invoice list. Each
 *      deletion's beforeDelete bulk-reset the shared orders to 'delivered',
 *      so orders that had been invoiced silently reverted.
 *
 * Two defences, both tested here:
 *   - invoice() never re-invoices an order that is already invoiced or still
 *     linked to an invoice, and serialises concurrent runs per process.
 *   - emitted-invoice beforeDelete returns unlinked orders to a CLEAN
 *     delivered state, clearing the stale emitted_invoice_datetime stamp.
 */

const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'order', 'controllers', 'order.js');
const INVOICE_LIFECYCLES = path.join(
  __dirname, '..', 'src', 'api', 'emitted-invoice', 'content-types', 'emitted-invoice', 'lifecycles.js',
);

const order = (id, extra = {}) => ({
  id,
  status: 'delivered',
  owner: { id: 7 },
  route: { name: 'R1' },
  route_date: '2026-09-15',
  estimated_delivery_date: '2026-09-15',
  price: 10,
  volume_discount: 0,
  multidelivery_discount: 0,
  contact_pickup_discount: 0,
  ...extra,
});

describe('order.invoice re-invoice guard', () => {
  let ctrl;
  let state;

  const buildCtx = (body) => {
    const sent = [];
    return { request: { body }, send: (payload, status) => sent.push({ payload, status }), sent };
  };

  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => {});

    state = {
      orders: [order(1), order(2, { price: 20 })],
      invoices: [],
      links: new Map(), // order_id -> emitted_invoice_id
      sql: [],
      projectsUpdated: [],
      phaseIncomes: [],
      hangSerials: null,
    };

    const ct = {
      uid: 'api::order.order',
      modelName: 'order',
      apiName: 'order',
      kind: 'collectionType',
      attributes: {},
    };
    let nextInvoiceId = 100;

    global.strapi = {
      contentType: () => ct,
      contentTypes: { 'api::order.order': ct },
      log: { warn: () => {}, info: () => {} },
      documents: () => ({ findFirst: async () => null }), // verifactu disabled
      service: () => ({
        create: async ({ data }) => {
          // beforeCreate computes the base from the lines (discounts added).
          const total_base = data.lines.reduce(
            (sum, l) => sum + l.base * l.quantity * (1 - (l.discount || 0) / 100),
            0,
          );
          const invoice = { id: nextInvoiceId++, code: 'ESBORRANY', state: 'draft', total_base, ...data };
          state.invoices.push(invoice);
          return invoice;
        },
      }),
      db: {
        query: (uid) => ({
          findMany: async (args = {}) => {
            if (uid === 'api::serie.serie') {
              if (state.hangSerials) return state.hangSerials;
              return [{ id: 16, name: new Date().getFullYear() }];
            }
            if (uid === 'api::payment-method.payment-method') return [{ id: 3 }];
            if (uid === 'api::contact.contact') {
              return [{ id: 9, name: 'Acme', users_permissions_user: { id: 7 } }];
            }
            if (uid === 'api::order.order') {
              const wanted = args.where && args.where.id && args.where.id.$in;
              return state.orders
                .filter((o) => !wanted || wanted.includes(o.id))
                .map((o) => ({ ...o, emitted_invoice: state.links.get(o.id) || null }));
            }
            return [];
          },
          findOne: async () => ({
            id: 30,
            name: 'P',
            project_phases: [{ id: 1, incomes: [] }, { id: 2, incomes: [] }],
          }),
          create: async ({ data }) => {
            if (uid === 'api::phase-income.phase-income') state.phaseIncomes.push(data);
            return data;
          },
          update: async (args) => {
            state.projectsUpdated.push(args);
            return args.data;
          },
        }),
        connection: (table) => ({ where: () => ({ update: async () => 1 }) }),
      },
    };
    global.strapi.db.connection.raw = async (query, bindings) => {
      state.sql.push({ query, bindings });
      if (/^UPDATE orders SET emitted_invoice_datetime = NOW\(\)/.test(query)) {
        for (const id of bindings) {
          const o = state.orders.find((x) => x.id === id);
          if (o) {
            o.status = 'invoiced';
            o.emitted_invoice_datetime = new Date();
          }
        }
      } else if (/^UPDATE orders SET status = 'delivered'/.test(query)) {
        for (const id of bindings) {
          const o = state.orders.find((x) => x.id === id);
          if (o) {
            o.status = 'delivered';
            o.emitted_invoice_datetime = null;
          }
        }
      } else if (/^DELETE FROM orders_emitted_invoice_lnk/.test(query)) {
        for (const id of bindings) state.links.delete(id);
      } else if (/^INSERT INTO orders_emitted_invoice_lnk/.test(query)) {
        for (let i = 0; i < bindings.length; i += 2) state.links.set(bindings[i], bindings[i + 1]);
      }
      return { affectedRows: bindings.length };
    };

    ctrl = require(CONTROLLER)({ strapi: global.strapi });
  });

  afterEach(() => {
    delete global.strapi;
    jest.restoreAllMocks();
  });

  it('invoices delivered orders and links them to the new draft', async () => {
    const ctx = buildCtx({ orders: [1, 2], project: 30 });
    const res = await ctrl.invoice(ctx);

    expect(ctx.sent).toEqual([]);
    expect(state.invoices).toHaveLength(1);
    expect(state.invoices[0].lines).toHaveLength(2);
    expect(state.links.get(1)).toBe(100);
    expect(state.links.get(2)).toBe(100);
    expect(state.orders.map((o) => o.status)).toEqual(['invoiced', 'invoiced']);
    expect(res.skipped).toEqual([]);
  });

  it('creates the draft\'s income line on the project\'s last phase', async () => {
    // v5 regression: the line used to be pushed into the populated phase and
    // saved through a nested project update, which wrote nothing — every
    // draft reached the project without its income.
    await ctrl.invoice(buildCtx({ orders: [1, 2], project: 30 }));

    expect(state.phaseIncomes).toHaveLength(1);
    expect(state.phaseIncomes[0]).toMatchObject({
      concept: 'Factura #ESBORRANY# - Acme',
      amount: 30,
      total_amount: 30,
      invoice: 100,
      project_phase: 2,
      income_type: 1,
      vat_pct: 21,
    });
  });

  it('takes the income amount from the invoice base, discounts added not compounded', async () => {
    state.orders = [order(1, { price: 10, multidelivery_discount: 20, contact_pickup_discount: 70 })];
    await ctrl.invoice(buildCtx({ orders: [1], project: 30 }));

    // 10 * (1 - 0.90) = 1, as billed — not 10 * 0.8 * 0.3 = 2.4.
    expect(state.phaseIncomes[0].amount).toBeCloseTo(1);
    expect(state.phaseIncomes[0].total_amount).toBeCloseTo(1);
  });

  it('never re-invoices orders that are already invoiced', async () => {
    await ctrl.invoice(buildCtx({ orders: [1, 2], project: 30 }));
    expect(state.invoices).toHaveLength(1);

    // Second run on the same selection (the 2026-09-30 double click).
    const ctx = buildCtx({ orders: [1, 2], project: 30 });
    await ctrl.invoice(ctx);

    expect(state.invoices).toHaveLength(1); // no duplicate draft created
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].status).toBe(409);
    expect(ctx.sent[0].payload.message).toMatch(/ja estan facturades/);
    expect(state.links.get(1)).toBe(100); // first draft keeps its orders
    expect(state.orders.map((o) => o.status)).toEqual(['invoiced', 'invoiced']);
  });

  it('skips only the invoiced orders of a mixed selection', async () => {
    await ctrl.invoice(buildCtx({ orders: [1], project: 30 }));

    const res = await ctrl.invoice(buildCtx({ orders: [1, 2], project: 30 }));

    expect(state.invoices).toHaveLength(2);
    expect(state.invoices[1].lines).toHaveLength(1); // only order 2 re-billed
    expect(res.skipped).toEqual([1]);
    expect(state.links.get(1)).toBe(100); // not stolen by the second draft
    expect(state.links.get(2)).toBe(101);
  });

  it('treats an order still linked to an invoice as invoiced even if its status drifted', async () => {
    // Belt and braces: a reverted order (status 'delivered') that somehow kept
    // its invoice link must not be re-invoiced either.
    state.links.set(1, 77);
    state.links.set(2, 77);

    const ctx = buildCtx({ orders: [1, 2], project: 30 });
    await ctrl.invoice(ctx);

    expect(state.invoices).toHaveLength(0);
    expect(ctx.sent[0].status).toBe(409);
  });

  it('rejects a second concurrent run while one is in flight', async () => {
    let releaseSerials;
    state.hangSerials = new Promise((resolve) => {
      releaseSerials = resolve;
    });

    const first = ctrl.invoice(buildCtx({ orders: [1], project: 30 }));
    await new Promise((r) => setImmediate(r)); // let it reach the serie lookup

    const second = buildCtx({ orders: [2], project: 30 });
    await ctrl.invoice(second);
    expect(second.sent[0].status).toBe(409);
    expect(second.sent[0].payload.message).toMatch(/facturació en curs/);

    releaseSerials([{ id: 16, name: new Date().getFullYear() }]);
    await first;
    expect(state.invoices).toHaveLength(1);

    // The flag is released once the run ends — later runs proceed normally.
    await ctrl.invoice(buildCtx({ orders: [2], project: 30 }));
    expect(state.invoices).toHaveLength(2);
  });
});

describe('emitted-invoice beforeDelete order reset', () => {
  let sql;
  let lifecycles;

  beforeEach(() => {
    jest.resetModules();
    sql = [];
    global.strapi = {
      log: { warn: () => {}, info: () => {} },
      db: {
        query: (uid) => ({
          findOne: async () => ({ id: 55, state: 'draft', projects: [30] }),
          findMany: async () => [{ id: 1 }, { id: 2 }],
          update: async () => ({}),
        }),
        connection: (table) => ({ where: () => ({ update: async () => 1 }) }),
      },
    };
    global.strapi.db.connection.raw = async (query, bindings) => {
      sql.push({ query, bindings });
      return { affectedRows: bindings.length };
    };
    lifecycles = require(INVOICE_LIFECYCLES);
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('returns unlinked orders to a clean delivered state (no stale invoice stamp)', async () => {
    await lifecycles.beforeDelete({ params: { where: { id: 55 } } });

    const update = sql.find((s) => s.query.startsWith('UPDATE orders SET'));
    expect(update.query).toContain("status = 'delivered'");
    expect(update.query).toContain('emitted_invoice_datetime = NULL');
    expect(update.bindings).toEqual([1, 2]);
    expect(sql.some((s) => s.query.startsWith('DELETE FROM orders_emitted_invoice_lnk'))).toBe(true);
  });

  it('still refuses to delete a real invoice', async () => {
    global.strapi.db.query = () => ({
      findOne: async () => ({ id: 55, state: 'real' }),
      findMany: async () => [{ id: 1 }],
      update: async () => ({}),
    });
    await expect(lifecycles.beforeDelete({ params: { where: { id: 55 } } })).rejects.toThrow(
      'Cannot delete a real invoice',
    );
    expect(sql).toEqual([]);
  });
});
