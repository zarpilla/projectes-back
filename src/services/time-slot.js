'use strict';

/* global strapi */
const { ApplicationError } = require('@strapi/utils').errors;

/**
 * Delivery time slots of a route or of a town in a route (issues/314):
 * `time_from` alone is a fixed time («a les 7 h»), both are a range
 * («de 12 a 15 h»), none means «franja per definir» (or, for a town, the
 * route's slots). An optional second slot (`time_from_2`, `time_to_2`) follows
 * the same rules and comes after the first one («de 9 a 13 h i de 16 a 19 h»).
 */

const FIELDS = ['time_from', 'time_to', 'time_from_2', 'time_to_2'];

const minutes = (t) => {
  const [h, m] = String(t).split(':');
  return Number(h) * 60 + Number(m);
};

/** The error message for an invalid slot, or null. */
function checkSlot(from, to) {
  if (!to) return null;
  if (!from) return "Cal l'hora d'inici de la franja";
  if (minutes(to) <= minutes(from)) return "L'hora final de la franja ha de ser posterior a la d'inici";
  return null;
}

/** The error message for invalid slots ({ time_from, … time_to_2 }), or null. */
function checkSlots(slots) {
  const { time_from: from, time_to: to, time_from_2: from2, time_to_2: to2 } = slots;
  const error = checkSlot(from, to) || checkSlot(from2, to2);
  if (error) return error;
  if (!from2) return null;
  if (!from) return 'La segona franja necessita la primera';
  if (minutes(from2) <= minutes(to || from)) return 'La segona franja ha de començar després de la primera';
  return null;
}

const touchesSlot = (data) => !!data && FIELDS.some((f) => f in data);

/** beforeCreate / beforeUpdate hooks for a content type with time slots. */
function slotLifecycles(uid) {
  return {
    async beforeCreate(event) {
      const { data } = event.params;
      if (!touchesSlot(data)) return;
      const error = checkSlots(data);
      if (error) throw new ApplicationError(error);
    },
    async beforeUpdate(event) {
      const { data, where } = event.params;
      if (!touchesSlot(data)) return;
      // a partial update is checked against what is stored
      const stored = FIELDS.every((f) => f in data)
        ? {}
        : (await strapi.db.query(uid).findOne({ where, select: FIELDS })) || {};
      const slots = {};
      for (const f of FIELDS) slots[f] = f in data ? data[f] : stored[f];
      const error = checkSlots(slots);
      if (error) throw new ApplicationError(error);
    },
  };
}

module.exports = { checkSlot, checkSlots, slotLifecycles };
