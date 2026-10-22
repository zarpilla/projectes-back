'use strict';

/**
 * 2026-10-16: with several bank accounts, Tresoreria showed the same balance
 * for every account (the "Avui" row of Triodos, Paypal and Efectiu all said
 * 124.094,60 €) and a real balance noted for one account replaced the total of
 * all of them. The rows filtered by account were walked with a single balance.
 * walkBalances keeps one balance per account and the total as their sum.
 */
const { walkBalances } = require('../src/api/treasury/services/balances');

const rows = () => [
  { bank_account: 'A', total_amount: 0, is_balance_annotation: true, account_balance: 100 },
  { bank_account: 'B', total_amount: 0, is_balance_annotation: true, account_balance: 50 },
  { bank_account: 'A', total_amount: -10 },
  { bank_account: 'B', total_amount: 5 },
  { bank_account: null, total_amount: 1 },
  { bank_account: 'B', is_real_balance_adjustment: true, desired_balance: 60, total_amount: 0 },
];

describe('walkBalances', () => {
  test('one balance per account, the total as their sum', () => {
    const out = walkBalances(rows());
    expect(out.map((r) => r.account_subtotal)).toEqual([100, 50, 90, 55, 1, 60]);
    expect(out.map((r) => r.subtotal)).toEqual([100, 150, 140, 145, 146, 151]);
  });

  test('a real balance noted for one account does not replace the total', () => {
    const out = walkBalances(rows());
    // B snaps to 60 (was 55): the total moves by +5, not to 60
    expect(out[5].total_amount).toBe(5);
    expect(out[5].subtotal).toBe(151);
  });

  test('a single account behaves as before', () => {
    const out = walkBalances([
      { bank_account: 'A', total_amount: 10 },
      { bank_account: 'A', total_amount: -3 },
    ]);
    expect(out.map((r) => [r.subtotal, r.account_subtotal])).toEqual([[10, 10], [7, 7]]);
  });

  // issues/316: Miceli has one account («-») and no default; the documents had
  // no account and the «saldo real» of 1/1 was on «-», so the adjustment was
  // worked out from 0 and added to the 103.883,70 € of 2025 (149.174,84 €).
  test('the rows without an account count in the default account', () => {
    const miceli = () => [
      { bank_account: null, total_amount: 103883.7 },
      { bank_account: '-', is_real_balance_adjustment: true, desired_balance: 45291.14, total_amount: 0 },
      { bank_account: null, total_amount: -12 },
    ];
    const out = walkBalances(miceli(), { defaultAccount: '-' });
    expect(out[1].total_amount).toBe(-58592.56);
    expect(out.map((r) => r.subtotal)).toEqual([103883.7, 45291.14, 45279.14]);
    expect(out.map((r) => r.account_subtotal)).toEqual([103883.7, 45291.14, 45279.14]);
  });
});
