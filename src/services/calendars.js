'use strict';
/* global strapi */

/**
 * Everyone's working periods (daily dedications: dates, hours, cost per hour)
 * and festives, as the project engine reads them (calculateEstimatedTotals),
 * shared by the project form, Ingressos/Despeses, Preu hora, Informes ›
 * Dedicació and the estimated totals through the read cache (issues/307).
 *
 * They replace projectCache.js, which the read cache's change detection can't
 * see (no SQL on its hits) and which went stale on its own: the
 * daily-dedication lifecycles marked it dirty in `before` hooks (a read before
 * the COMMIT kept the old rows), festives had no *Many hooks and raw SQL never
 * marked it.
 *
 * Frozen and shared between requests: don't change what they return. The
 * person is only her id: no whole user rows in memory (password hashes).
 */

const { getReadCache } = require('./read-cache');
const { queryTables } = require('./query-tables');

const DEDICATION = 'api::daily-dedication.daily-dedication';
const FESTIVE = 'api::festive.festive';
const PERSON_ID = { users_permissions_user: { select: ['id'] } };

const declared = new Map();

function kept(key, uid) {
  if (!declared.has(key)) declared.set(key, [...queryTables(strapi, uid, PERSON_ID)]);
  return getReadCache().get(key, () => strapi.db.query(uid).findMany({ populate: PERSON_ID }), {
    frozen: true,
    tables: declared.get(key),
  });
}

/** Every daily dedication, with `users_permissions_user: { id }`. */
const getDailyDedications = () => kept('calendars:daily-dedications', DEDICATION);

/** Every festive, with `users_permissions_user: { id }` or null (for everyone). */
const getFestives = () => kept('calendars:festives', FESTIVE);

module.exports = { getDailyDedications, getFestives };
