'use strict';

const moment = require('moment');

/**
 * Late orders and late pickups (issues/315).
 *
 * An order for tomorrow entered at or after «Hora límit per a l'endemà»
 * (`me.orders_options.next_day_limit_hour`) used to be refused by the API
 * and moved to the route's next day by the form, so it mixed with the orders
 * entered on time for next week. It is now accepted for the day asked, marked
 * late (`late_order`, red in the lists, «COMANDA EXPRESS» on the delivery
 * note) and charged a surcharge (`late_surcharge` %, default 25) that the
 * office can cancel with «Recàrrec per incidència».
 *
 * A farm pickup (collection_pickup_date) is late:
 *   - afternoon pickup: entered on its own day at or after
 *     `pickup_same_day_limit_hour` (default 10),
 *   - morning pickup: entered on the day before at or after the next-day
 *     limit, or on its own day.
 * It is marked `late_pickup` (red, also on its collection order) with no
 * surcharge. A pickup is in the afternoon when the time slot of its route in
 * the collection point's town (or of the route, issues/314) starts at or
 * after AFTERNOON_FROM; without a slot it counts as a morning one.
 */

const DEFAULT_NEXT_DAY_LIMIT_HOUR = 14;
const DEFAULT_PICKUP_SAME_DAY_LIMIT_HOUR = 10;
const DEFAULT_LATE_SURCHARGE = 25;
const AFTERNOON_FROM = '13:00';

const numberOr = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** The limits of the tenant, with their defaults for the fields left empty. */
function lateRules(ordersOptions) {
  const o = ordersOptions || {};
  return {
    nextDayLimitHour: numberOr(o.next_day_limit_hour, DEFAULT_NEXT_DAY_LIMIT_HOUR),
    pickupSameDayLimitHour: numberOr(o.pickup_same_day_limit_hour, DEFAULT_PICKUP_SAME_DAY_LIMIT_HOUR),
    lateSurcharge: numberOr(o.late_surcharge, DEFAULT_LATE_SURCHARGE),
  };
}

const dayOf = (value) => {
  if (!value) return null;
  const day = moment(value, ['YYYY-MM-DD', moment.ISO_8601]);
  return day.isValid() ? day.clone().startOf('day') : null;
};

/** A delivery for tomorrow entered at or after the next-day limit. */
function isLateDelivery(date, now, rules) {
  const day = dayOf(date);
  if (!day) return false;
  const current = moment(now);
  const tomorrow = current.clone().startOf('day').add(1, 'day');
  return day.isSame(tomorrow, 'day') && current.hour() >= rules.nextDayLimitHour;
}

/** «13:00» or «13:00:00.000» is the afternoon; null is not. */
function isAfternoonSlot(timeFrom) {
  if (!timeFrom) return false;
  return String(timeFrom).slice(0, 5) >= AFTERNOON_FROM;
}

/** A farm pickup entered too late for its day (see above). */
function isLatePickup(date, now, rules, { afternoon = false } = {}) {
  const day = dayOf(date);
  if (!day) return false;
  const current = moment(now);
  const today = current.clone().startOf('day');
  if (day.isBefore(today, 'day')) return false; // refused elsewhere (issues/302)
  if (day.isSame(today, 'day')) return afternoon ? current.hour() >= rules.pickupSameDayLimitHour : true;
  if (afternoon) return false;
  return day.isSame(today.clone().add(1, 'day'), 'day') && current.hour() >= rules.nextDayLimitHour;
}

module.exports = {
  AFTERNOON_FROM,
  DEFAULT_LATE_SURCHARGE,
  DEFAULT_NEXT_DAY_LIMIT_HOUR,
  DEFAULT_PICKUP_SAME_DAY_LIMIT_HOUR,
  isAfternoonSlot,
  isLateDelivery,
  isLatePickup,
  lateRules,
};
