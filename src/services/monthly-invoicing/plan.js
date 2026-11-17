'use strict';

/**
 * Automatic monthly invoicing of the logistics orders (issues/430, Joel, la
 * Diligència). The pure part: when it runs and what it invoices; run.js reads
 * and writes the data.
 *
 * When: the second-to-last working day of the month (the «Dies laborables» of
 * Configuració and the holidays for everyone), from 14:10 in the tenant's
 * zone. Every order of the month is in by then, even if some are still to be
 * delivered on the last day.
 *
 * What (the user's decision, 2026-11-12): every order whose expected delivery
 * falls in the month and is not cancelled, delivered or not, so the invoices
 * match Comandes filtered by «ruta prevista» for that month, in number and
 * amount. Orders of earlier months still not invoiced go to the same draft,
 * under «Serveis pendents mes de <mes>»: no month leaves orders behind.
 * An order already on an invoice never enters another one.
 *
 * Drafts dated the last day of the month, one per member, on the logistics
 * project of the month's quarter («4T 2026 - Logística», the rule of
 * quarter-project.js, the same as «Facturar»), which must have «Habilitar
 * facturació automàtica». A member whose draft would be wrong (an order without price,
 * no contact to invoice) gets none: she is told in Avisos, the office in the
 * report. What only needs a look (a price of 0, an order of an earlier month
 * not delivered yet) is noted on the draft and in the report.
 */
const moment = require('moment');
const { previousWorkingDay, wallClockOf } = require('../late-order');
const { orderDiscountedPrice } = require('../../api/order/services/final-price');

const RUN_HOUR = 14;
const RUN_MINUTE = 10;
const SKIPPED = ['cancelled'];

const round2 = (n) => Math.round(n * 100) / 100;
const monthKey = (value) => String(value || '').slice(0, 7);
const monthName = (key) => moment(`${key}-01`, 'YYYY-MM-DD').locale('ca').format('MMMM YYYY');
const monthNameOnly = (key) => moment(`${key}-01`, 'YYYY-MM-DD').locale('ca').format('MMMM');
/** «de setembre», «d'octubre» */
const ofName = (name) => (/^[aeiouàèéíòóú]/i.test(name) ? `d'${name}` : `de ${name}`);

/** The last day of a month «YYYY-MM». */
function lastDayOf(month) {
  return moment(`${month}-01`, 'YYYY-MM-DD').endOf('month').format('YYYY-MM-DD');
}

/** The second-to-last working day of a month «YYYY-MM», YYYY-MM-DD. */
function invoicingDayOf(month, rules) {
  const nextMonth = moment(`${month}-01`, 'YYYY-MM-DD').add(1, 'month').format('YYYY-MM-DD');
  const last = previousWorkingDay(nextMonth, rules);
  return previousWorkingDay(last.format('YYYY-MM-DD'), rules).format('YYYY-MM-DD');
}

/**
 * Whether the month's run is due at `now`: on or after its day at 14:10 in the
 * tenant's zone, in the same month (a server down that afternoon runs it later
 * that month, never the next one). `{ due, month, day }`.
 */
function dueRun(now, rules) {
  const wall = wallClockOf(now, rules && rules.timeZone);
  const month = wall.format('YYYY-MM');
  const day = invoicingDayOf(month, rules);
  const start = moment(`${day} ${RUN_HOUR}:${RUN_MINUTE}`, 'YYYY-MM-DD H:m');
  return { due: !wall.isBefore(start), month, day, at: `${day} ${String(RUN_HOUR).padStart(2, '0')}:${String(RUN_MINUTE).padStart(2, '0')}` };
}

const ownerName = (owner) => (owner && (owner.fullname || owner.username)) || 'Sense sòcia';
const orderNumber = (o) => `${String(o.id).padStart(4, '0')}${o.is_collection_order ? '-R' : ''}`;
const validPrice = (o) => o.price !== null && o.price !== undefined && o.price !== '' && Number.isFinite(Number(o.price));

/**
 * The plan of a month: per member, the orders of the month and of earlier
 * months, what blocks her draft and what is only noted. `orders`: the
 * candidates (not on any invoice, delivery up to the month's last day),
 * with owner. `contactOf(ownerId)`: her contact to invoice, or null.
 */
