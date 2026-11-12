'use strict';

/**
 * issues/430 (Joel, la Diligència): the automatic monthly invoicing, its pure
 * part. Second-to-last working day at 14:10; every order expected in the month
 * not cancelled (the user's decision, 2026-11-12) plus the earlier months'
 * ones still not invoiced, under «Serveis pendents mes de …»; one draft per
 * member dated the month's last day, on the project with «Habilitar
 * facturació automàtica» covering that day.
 */

const plan = require('../src/services/monthly-invoicing/plan');
const { lateRules } = require('../src/services/late-order');

const rules = (holidays = []) => lateRules({}, 'Europe/Madrid', { holidays });

describe('when it runs (issues/430)', () => {
  it('the second-to-last working day of the month', () => {
    // October 2026 ends on Saturday 31: Fri 30 is the last, Thu 29 the second-to-last
    expect(plan.invoicingDayOf('2026-10', rules())).toBe('2026-10-29');
    // November 2026 ends on Monday 30: the second-to-last is Friday 27
    expect(plan.invoicingDayOf('2026-11', rules())).toBe('2026-11-27');
    // December 2026: 31 Thursday, 30 Wednesday
    expect(plan.invoicingDayOf('2026-12', rules())).toBe('2026-12-30');
  });

  it('skips the holidays for everyone', () => {
    expect(plan.invoicingDayOf('2026-12', rules(['2026-12-30']))).toBe('2026-12-29');
    expect(plan.invoicingDayOf('2026-12', rules(['2026-12-31']))).toBe('2026-12-29');
  });

  it('is due from 14:10 in the tenant zone on that day, for the rest of the month', () => {
    // 13:05 UTC is 14:05 in Madrid (CET): not yet
    expect(plan.dueRun(new Date('2026-11-27T13:05:00Z'), rules())).toMatchObject({ due: false, month: '2026-11', day: '2026-11-27', at: '2026-11-27 14:10' });
    expect(plan.dueRun(new Date('2026-11-27T13:10:00Z'), rules()).due).toBe(true);
    expect(plan.dueRun(new Date('2026-11-30T09:00:00Z'), rules()).due).toBe(true);
    // the 1st of the next month is another month, not yet due
    expect(plan.dueRun(new Date('2026-12-01T10:00:00Z'), rules())).toMatchObject({ due: false, month: '2026-12' });
  });
});

describe('the project (issues/430)', () => {
  const projects = [
    { id: 1, name: 'Logística T3 2026', auto_invoicing: true, date_start: '2026-07-01', date_end: '2026-09-30' },
    { id: 2, name: 'Logística T4 2026', auto_invoicing: true, date_start: '2026-10-01', date_end: '2026-12-31' },
    { id: 3, name: 'Altre', auto_invoicing: false, date_start: '2026-01-01', date_end: '2026-12-31' },
  ];
  it('is the one with the option whose dates cover the invoice day', () => {
    expect(plan.projectFor(projects, '2026-10-31').project.id).toBe(2);
    expect(plan.projectFor(projects, '2026-09-30').project.id).toBe(1);
    expect(plan.projectFor(projects, '2027-01-31').project).toBeNull();
    expect(plan.projectFor(projects.slice(2), '2026-10-31').project).toBeNull();
  });
});

const owner = (id, name) => ({ id, username: name, fullname: name });
const order = (id, ownerId, day, extra = {}) => ({
  id, owner: owner(ownerId, ownerId === 1 ? 'Formatges' : 'Hortes'), estimated_delivery_date: day,
  status: 'processed', price: 10, route: { name: 'R1' }, ...extra,
});

describe('the plan of a month (issues/430)', () => {
  const contacts = { 1: { id: 11, name: 'Formatges SCCL' }, 2: { id: 12, name: 'Hortes' } };
  const contactOf = (id) => contacts[id] || null;

  it('every order of the month, delivered or not, plus earlier ones not invoiced', () => {
    const p = plan.planMonth({
      month: '2026-10',
      contactOf,
      orders: [
        order(1, 1, '2026-10-05', { status: 'delivered' }),
        order(2, 1, '2026-10-30', { status: 'pending' }),
        order(3, 1, '2026-09-28', { status: 'delivered' }),
        order(4, 1, '2026-10-15', { status: 'cancelled' }),
        order(5, 1, '2026-10-16', { emitted_invoice: { id: 9 } }),
        order(6, 1, '2026-11-02'),
      ],
    });
    expect(p.invoiceDay).toBe('2026-10-31');
    const f = p.owners[0];
    expect(f.current.map((o) => o.id)).toEqual([1, 2]);
    expect(Object.fromEntries(Object.entries(f.previous).map(([k, l]) => [k, l.map((o) => o.id)]))).toEqual({ '2026-09': [3] });
    expect(f.blockers).toEqual([]);
    expect(f.amount).toBe(30);
  });

  it('a member with an order without price, or without contact, gets no draft', () => {
    const p = plan.planMonth({
      month: '2026-10',
      contactOf,
      orders: [order(1, 1, '2026-10-05', { price: null }), order(2, 3, '2026-10-05')],
    });
    const byName = Object.fromEntries(p.owners.map((o) => [o.ownerId, o]));
    expect(byName[1].blockers).toEqual([{ text: 'Comandes sense preu', orders: [1] }]);
    expect(byName[3].blockers).toEqual([{ text: 'La sòcia no té cap contacte per facturar-li', orders: [2] }]);
  });

  it('notes what to look at: earlier orders not delivered, price 0', () => {
    const p = plan.planMonth({
      month: '2026-10',
      contactOf,
      orders: [order(1, 2, '2026-09-10', { status: 'pending' }), order(2, 2, '2026-10-10', { price: 0 })],
    });
    expect(p.owners[0].warnings).toEqual([
      { text: 'Comandes de setembre encara no lliurades', orders: [1] },
      { text: 'Comandes amb preu 0', orders: [2] },
    ]);
    expect(plan.draftNote(p.owners[0])).toBe(
      'Facturació automàtica, per revisar:\n- Comandes de setembre encara no lliurades: 0001\n- Comandes amb preu 0: 0002',
    );
  });

  it('the draft: the month, then each earlier month, labelled', () => {
    const p = plan.planMonth({
      month: '2026-10',
      contactOf,
      orders: [order(1, 1, '2026-10-05'), order(2, 1, '2026-08-20', { status: 'delivered' }), order(3, 1, '2026-09-02', { status: 'delivered' })],
    });
    const lines = plan.draftLines(p.owners[0], (o) => ({ concept: `Comanda ${o.id}` }));
    expect(lines.map((l) => l.concept)).toEqual([
      'Comanda 1',
      "Serveis pendents d'agost 2026 · Comanda 2",
      'Serveis pendents de setembre 2026 · Comanda 3',
    ]);
  });
});

describe('it adds up (issues/430)', () => {
  it('the month expected against invoiced now and before', () => {
    const expected = [
      { id: 1, status: 'delivered', price: 10 },
      { id: 2, status: 'invoiced', price: 5, emitted_invoice: { id: 3 } },
      { id: 3, status: 'processed', price: 7 },
    ];
    const ok = plan.reconcile({ expected, invoicedIds: [1, 3] });
    expect(ok).toMatchObject({ ok: true, expected: { count: 3, amount: 22 }, invoicedNow: { count: 2, amount: 17 }, invoicedBefore: { count: 1, amount: 5 } });
    const short = plan.reconcile({ expected, invoicedIds: [1] });
    expect(short).toMatchObject({ ok: false, missing: { count: 1, amount: 7, orders: [3] } });
  });
});
