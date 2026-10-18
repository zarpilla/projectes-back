'use strict';

/**
 * issues/155 (2026-10-18), logistics billing details found while writing the
 * manual (chapter 33):
 *  - the concept «Serveis logístics <mes>» took the month of the first order's
 *    route date, while «Facturar» groups the orders by estimated delivery
 *    month: an order routed in late September and delivered in October read
 *    «setembre» on the October invoice;
 *  - the member's login reminder counted `paid !== true` while her «Factures»
 *    list goes by `paid_date` (invoice 2026-210 had `paid` NULL and a paid
 *    date): one rule now, the paid date; drafts are not hers yet either.
 */

const path = require('path');

describe('invoice concept month (issues/155)', () => {
  const { invoiceConcept } = require('../src/api/order/services/invoice-line-concept');

  it('names the estimated delivery month the orders are grouped by', () => {
    expect(
      invoiceConcept([
        { route_date: '2026-09-29', estimated_delivery_date: '2026-10-01' },
        { route_date: '2026-10-05', estimated_delivery_date: '2026-10-06' },
      ]),
    ).toBe('Serveis logístics octubre 2026');
  });

  it('names the first and last month when the orders span several', () => {
    expect(
      invoiceConcept([
        { estimated_delivery_date: '2026-10-06' },
        { estimated_delivery_date: '2026-09-30' },
      ]),
    ).toBe('Serveis logístics setembre - octubre 2026');
    expect(
      invoiceConcept([{ estimated_delivery_date: '2026-12-30' }, { estimated_delivery_date: '2027-01-02' }]),
    ).toBe('Serveis logístics desembre 2026 - gener 2027');
  });

  it('falls back to the route date', () => {
    expect(invoiceConcept([{ route_date: '2026-08-14' }])).toBe('Serveis logístics agost 2026');
  });
});

describe("the member's unpaid invoices reminder (issues/155)", () => {
  let ctrl;

  beforeEach(() => {
    jest.resetModules();
    const ct = { uid: 'api::emitted-invoice.emitted-invoice', modelName: 'emitted-invoice', apiName: 'emitted-invoice', kind: 'collectionType', attributes: {} };
    global.strapi = {
      contentType: () => ct,
      contentTypes: { [ct.uid]: ct },
      db: {
        query: (uid) => ({
          findMany: async () =>
            uid === 'api::contact.contact'
              ? [{ id: 7 }]
              : [
                  { id: 1, state: 'real', sent: true, paid: null, paid_date: '2026-10-01' },
                  { id: 2, state: 'real', sent: true, paid: true, paid_date: null },
                  { id: 3, state: 'real', sent: true, paid: false, paid_date: null },
                  { id: 4, state: 'draft', sent: true, paid: false, paid_date: null },
                  { id: 5, state: 'real', sent: false, paid: false, paid_date: null },
                ],
        }),
      },
    };
    ctrl = require(path.join(__dirname, '..', 'src', 'api', 'emitted-invoice', 'controllers', 'emitted-invoice.js'))({
      strapi: global.strapi,
    });
  });

  afterEach(() => {
    delete global.strapi;
  });

  it('counts the sent, issued invoices without a paid date, as the list does', async () => {
    const res = await ctrl.pendingProvider({ state: { user: { id: 100 } } });
    expect(res.invoices.map((i) => i.id)).toEqual([2, 3]);
  });
});
