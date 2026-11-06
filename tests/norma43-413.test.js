'use strict';

/**
 * issues/413 (2026-11-06): «Conciliació» reads the bank statements as Norma
 * 43 files (AEB «Cuaderno 43»), the format every Spanish bank lets you
 * download. The parser must read the movements with their sign, dates and
 * concepts, check the account footer against them (an incomplete download must
 * not be imported), and find the account among the entity's IBANs (the file
 * only has the CCC without check digits).
 */

const { parseNorma43, matchesIban, Norma43Error } = require('../src/services/norma43');
const { norma43File } = require('./helpers/norma43-file');

const ACCOUNT = {
  bank: '3025',
  branch: '0001',
  account: '1234567890',
  start: '2026-10-01',
  end: '2026-10-31',
  opening: 1500.25,
  movements: [
    { date: '2026-10-03', value: '2026-10-04', amount: 1210, concept: 'TRANSF DE CLIENTA SCCL', concept2: 'FRA 2026-0042', document: '0000000001' },
    { date: '2026-10-15', amount: -36.3, concept: 'COMISSIO MANTENIMENT', ref2: 'REF000123' },
    { date: '2026-10-15', amount: -36.3, concept: 'COMISSIO MANTENIMENT', ref2: 'REF000123' },
  ],
};

describe('parseNorma43 (issues/413)', () => {
  it('reads the account, its movements and its balances', () => {
    const { accounts } = parseNorma43(norma43File([ACCOUNT]));
    expect(accounts).toHaveLength(1);
    const a = accounts[0];
    expect(a).toMatchObject({
      bank: '3025',
      branch: '0001',
      account: '1234567890',
      ccc: '302500011234567890',
      start: '2026-10-01',
      end: '2026-10-31',
      opening: 1500.25,
      closing: 2637.65,
      currency: '978',
      name: 'COOPERATIVA',
    });
    expect(a.movements).toHaveLength(3);
    expect(a.movements[0]).toMatchObject({
      date: '2026-10-03',
      value_date: '2026-10-04',
      amount: 1210,
      document: '0000000001',
      concept: 'TRANSF DE CLIENTA SCCL FRA 2026-0042',
    });
    expect(a.movements[1]).toMatchObject({ date: '2026-10-15', amount: -36.3, concept: 'COMISSIO MANTENIMENT', reference2: 'REF000123' });
  });

  it('reads several accounts in one file, and a negative balance', () => {
    const second = { ...ACCOUNT, account: '9999999999', opening: -20, movements: [{ date: '2026-10-02', amount: 50, concept: 'X' }] };
    const { accounts } = parseNorma43(norma43File([ACCOUNT, second]));
    expect(accounts.map((a) => a.account)).toEqual(['1234567890', '9999999999']);
    expect(accounts[1].opening).toBe(-20);
    expect(accounts[1].closing).toBe(30);
  });

  it('refuses a statement whose footer does not add up (an incomplete download)', () => {
    const file = norma43File([ACCOUNT]).split('\r\n');
    const truncated = file.filter((l, i) => i !== 3 && i !== 4).join('\r\n');
    expect(() => parseNorma43(truncated)).toThrow(/no quadra/);
  });

  it('refuses a file that is not Norma 43', () => {
    expect(() => parseNorma43('Data;Concepte;Import\n01/10/2026;X;10\n')).toThrow(Norma43Error);
    expect(() => parseNorma43('')).toThrow(/buit/);
    expect(() => parseNorma43(norma43File([ACCOUNT], { footer: false }))).toThrow(/tancament/);
  });
});

describe('matchesIban (issues/413)', () => {
  const a = { bank: '3025', branch: '0001', account: '1234567890' };
  it('compares bank, branch and account, skipping the check digits', () => {
    expect(matchesIban('ES91 3025 0001 1112 3456 7890', a)).toBe(true);
    expect(matchesIban('es9130250001111234567890', a)).toBe(true);
    expect(matchesIban('ES91 3025 0002 1112 3456 7890', a)).toBe(false);
    expect(matchesIban('FR7630006000011234567890189', a)).toBe(false);
    expect(matchesIban(null, a)).toBe(false);
  });
});
