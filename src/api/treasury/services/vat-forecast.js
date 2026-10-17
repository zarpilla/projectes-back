'use strict';

const moment = require('moment');

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

module.exports = { addExpectedVat };
