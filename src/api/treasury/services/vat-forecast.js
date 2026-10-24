'use strict';

const moment = require('moment');
const { deductibleVatPctForYear } = require('../../project/services/projectFinancials');

/**
 * The forecast VAT of a project line (issues/072): added to the totals and to
 * its quarter, unless the line's date is before the current quarter. Those
 * quarters are already settled (or the date is a typo, like 2001), so such a
 * line is only listed, flagged `outdated`, for the user to fix its date.
 *
 * kind: 'paid' (supported VAT, expenses) or 'received' (charged VAT, incomes).
 */
function addExpectedVat(vatExpected, byQuarter, { kind, amount, date, document }, now = moment()) {
  const day = moment(date, 'YYYY-MM-DD');
  if (day.isBefore(moment(now).startOf('quarter'), 'day')) {
    vatExpected.documents.push({ ...document, outdated: true });
    return false;
  }
  vatExpected[kind] += amount;
  vatExpected.documents.push(document);

  const year = day.year();
  const quarter = day.quarter();
  const key = `${year}-Q${quarter}`;
  if (!byQuarter[key]) {
    byQuarter[key] = { year, quarter, paid: 0, received: 0 };
  }
  byQuarter[key][kind] += amount;
  return true;
}

/**
 * Sets each forecast quarter's deductible VAT % and deductible supported VAT:
 * the quarter's year %, Configuració's only as fallback, like executed VAT and
 * the economic forecast (issues/221). Also sets the totals' deductible_paid.
 */
function applyExpectedVatPct(vatExpected, byQuarter, deductibleVatPctByYear, fallback_deductible_vat_pct) {
  let deductiblePaid = 0;
  for (const q of Object.values(byQuarter)) {
    q.deductible_vat_pct = deductibleVatPctForYear(
      deductibleVatPctByYear,
      fallback_deductible_vat_pct,
      q.year,
    );
    q.deductible_paid = (q.paid * q.deductible_vat_pct) / 100;
    deductiblePaid += q.deductible_paid;
  }
  vatExpected.deductible_paid = deductiblePaid;
}

/**
 * The deadline of a quarter's VAT return (model 303): the 20th of April, July
 * and October for Q1–Q3, 30 January for Q4. They were the other way round
 * (30th, and 20 January) until issues/337.
 */
function vatPaymentDate(year, quarter) {
  const date = moment(`${year}`, 'YYYY').quarter(quarter).endOf('quarter').add(1, 'month').startOf('day');
  return date.date(quarter === 4 ? 30 : 20);
}

module.exports = { addExpectedVat, applyExpectedVatPct, vatPaymentDate };
