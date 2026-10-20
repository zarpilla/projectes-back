'use strict';

/**
 * A project's end date can't come before its start (issues/212: Final
 * 01/01/2025 with Inici 01/01/2026 was stored). Dates compare by day in the
 * server's time zone, as Strapi stores a `date` it receives as a timestamp.
 */
const moment = require('moment');

const PROJECT_DATES_MESSAGE = "La data final no pot ser anterior a la data d'inici";

const touchesDates = (data) => !!data && ('date_start' in data || 'date_end' in data);

/** The message refusing the dates of `data` (merged over `stored`), or null. */
const projectDatesError = (data, stored = {}) => {
  const merged = { ...(stored || {}), ...(data || {}) };
  if (!merged.date_start || !merged.date_end) return null;
  const start = moment(merged.date_start);
  const end = moment(merged.date_end);
  if (!start.isValid() || !end.isValid()) return null;
  return end.isBefore(start, 'day') ? PROJECT_DATES_MESSAGE : null;
};

module.exports = { PROJECT_DATES_MESSAGE, touchesDates, projectDatesError };
