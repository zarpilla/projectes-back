'use strict';

const moment = require('moment');

/**
 * Late orders and late pickups (issues/315).
 *
 * The limits fall on working days (La Diligència, 2026-10-25): «Dies laborables»
 * (`orders_options.working_days`, Monday to Friday by default). A delivery or
 * a morning pickup on day D is late from the next-day limit hour of the last
 * working day before D on: Monday's limit is Friday's, so a Monday order
 * entered on Friday afternoon or the weekend is late, and one for Tuesday is
 * on time until Monday's limit.
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
 *   - morning pickup: entered at or after its deadline (the next-day limit
 *     of the working day before), or on its own day.
 * It is marked `late_pickup` (red, also on its collection order) with no
 * surcharge. A pickup is in the afternoon when the time slot of its route in
 * the collection point's town (or of the route, issues/314) starts at or
 * after AFTERNOON_FROM; without a slot it counts as a morning one.
 */

const DEFAULT_NEXT_DAY_LIMIT_HOUR = 14;
const DEFAULT_PICKUP_SAME_DAY_LIMIT_HOUR = 10;
const DEFAULT_LATE_SURCHARGE = 25;
const AFTERNOON_FROM = '13:00';
// moment's day(): 0 Sunday … 6 Saturday; the names of the route fields
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DEFAULT_WORKING_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

/** The working days set, in week order; none (or nothing valid) is Monday to Friday. */
function workingDaysOf(value) {
  const given = Array.isArray(value) ? value.map((d) => String(d).toLowerCase()) : [];
  const days = WEEKDAYS.filter((d) => given.includes(d));
  const week = [...days.filter((d) => d !== 'sunday'), ...days.filter((d) => d === 'sunday')];
  return week.length ? week : [...DEFAULT_WORKING_DAYS];
}

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
    workingDays: workingDaysOf(o.working_days),
  };
}

const dayOf = (value) => {
  if (!value) return null;
  const day = moment(value, ['YYYY-MM-DD', moment.ISO_8601]);
  return day.isValid() ? day.clone().startOf('day') : null;
};

const workingDaysOfRules = (rules) => workingDaysOf(rules && rules.workingDays);

/** The moment the orders for `day` stop being on time: the next-day limit of the last working day before it. */
function deadlineOf(day, rules) {
  const working = workingDaysOfRules(rules);
  const previous = dayOf(day).subtract(1, 'day');
  for (let i = 0; i < 7 && !working.includes(WEEKDAYS[previous.day()]); i++) previous.subtract(1, 'day');
  return previous.hour(rules.nextDayLimitHour);
}

/** A delivery after today entered at or after its deadline (see deadlineOf). */
function isLateDelivery(date, now, rules) {
  const day = dayOf(date);
  if (!day) return false;
  const current = moment(now);
  if (!day.isAfter(current, 'day')) return false;
  return !current.isBefore(deadlineOf(day, rules));
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
  return !current.isBefore(deadlineOf(day, rules));
}

module.exports = {
  AFTERNOON_FROM,
  DEFAULT_LATE_SURCHARGE,
  DEFAULT_NEXT_DAY_LIMIT_HOUR,
  DEFAULT_PICKUP_SAME_DAY_LIMIT_HOUR,
  DEFAULT_WORKING_DAYS,
  deadlineOf,
  isAfternoonSlot,
  isLateDelivery,
  isLatePickup,
  lateRules,
  workingDaysOf,
};
