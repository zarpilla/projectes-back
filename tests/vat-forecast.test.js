'use strict';

/**
 * issues/072 (2026-10-16): the VAT forecast took every unpaid project line
 * with a date, so a line dated 2001 (typo) or in 2021 T3 became a forecast
 * quarter and a forecast VAT payment. Lines dated before the current quarter
 * are now only listed, flagged `outdated`.
 */

const moment = require('moment');
const { addExpectedVat } = require('../src/api/treasury/services/vat-forecast');

const now = moment('2026-10-17');
const doc = (date) => ({ id: date, date });

describe('forecast VAT (issues/072)', () => {
  it('groups current and future lines by quarter', () => {
    const totals = { paid: 0, received: 0, documents: [] };
    const byQuarter = {};
    addExpectedVat(totals, byQuarter, { kind: 'received', amount: 21, date: '2026-10-01', document: doc('2026-10-01') }, now);
    addExpectedVat(totals, byQuarter, { kind: 'paid', amount: 4, date: '2027-02-10', document: doc('2027-02-10') }, now);
    expect(byQuarter).toEqual({
      '2026-Q4': { year: 2026, quarter: 4, paid: 0, received: 21 },
      '2027-Q1': { year: 2027, quarter: 1, paid: 4, received: 0 },
    });
    expect(totals).toMatchObject({ paid: 4, received: 21 });
    expect(totals.documents.every((d) => !d.outdated)).toBe(true);
  });

  it('only lists, flagged, the lines dated before the current quarter', () => {
    const totals = { paid: 0, received: 0, documents: [] };
    const byQuarter = {};
    expect(addExpectedVat(totals, byQuarter, { kind: 'paid', amount: 10, date: '2001-05-01', document: doc('2001-05-01') }, now)).toBe(false);
    addExpectedVat(totals, byQuarter, { kind: 'received', amount: 5, date: '2026-09-30', document: doc('2026-09-30') }, now);
    expect(byQuarter).toEqual({});
    expect(totals).toMatchObject({ paid: 0, received: 0 });
    expect(totals.documents).toEqual([
      { id: '2001-05-01', date: '2001-05-01', outdated: true },
      { id: '2026-09-30', date: '2026-09-30', outdated: true },
    ]);
  });
});
