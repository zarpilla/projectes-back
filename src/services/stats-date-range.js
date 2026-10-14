'use strict';

const moment = require('moment');

/**
 * The date range of the year/month filters of the stats endpoints (infoall), as
 * YYYY-MM-DD, or null when there is no year. The stats screens offer the year
 * "Tots" next to a month: that month of every year can't be one range, so the
 * callers filter it after the query (issues/043).
 */
function statsDateRange(year, month) {
  if (!year || isNaN(year)) return null;
  const hasMonth = month && !isNaN(month);
  const from = moment({ year: Number(year), month: hasMonth ? Number(month) - 1 : 0, day: 1 });
  const to = from.clone().endOf(hasMonth ? 'month' : 'year');
  return { from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') };
}

module.exports = { statsDateRange };
