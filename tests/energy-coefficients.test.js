'use strict';

/**
 * Comunitat energètica: the history of distribution coefficients (2026-10-25).
 * A change adds a row and closes the one in force the day before; rows of a
 * CUPS in an installation never overlap; deleting the last change undoes it.
 */
const rules = require('../src/services/energy-coefficients');

describe('energy coefficients history', () => {
  test('dates', () => {
    expect(rules.dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(rules.dayBefore('2024-03-01')).toBe('2024-02-29');
    expect(rules.dayAfter('2026-12-31')).toBe('2027-01-01');
    expect(rules.isActiveOn({ start_date: '2026-01-01', end_date: null }, '2030-01-01')).toBe(true);
    expect(rules.isActiveOn({ start_date: '2026-01-01', end_date: '2026-06-30' }, '2026-07-01')).toBe(false);
  });

  test('coefficients are numbers from 0 to 1, 6 decimals, comma accepted', () => {
    expect(rules.parseCoefficient('0,1234567')).toBe(0.123457);
    expect(rules.parseCoefficient(1)).toBe(1);
    expect(() => rules.parseCoefficient('1.2')).toThrow('entre 0 i 1');
    expect(() => rules.parseCoefficient('')).toThrow('número');
    expect(() => rules.parseCoefficient(-0.1)).toThrow('entre 0 i 1');
  });

  test('the first coefficient opens a period in force', () => {
    expect(rules.planAdd([], { start_date: '2026-01-01', coefficient: '0.05' })).toEqual({
      updates: [],
      remove: [],
      create: { start_date: '2026-01-01', end_date: null, coefficient: 0.05 },
    });
  });

  test('a change closes the coefficient in force the day before', () => {
    const rows = [{ id: 1, start_date: '2026-01-01', end_date: null, coefficient: 0.05 }];
    expect(rules.planAdd(rows, { start_date: '2026-07-01', coefficient: 0.08 })).toEqual({
      updates: [{ id: 1, data: { end_date: '2026-06-30' } }],
      remove: [],
      create: { start_date: '2026-07-01', end_date: null, coefficient: 0.08 },
    });
  });

  test('a change in the middle of the history ends where the next one starts', () => {
    const rows = [
      { id: 1, start_date: '2026-01-01', end_date: '2026-06-30', coefficient: 0.05 },
      { id: 2, start_date: '2026-07-01', end_date: null, coefficient: 0.08 },
    ];
    const plan = rules.planAdd(rows, { start_date: '2026-04-01', coefficient: 0.06 });
    expect(plan.updates).toEqual([{ id: 1, data: { end_date: '2026-03-31' } }]);
    expect(plan.create).toEqual({ start_date: '2026-04-01', end_date: '2026-06-30', coefficient: 0.06 });
  });

  test('the same start day corrects that row; 0 removes it', () => {
    const rows = [{ id: 1, start_date: '2026-01-01', end_date: null, coefficient: 0.05 }];
    expect(rules.planAdd(rows, { start_date: '2026-01-01', coefficient: 0.07 })).toEqual({
      updates: [{ id: 1, data: { coefficient: 0.07 } }],
      create: null,
      remove: [],
    });
    expect(rules.planAdd(rows, { start_date: '2026-01-01', coefficient: 0 }).remove).toEqual([1]);
  });

  test('0 from a date only closes the coefficient: the CUPS leaves', () => {
    const rows = [{ id: 1, start_date: '2026-01-01', end_date: null, coefficient: 0.05 }];
    expect(rules.planAdd(rows, { start_date: '2027-01-01', coefficient: 0 })).toEqual({
      updates: [{ id: 1, data: { end_date: '2026-12-31' } }],
      create: null,
      remove: [],
    });
  });

  test('a row corrected by hand may not overlap another', () => {
    const others = [
      { id: 1, start_date: '2026-01-01', end_date: '2026-06-30', coefficient: 0.05 },
      { id: 2, start_date: '2026-07-01', end_date: null, coefficient: 0.08 },
    ];
    expect(() =>
      rules.checkRow(others, { id: 1, start_date: '2026-01-01', end_date: '2026-07-15', coefficient: 0.05 }),
    ).toThrow('Se solapa');
    expect(
      rules.checkRow(others, {
        id: 1,
        start_date: '2026-02-01',
        end_date: '2026-06-30',
        coefficient: '0,04',
      }),
    ).toEqual({
      start_date: '2026-02-01',
      end_date: '2026-06-30',
      coefficient: 0.04,
    });
    expect(() =>
      rules.checkRow([], { id: 3, start_date: '2026-05-01', end_date: '2026-04-01', coefficient: 0.1 }),
    ).toThrow('anterior');
  });

  test('deleting the last change reopens the previous coefficient', () => {
    const rows = [
      { id: 1, start_date: '2026-01-01', end_date: '2026-06-30', coefficient: 0.05 },
      { id: 2, start_date: '2026-07-01', end_date: null, coefficient: 0.08 },
    ];
    expect(rules.planDelete(rows, 2)).toEqual({ updates: [{ id: 1, data: { end_date: null } }] });
    expect(rules.planDelete(rows, 1)).toEqual({ updates: [] });
  });

  test('a new distribution: changed, new and leaving CUPS', () => {
    const rows = [
      { id: 1, supply: 10, start_date: '2026-01-01', end_date: null, coefficient: 0.5 },
      { id: 2, supply: 11, start_date: '2026-01-01', end_date: null, coefficient: 0.5 },
      { id: 3, supply: 12, start_date: '2025-01-01', end_date: '2025-12-31', coefficient: 0.2 },
    ];
    const plan = rules.planDistribution(rows, '2027-01-01', [
      { supply: 10, coefficient: 0.4 },
      { supply: { id: 13 }, coefficient: 0.3 },
    ]);
    expect(plan.updates).toEqual([
      { id: 1, data: { end_date: '2026-12-31' } },
      { id: 2, data: { end_date: '2026-12-31' } },
    ]);
    expect(plan.creates).toEqual([
      { supply: 10, start_date: '2027-01-01', end_date: null, coefficient: 0.4 },
      { supply: 13, start_date: '2027-01-01', end_date: null, coefficient: 0.3 },
    ]);
    expect(plan.remove).toEqual([]);
  });

  test('a distribution refuses the same CUPS twice', () => {
    expect(() =>
      rules.planDistribution([], '2027-01-01', [
        { supply: 1, coefficient: 0.1 },
        { supply: 1, coefficient: 0.2 },
      ]),
    ).toThrow('dues vegades');
  });

  test('summary: sum, free share, over 1 and kW per row', () => {
    const rows = [
      { id: 1, start_date: '2026-01-01', end_date: null, coefficient: 0.25 },
      { id: 2, start_date: '2026-01-01', end_date: null, coefficient: 0.5 },
      { id: 3, start_date: '2025-01-01', end_date: '2025-12-31', coefficient: 0.9 },
    ];
    const s = rules.summarize(rows, '2026-05-01', '40.00');
    expect(s.sum).toBe(0.75);
    expect(s.free).toBe(0.25);
    expect(s.over).toBe(false);
    expect(s.kw_assigned).toBe(30);
    expect(s.rows.map((r) => r.kw)).toEqual([10, 20]);
    expect(rules.summarize(rows, '2025-05-01', null)).toMatchObject({ sum: 0.9, kw_assigned: null });
    expect(
      rules.summarize([...rows, { id: 4, start_date: '2026-01-01', coefficient: 0.3 }], '2026-05-01', 1).over,
    ).toBe(true);
  });
});
