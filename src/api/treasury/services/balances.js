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
 */
const applyRowToBalance = (row, currentAccountBalance) => {
  if (row.is_real_balance_adjustment) {
    const desiredBalance = row.desired_balance;
    const adjustment = desiredBalance - currentAccountBalance;
    row.total_amount = adjustment;
    return { accountBalance: desiredBalance, delta: adjustment };
  }
  if (row.is_balance_annotation && row.account_balance !== undefined) {
    const adjustment = row.account_balance - currentAccountBalance;
    return { accountBalance: row.account_balance, delta: adjustment };
  }
  return { accountBalance: currentAccountBalance + row.total_amount, delta: row.total_amount };
};

const walkBalances = (rows) => {
  const balanceByAccount = {};
  let subtotal = 0;
  return rows.map((row) => {
    const account = row.bank_account || 'default';
    if (balanceByAccount[account] === undefined) balanceByAccount[account] = 0;
    const { accountBalance, delta } = applyRowToBalance(row, balanceByAccount[account]);
    balanceByAccount[account] = accountBalance;
    subtotal += delta;
    return { ...row, subtotal, account_subtotal: accountBalance };
  });
};

module.exports = { applyRowToBalance, walkBalances };
