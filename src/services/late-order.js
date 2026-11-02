'use strict';

const moment = require('moment');
const { toQueryDay } = require('./date-fields');
const { currentTimeZone } = require('./time-zone');

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
 * late (`late_order`, red in the lists, a warning triangle on the delivery
 * note) and charged a surcharge (`late_surcharge` %, default 15 since issues/363) that the
 * office can cancel with «Recàrrec per incidència».
 *
 * A farm pickup (collection_pickup_date) is late:
 *   - on an afternoon route («Ruta de tarda», `route.afternoon`): entered on
 *     its own day at or after `pickup_same_day_limit_hour` (default 10),
 *   - on any other route: entered at or after its deadline (the next-day
 *     limit of the working day before), or on its own day.
 * It is marked `late_pickup` (red, also on its collection order) with no
 * surcharge. The afternoon routes used to be guessed from their time slot
 * (from 13 h); no route had one, so La Diligència's «(TARDA)» routes were
 * judged as morning ones (issues/346).
 *
 * Route closing (issues/363): from «Hora de tancament de la ruta»
 * (`route_closing_hour`, 14 h by default) of that same working day the route
 * is closed for D: a member can't order for D any more (the API refuses it,
 * the form offers the next date a route of the town runs), and a morning
 * farm pickup on D is refused the same way. Between the next-day limit and
 * the closing hour the order is late: surcharge (`late_surcharge` %, flat, 15
 * by default) and an incidence. The office can still enter orders after the
 * closing hour, with the surcharge too.
 *
 * The working day before skips the entity's holidays for everyone (Festius,
 * those without a person) as well as the days off of the week: with Monday a
 * holiday, Tuesday's orders close on Friday.
 *
 * Days and hours are those of the tenant's «Zona horària» (Configuració
 * general, Europe/Andorra by default), not the server's: the
 * containers run in UTC, so «13 h» was 14 h in winter, and the form's dates
 * (local midnight, «2026-10-27T23:00:00.000Z» for the 28th) were read as the
 * day before, which marked a re-saved Wednesday order late on Monday
 * afternoon (issues/346).
 */

const DEFAULT_NEXT_DAY_LIMIT_HOUR = 14;
const DEFAULT_PICKUP_SAME_DAY_LIMIT_HOUR = 10;
const DEFAULT_ROUTE_CLOSING_HOUR = 14;
const DEFAULT_LATE_SURCHARGE = 15;
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

/**
 * The limits of the tenant, with their defaults for the fields left empty.
 * `holidays`: the holidays for everyone, YYYY-MM-DD (never working days).
 */
function lateRules(ordersOptions, timeZone = currentTimeZone(), { holidays = [] } = {}) {
  const o = ordersOptions || {};
  const nextDayLimitHour = numberOr(o.next_day_limit_hour, DEFAULT_NEXT_DAY_LIMIT_HOUR);
  return {
    timeZone,
    nextDayLimitHour,
    // never before the next-day limit: the late window is limit → closing
    routeClosingHour: Math.max(nextDayLimitHour, numberOr(o.route_closing_hour, DEFAULT_ROUTE_CLOSING_HOUR)),
    pickupSameDayLimitHour: numberOr(o.pickup_same_day_limit_hour, DEFAULT_PICKUP_SAME_DAY_LIMIT_HOUR),
    lateSurcharge: numberOr(o.late_surcharge, DEFAULT_LATE_SURCHARGE),
    workingDays: workingDaysOf(o.working_days),
    holidays: [...new Set((holidays || []).map((d) => String(d).slice(0, 10)))],
  };
}

const zoneOf = (rules) => (rules && rules.timeZone) || currentTimeZone();

/** The tenant's calendar day of a date or a form value, as a local moment at 00:00. */
const dayOf = (value, timeZone) => {
  if (!value) return null;
  const day = moment(toQueryDay(value, timeZone), 'YYYY-MM-DD', true);
  return day.isValid() ? day : null;
};

/**
 * The wall clock of an instant in the tenant's zone, as a local moment:
 * compared with dayOf() and deadlineOf(), which are that zone's days and
 * hours too.
 */
function wallClockOf(now, timeZone = currentTimeZone()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  return moment(`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`, 'YYYY-MM-DD HH:mm:ss');
}

