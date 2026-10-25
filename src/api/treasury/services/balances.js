'use strict';

/**
 * Running balances of the treasury rows (already sorted by date): one balance
 * per bank account (`account_subtotal`, rows without an account count as
 * 'default') and the total of the accounts walked (`subtotal`).
 *
 * 2026-10-16: with the bank-account filter (the front always sends the
 * selected accounts, all of them by default) the rows were walked with a
 * single balance, so every account showed the combined balance and a real
 * balance noted for one account replaced the total of all of them.
 *
 * A real-balance adjustment sets its row's amount to the difference (as before).
 * Noted balances («Saldo real ajustat», «Saldo bancari») also carry
 * `balance_delta`, the difference they made to the balance (issues/252).
 *
 * Rows without an account belong to `defaultAccount` (the default bank account,
 * or the only one). Miceli has one account and no default: its documents had no
 * account and the «saldo real» of 1/1/2026 was on that account, so the
 * adjustment was worked out from 0 and added to the balance of 2025 (issues/316).
 */
// Balances to cents: summing floats left saldos like 16976.9743000003 in the
// Tresoreria export (issues/277).
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const applyRowToBalance = (row, currentAccountBalance) => {
  if (row.is_real_balance_adjustment) {
    const desiredBalance = row.desired_balance;
    const adjustment = round2(desiredBalance - currentAccountBalance);
    row.total_amount = adjustment;
    return { accountBalance: desiredBalance, delta: adjustment };
  }
  if (row.is_balance_annotation && row.account_balance !== undefined) {
    const adjustment = round2(row.account_balance - currentAccountBalance);
    return { accountBalance: row.account_balance, delta: adjustment };
  }
  return { accountBalance: round2(currentAccountBalance + row.total_amount), delta: row.total_amount };
};

const walkBalances = (rows, { defaultAccount = null } = {}) => {
  const balanceByAccount = {};
  let subtotal = 0;
  return rows.map((row) => {
    const account = row.bank_account || defaultAccount || 'default';
    if (balanceByAccount[account] === undefined) balanceByAccount[account] = 0;
    const { accountBalance, delta } = applyRowToBalance(row, balanceByAccount[account]);
    balanceByAccount[account] = accountBalance;
    subtotal = round2(subtotal + delta);
    // what a noted balance moved the saldo: the monthly table of Tresoreria
    // adds it when the row comes after the mode's start (issues/252)
    const noted = row.is_real_balance_adjustment || row.is_balance_annotation;
    return { ...row, subtotal, account_subtotal: accountBalance, ...(noted ? { balance_delta: delta } : {}) };
  });
};

/**
 * Rows by date. Within a day the noted balances come first, then the "Inici Any"
 * / "Avui" markers, then the movements: a marker is the balance at the start of
 * its day. The forecast project rows were pushed before "Avui", so a forecast
 * dated today counted in the «Saldo avui» seed and again in «Des d'avui»: the two
 * Tresoreria modes ended the year 22,61 € apart on La Diligència (issues/252).
 */
const dayRank = (row) =>
  row.is_balance_annotation || row.is_real_balance_adjustment
    ? 0
    : row.type === 'Inici Any' || row.type === 'Avui'
      ? 1
      : 2;

const sortRows = (rows) =>
  rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) =>
      a.row.datef < b.row.datef
        ? -1
        : a.row.datef > b.row.datef
          ? 1
          : dayRank(a.row) - dayRank(b.row) || a.i - b.i,
    )
    .map(({ row }) => row);

module.exports = { applyRowToBalance, walkBalances, sortRows, round2 };
