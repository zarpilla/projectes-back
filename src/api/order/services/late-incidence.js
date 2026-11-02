'use strict';
/* global strapi */

/**
 * The incidence of a late order (issues/363): the «fora de temps» mark wasn't
 * enough for La Diligència, an order entered past the next-day limit opens an
 * incidence too, like the ones the office opens by hand. Creating it mails
 * the office (contact_form_email) and the order's owner, as any new incidence
 * (incidence lifecycles).
 */

const moment = require('moment');
const { toQueryDay } = require('../../../services/date-fields');
const { wallClockOf } = require('../../../services/late-order');

const dayText = (value) => moment(toQueryDay(value), 'YYYY-MM-DD').locale('ca').format('dddd D/M');
const percent = (n) => String(Math.round(Number(n) * 100) / 100).replace('.', ',');

/** The incidence's text: what came late, when it was entered and the surcharge. */
function lateIncidenceText({ lateOrder, latePickup, payload, rules, now = new Date() }) {
  const at = wallClockOf(now, rules.timeZone);
  const entered = `informada ${at.locale('ca').format('dddd D/M [a les] HH:mm')}`;
  const parts = [];
  if (lateOrder) {
    let text = `Comanda fora de temps: ${entered} per a ${dayText(payload.estimated_delivery_date)}`;
    text += ` (hora límit: les ${rules.nextDayLimitHour} h del dia laborable anterior).`;
    if (Number(payload.late_surcharge)) text += ` Recàrrec del ${percent(payload.late_surcharge)} %.`;
    parts.push(text);
  }
  if (latePickup) {
    parts.push(`Recollida informada tard: ${entered} per a ${dayText(payload.collection_pickup_date)}.`);
  }
  return parts.join('\n');
}

/** Opens the incidence of `orderId` when `late` says it came late; never fails the save. */
async function openLateIncidence(orderId, late, user) {
  if (!orderId || !late || !(late.lateOrder || late.latePickup)) return null;
  try {
    return await strapi.db.query('api::incidence.incidence').create({
      data: {
        order: orderId,
        state: 'open',
        description: lateIncidenceText(late),
        ...(user && user.id ? { created_user: user.id } : {}),
      },
    });
  } catch (error) {
    strapi.log.error(`[late incidence] order ${orderId}: ${error.message}`);
    return null;
  }
}

module.exports = { lateIncidenceText, openLateIncidence };