function planMonth({ month, orders, contactOf }) {
  const lastDay = lastDayOf(month);
  const byOwner = new Map();
  for (const o of orders || []) {
    if (!o || SKIPPED.includes(o.status) || o.status === 'invoiced' || o.emitted_invoice) continue;
    const day = String(o.estimated_delivery_date || '').slice(0, 10);
    if (!day || day > lastDay) continue;
    const ownerId = o.owner && typeof o.owner === 'object' ? o.owner.id : o.owner;
    if (!byOwner.has(ownerId)) {
      byOwner.set(ownerId, { ownerId, ownerName: ownerName(o.owner), orders: [] });
    }
    byOwner.get(ownerId).orders.push(o);
  }

  const owners = [];
  for (const group of byOwner.values()) {
    const blockers = [];
    const warnings = [];
    const contact = group.ownerId ? contactOf(group.ownerId) : null;
    if (!group.ownerId) blockers.push({ text: 'Comandes sense sòcia', orders: group.orders.map((o) => o.id) });
    else if (!contact) blockers.push({ text: 'La sòcia no té cap contacte per facturar-li', orders: group.orders.map((o) => o.id) });
    const noPrice = group.orders.filter((o) => !validPrice(o));
    if (noPrice.length) blockers.push({ text: 'Comandes sense preu', orders: noPrice.map((o) => o.id) });

    const sorted = [...group.orders].sort(
      (a, b) => String(a.estimated_delivery_date).localeCompare(String(b.estimated_delivery_date)) || a.id - b.id,
    );
    const current = sorted.filter((o) => monthKey(o.estimated_delivery_date) === month);
    const previous = {};
    for (const o of sorted.filter((x) => monthKey(x.estimated_delivery_date) !== month)) {
      const key = monthKey(o.estimated_delivery_date);
      (previous[key] = previous[key] || []).push(o);
    }
    for (const [key, list] of Object.entries(previous)) {
      const open = list.filter((o) => o.status !== 'delivered');
      if (open.length) {
        warnings.push({
          text: `Comandes ${ofName(monthNameOnly(key))} encara no lliurades`,
          orders: open.map((o) => o.id),
        });
      }
    }
    const zero = sorted.filter((o) => validPrice(o) && Number(o.price) === 0);
    if (zero.length) warnings.push({ text: 'Comandes amb preu 0', orders: zero.map((o) => o.id) });

    const amount = round2(sorted.filter(validPrice).reduce((sum, o) => sum + orderDiscountedPrice(o), 0));
    owners.push({ ...group, contact, current, previous, blockers, warnings, amount });
  }
  owners.sort((a, b) => a.ownerName.localeCompare(b.ownerName));
  return { month, invoiceDay: lastDay, owners };
}

/** The label of an earlier month's lines: «Serveis pendents de setembre 2026». */
const pendingLabel = (key) => `Serveis pendents ${ofName(monthName(key))}`;

/**
 * The lines of a member's draft: the month's orders, then each earlier month's,
 * every one labelled «Serveis pendents de <mes> · …». A heading line of its
 * own would be a line without amount, which the PDF leaves out.
 * `lineOf(order)` gives an order's line.
 */
function draftLines(ownerPlan, lineOf) {
  const lines = ownerPlan.current.map(lineOf);
  for (const key of Object.keys(ownerPlan.previous).sort()) {
    for (const order of ownerPlan.previous[key]) {
      const line = lineOf(order);
      lines.push({ ...line, concept: `${pendingLabel(key)} · ${line.concept}` });
    }
  }
  return lines;
}

/** The note of a draft (comments_internal): what to look at, by line and order. */
function draftNote(ownerPlan) {
  if (!ownerPlan.warnings.length) return null;
  const items = ownerPlan.warnings.map((w) => `- ${w.text}: ${w.orders.map((id) => String(id).padStart(4, '0')).join(', ')}`);
  return ['Facturació automàtica, per revisar:', ...items].join('\n');
}

/**
 * Whether the month adds up: the orders expected in the month (not cancelled),
 * against those invoiced, now or before. `expected`: every order of the month
 * not cancelled; `invoicedIds`: the ids on drafts of this run.
 */
function reconcile({ expected, invoicedIds }) {
  const inRun = new Set(invoicedIds);
  const sum = (list) => round2(list.reduce((s, o) => s + (validPrice(o) ? orderDiscountedPrice(o) : 0), 0));
  const before = expected.filter((o) => !inRun.has(o.id) && (o.status === 'invoiced' || o.emitted_invoice));
  const now = expected.filter((o) => inRun.has(o.id));
  const missing = expected.filter((o) => !inRun.has(o.id) && !(o.status === 'invoiced' || o.emitted_invoice));
  return {
    expected: { count: expected.length, amount: sum(expected) },
    invoicedNow: { count: now.length, amount: sum(now) },
    invoicedBefore: { count: before.length, amount: sum(before) },
    missing: { count: missing.length, amount: sum(missing), orders: missing.map((o) => o.id) },
    ok: missing.length === 0,
  };
}

module.exports = {
  RUN_HOUR,
  RUN_MINUTE,
  dueRun,
  draftLines,
  draftNote,
  invoicingDayOf,
  lastDayOf,
  monthName,
  monthNameOnly,
  ofName,
  orderNumber,
  pendingLabel,
  planMonth,
  reconcile,
};
