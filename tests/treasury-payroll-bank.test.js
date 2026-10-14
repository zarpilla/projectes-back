'use strict';

/**
 * issues/042 — bestretes (payrolls) are sometimes paid from a bank other than
 * the main one. The bank chosen on the payroll must be the one Tresoreria
 * shows for its net payment; payrolls without one fall back to the payroll
 * bank, then to the default bank.
 */

const { payrollNetBankAccountName } = require('../src/api/treasury/services/payroll-bank');

const me = {
  bank_account_default: { id: 1, name: 'Cajamar' },
  bank_account_payroll: { id: 2, name: 'Cajamar nòmines' },
};

describe('payroll net payment bank account', () => {
  it("uses the payroll's own bank account", () => {
    const payroll = { bank_account: { id: 3, name: 'Triodos' } };
    expect(payrollNetBankAccountName(payroll, me)).toBe('Triodos');
  });

  it('falls back to the payroll bank account', () => {
    expect(payrollNetBankAccountName({ bank_account: null }, me)).toBe('Cajamar nòmines');
  });

  it('falls back to the default bank account', () => {
    expect(payrollNetBankAccountName({}, { bank_account_default: me.bank_account_default })).toBe('Cajamar');
  });

  it('returns null when no bank is set anywhere', () => {
    expect(payrollNetBankAccountName({}, {})).toBeNull();
  });
});

describe('treasury forecast', () => {
  it('uses the payroll bank helper for the net payment line', () => {
    const fs = require('fs');
    const path = require('path');
    const controller = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'api', 'treasury', 'controllers', 'treasury.js'),
      'utf8',
    );
    expect(controller).toMatch(/bank_account:\s*payrollNetBankAccountName\(e, me\)/);
  });
});
