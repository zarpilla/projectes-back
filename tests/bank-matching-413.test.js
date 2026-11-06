'use strict';

/**
 * issues/413 (2026-11-06): «Conciliació» proposes the Tresoreria lines a bank
 * movement can be, and accepts on its own only the clear cases: one line of
 * that exact amount, on the movement's account, close in date or named in the
 * concept. Two candidates of the same amount, another account or two
 * movements wanting the same line stay suggestions. It also finds sums
 * (remittances), partial collections of a document named in the concept,
 * transfers between the entity's own accounts, and the user's rules.
 */

const {
  candidatesFromForecast,
  suggest,
  autoMatches,
  transferPairs,
  ruleFor,
} = require('../src/api/bank-movement/services/matching');

const row = (over) => ({
  type: 'Factura emesa',
  concept: 'F-2026-0042',
  contact: 'Clienta Fruita SCCL',
  contact_nif: 'F12345678',
  total_amount: 1210,
  datef: '20261001',
  bank_account: 'Banc',
  paid: false,
  real: true,
  validation_key: 'emitted-invoices:42',
  is_validated: false,
  settle: { kind: 'emitted-invoices', id: 42 },
  to: '/document/42/emitted-invoices',
  ...over,
});

const movement = (over) => ({ id: 1, amount: 1210, date: '2026-10-03', account: 'Banc', concept: 'TRANSFERENCIA', ...over });

describe('candidatesFromForecast (issues/413)', () => {
  it('keeps pending documents and executed lines not yet validated', () => {
    const lines = candidatesFromForecast([
      row({}),
      row({ settle: null, paid: true, validation_key: 'received-invoices:7', total_amount: -50, concept: 'R-7' }),
      row({ settle: null, paid: true, validation_key: 'payrolls:1', validation_keys: ['payrolls:1', 'payrolls:2'], total_amount: -2000 }),
      row({ settle: null, paid: true, is_validated: true, validation_key: 'received-invoices:8' }),
      row({ settle: null, paid: false, validation_key: null, type: 'Ingrés esperat' }),
      row({ settle: null, paid: false, validation_key: 'payrolls:9', type: 'Nòmina esperada' }),
      row({ settle: null, paid: true, is_real_balance_adjustment: true, validation_key: 'treasuries:3' }),
    ]);
    expect(lines.map((l) => l.id)).toEqual([
      'settle:emitted-invoices:42',
      'keys:received-invoices:7',
      'keys:payrolls:1|payrolls:2',
    ]);
    expect(lines[0]).toMatchObject({ amount: 1210, date: '2026-10-01', pending: true, nif: 'F12345678' });
  });
});

describe('suggest (issues/413)', () => {
  const lines = candidatesFromForecast([row({})]);

  it('accepts on its own one line of the exact amount, on the account, close in date', () => {
    const [best] = suggest(movement({}), lines);
    expect(best).toMatchObject({ kind: 'line', auto: true });
    expect(best.lines[0].id).toBe('settle:emitted-invoices:42');
  });

  it('accepts a late collection when the concept names the invoice', () => {
    const [best] = suggest(movement({ date: '2026-12-20', concept: 'TRANSF FRA F 2026 0042' }), lines);
    expect(best.auto).toBe(true);
  });

  it('only suggests a late collection that names nothing', () => {
    const [best] = suggest(movement({ date: '2026-12-20' }), lines);
    expect(best).toMatchObject({ kind: 'line', auto: false });
  });

  it('only suggests a line of another account', () => {
    const [best] = suggest(movement({ account: 'Altre banc' }), lines);
    expect(best.auto).toBe(false);
  });

  it('only suggests when two lines have the amount', () => {
    const two = candidatesFromForecast([row({}), row({ settle: { kind: 'emitted-invoices', id: 43 }, concept: 'F-43' })]);
    const s = suggest(movement({}), two);
    expect(s).toHaveLength(2);
    expect(s.every((x) => !x.auto)).toBe(true);
  });

  it('never matches the other sign or a date out of the window', () => {
    expect(suggest(movement({ amount: -1210 }), lines)).toEqual([]);
    expect(suggest(movement({ date: '2026-06-01' }), lines)).toEqual([]);
  });

  it('proposes a partial collection of a document named in the concept (NIF or name)', () => {
    const s = suggest(movement({ amount: 500, concept: 'TRANSF CLIENTA FRUITA F12345678' }), lines);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: 'partial', amount: 500, auto: false });
  });

  it('finds lines that add up to the movement (a remittance)', () => {
    const many = candidatesFromForecast([
      row({ settle: null, paid: true, validation_key: 'emitted-invoices:1', total_amount: 100, datef: '20261002' }),
      row({ settle: null, paid: true, validation_key: 'emitted-invoices:2', total_amount: 250.5, datef: '20261002' }),
      row({ settle: null, paid: true, validation_key: 'emitted-invoices:3', total_amount: 49.5, datef: '20261003' }),
    ]);
    const [best] = suggest(movement({ amount: 350.5 }), many);
    expect(best.kind).toBe('lines');
    expect(best.lines.map((l) => l.id).sort()).toEqual(['keys:emitted-invoices:1', 'keys:emitted-invoices:2']);
    expect(best.auto).toBe(false);
  });
});

describe('autoMatches (issues/413)', () => {
  it('leaves out the movements that want the same line', () => {
    const lines = candidatesFromForecast([row({}), row({ settle: null, paid: true, validation_key: 'received-invoices:5', total_amount: -80, concept: 'R-5' })]);
    const out = autoMatches(
      [movement({ id: 1 }), movement({ id: 2, date: '2026-10-02' }), movement({ id: 3, amount: -80, date: '2026-10-01' })],
      lines,
    );
    expect([...out.keys()]).toEqual([3]);
  });
});

describe('transferPairs (issues/413)', () => {
  it('pairs opposite amounts of different accounts, at most 3 days apart', () => {
    const pairs = transferPairs([
      movement({ id: 1, amount: -1000, account: 'A', date: '2026-10-01' }),
      movement({ id: 2, amount: 1000, account: 'B', date: '2026-10-02' }),
      movement({ id: 3, amount: -500, account: 'A', date: '2026-10-01' }),
      movement({ id: 4, amount: 500, account: 'A', date: '2026-10-01' }),
      movement({ id: 5, amount: 500, account: 'B', date: '2026-10-09' }),
    ]);
    expect(pairs.map(([a, b]) => [a.id, b.id])).toEqual([[1, 2]]);
  });
});

describe('ruleFor (issues/413)', () => {
  const rules = [
    { id: 1, pattern: 'comissió', direction: 'out', active: true },
    { id: 2, pattern: 'quota', direction: 'any', bank_account: { name: 'B' }, active: true },
    { id: 3, pattern: 'transf', direction: 'any', active: false },
  ];
  it('matches the text without accents or case, the direction and the account', () => {
    expect(ruleFor(movement({ amount: -3, concept: 'COMISSIO MANTENIMENT' }), rules).id).toBe(1);
    expect(ruleFor(movement({ amount: 3, concept: 'COMISSIO' }), rules)).toBeNull();
    expect(ruleFor(movement({ concept: 'QUOTA' }), rules)).toBeNull();
    expect(ruleFor(movement({ concept: 'QUOTA', account: 'B' }), rules).id).toBe(2);
    expect(ruleFor(movement({ concept: 'TRANSF' }), rules)).toBeNull();
  });
});
