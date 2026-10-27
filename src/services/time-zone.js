'use strict';
/* global strapi */

/**
 * The tenant's time zone, «Zona horària» in Configuració general
 * (`me.time_zone`, Europe/Andorra when empty or unknown).
 *
 * The containers run in UTC, so anything that depends on the calendar day or
 * the hour (the day a form date is stored as, the late-order limits) reads it
 * here instead of the server clock (issues/346). It is kept in memory: read
 * at startup and again whenever `me` is saved (me lifecycles), so the date
 * normalizer, which runs synchronously on every write, can use it.
 */

const DEFAULT_TIME_ZONE = 'Europe/Andorra';

let current = DEFAULT_TIME_ZONE;

/** A valid IANA zone, or the default. */
function validTimeZone(value) {
  const zone = typeof value === 'string' ? value.trim() : '';
  if (!zone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function currentTimeZone() {
  return current;
}

function setTimeZone(value) {
  current = validTimeZone(value);
  return current;
}

/** Read `me.time_zone` into memory; the default when it can't be read. */
async function loadTimeZone() {
  try {
    const me = await strapi.db.query('api::me.me').findOne({ select: ['id', 'time_zone'] });
    return setTimeZone(me && me.time_zone);
  } catch (e) {
    strapi.log.warn(`time zone: kept ${current} (${e.message})`);
    return current;
  }
}

module.exports = { DEFAULT_TIME_ZONE, currentTimeZone, loadTimeZone, setTimeZone, validTimeZone };
