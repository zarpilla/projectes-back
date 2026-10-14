'use strict';

/**
 * Bank account of a payroll's net payment (the bestreta) in Tresoreria.
 *
 * A payroll gets the payroll bank account when it is created (payroll
 * lifecycles), but it can be paid from another bank, so the one chosen on the
 * payroll wins (issues/042). IRPF, SS and "other" lines keep their configured
 * banks. Older payrolls with no bank fall back to the payroll bank, then to
 * the default one.
 */
const payrollNetBankAccountName = (payroll, me) => {
  const candidates = [
    payroll && payroll.bank_account,
    me && me.bank_account_payroll,
    me && me.bank_account_default,
  ];
  const account = candidates.find((a) => a && a.name);
  return account ? account.name : null;
};

module.exports = { payrollNetBankAccountName };
