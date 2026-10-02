'use strict';
/* global strapi */

/**
 * Store `date` attributes as the calendar day in the app's timezone.
 *
 * The frontend sends datepicker values as local-midnight Dates, which JSON
 * turns into UTC ("2026-09-30" in Madrid -> "2026-09-29T22:00:00.000Z"). v3
 * parsed those back in the server's local time; v5 keeps the first 10 chars
 * (the UTC day), so every save lost a day. Subscribed at the db layer so it
 * covers the document service, raw strapi.db.query writes (updatePhases) and
 * component rows alike.
 */
const DATE_TZ = process.env.APP_TZ || 'Europe/Madrid';
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function toLocalDay(value) {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value === 'string' && DAY_ONLY.test(value)) return value;
  if (typeof value !== 'string' && !(value instanceof Date)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  // sv-SE formats as YYYY-MM-DD
  return d.toLocaleDateString('sv-SE', { timeZone: DATE_TZ });
}

function normalizeDates(data, attributes) {
  if (!data || typeof data !== 'object' || !attributes) return;
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const [key, def] of Object.entries(attributes)) {
      if (def.type === 'date' && key in row) row[key] = toLocalDay(row[key]);
    }
  }
}

function registerDateFieldNormalizer() {
  const handler = (event) => normalizeDates(event.params && event.params.data, event.model && event.model.attributes);
  strapi.db.lifecycles.subscribe({
    beforeCreate: handler,
    beforeCreateMany: handler,
    beforeUpdate: handler,
    beforeUpdateMany: handler,
  });
}

module.exports = { registerDateFieldNormalizer, toLocalDay };