const workingDaysOfRules = (rules) => workingDaysOf(rules && rules.workingDays);

/** The last working day before `day`: not a day off of the week nor a holiday for everyone. */
function previousWorkingDay(day, rules) {
  const working = workingDaysOfRules(rules);
  const holidays = new Set((rules && rules.holidays) || []);
  const isOff = (d) => !working.includes(WEEKDAYS[d.day()]) || holidays.has(d.format('YYYY-MM-DD'));
  const previous = dayOf(day, zoneOf(rules)).subtract(1, 'day');
  for (let i = 0; i < 60 && isOff(previous); i++) previous.subtract(1, 'day');
  return previous;
}

/** The moment the orders for `day` stop being on time: the next-day limit of the last working day before it. */
function deadlineOf(day, rules) {
  return previousWorkingDay(day, rules).hour(rules.nextDayLimitHour);
}

/** The moment the routes of `day` close: the closing hour of the last working day before it (issues/363). */
function closingOf(day, rules) {
  const hour = rules.routeClosingHour ?? DEFAULT_ROUTE_CLOSING_HOUR;
  return previousWorkingDay(day, rules).hour(hour);
}

/** A delivery after today asked at or after its route's closing (see closingOf). */
function isClosedDelivery(date, now, rules) {
  const day = dayOf(date, zoneOf(rules));
  if (!day) return false;
  const current = wallClockOf(now, zoneOf(rules));
  if (!day.isAfter(current, 'day')) return false; // refused elsewhere
  return !current.isBefore(closingOf(day, rules));
}

/**
 * A morning farm pickup asked at or after its closing, or for today (issues/363).
 * An afternoon one («Ruta de tarda») never closes: it is late from
 * pickupSameDayLimitHour of its own day.
 */
function isClosedPickup(date, now, rules, { afternoon = false } = {}) {
  if (afternoon) return false;
  const day = dayOf(date, zoneOf(rules));
  if (!day) return false;
  const current = wallClockOf(now, zoneOf(rules));
  if (day.isBefore(current, 'day')) return false; // refused elsewhere (issues/302)
  if (day.isSame(current, 'day')) return true;
  return !current.isBefore(closingOf(day, rules));
}

/** A delivery after today entered at or after its deadline (see deadlineOf). */
function isLateDelivery(date, now, rules) {
  const day = dayOf(date, zoneOf(rules));
  if (!day) return false;
  const current = wallClockOf(now, zoneOf(rules));
  if (!day.isAfter(current, 'day')) return false;
  return !current.isBefore(deadlineOf(day, rules));
}

/** A farm pickup entered too late for its day (see above). */
function isLatePickup(date, now, rules, { afternoon = false } = {}) {
  const day = dayOf(date, zoneOf(rules));
  if (!day) return false;
  const current = wallClockOf(now, zoneOf(rules));
  const today = current.clone().startOf('day');
  if (day.isBefore(today, 'day')) return false; // refused elsewhere (issues/302)
  if (day.isSame(today, 'day')) return afternoon ? current.hour() >= rules.pickupSameDayLimitHour : true;
  if (afternoon) return false;
  return !current.isBefore(deadlineOf(day, rules));
}

/**
 * An afternoon pickup («Ruta de tarda») asked on its own day from
 * pickupSameDayLimitHour on: it can only join a collection order (-R) already
 * pending for that point, route and day, never create one (issues/363).
 */
function isAfternoonPickupCutoff(date, now, rules) {
  const day = dayOf(date, zoneOf(rules));
  if (!day) return false;
  const current = wallClockOf(now, zoneOf(rules));
  return day.isSame(current, 'day') && current.hour() >= rules.pickupSameDayLimitHour;
}

module.exports = {
  isAfternoonPickupCutoff,
  DEFAULT_LATE_SURCHARGE,
  DEFAULT_NEXT_DAY_LIMIT_HOUR,
  DEFAULT_PICKUP_SAME_DAY_LIMIT_HOUR,
  DEFAULT_ROUTE_CLOSING_HOUR,
  DEFAULT_WORKING_DAYS,
  closingOf,
  deadlineOf,
  isClosedDelivery,
  isClosedPickup,
  isLateDelivery,
  isLatePickup,
  previousWorkingDay,
  lateRules,
  wallClockOf,
  workingDaysOf,
};
