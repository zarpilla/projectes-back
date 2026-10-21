'use strict';

/* global strapi */
const { ApplicationError } = require('@strapi/utils').errors;

/**
 * Delivery time slot of a route or of a town in a route (issues/314):
 * `time_from` alone is a fixed time («a les 7 h»), both are a range
 * («de 12 a 15 h»), none means «franja per definir» (or, for a town, the
 * route's slot).
 */

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

const touchesSlot = (data) => !!data && ('time_from' in data || 'time_to' in data);

/** beforeCreate / beforeUpdate hooks for a content type with a time slot. */
function slotLifecycles(uid) {
  return {
    async beforeCreate(event) {
      const { data } = event.params;
      if (!touchesSlot(data)) return;
      const error = checkSlot(data.time_from, data.time_to);
      if (error) throw new ApplicationError(error);
    },
    async beforeUpdate(event) {
      const { data, where } = event.params;
      if (!touchesSlot(data)) return;
      // a partial update is checked against what is stored
      const stored =
        'time_from' in data && 'time_to' in data
          ? {}
          : (await strapi.db.query(uid).findOne({ where, select: ['time_from', 'time_to'] })) || {};
      const from = 'time_from' in data ? data.time_from : stored.time_from;
      const to = 'time_to' in data ? data.time_to : stored.time_to;
      const error = checkSlot(from, to);
      if (error) throw new ApplicationError(error);
    },
  };
}

module.exports = { checkSlot, slotLifecycles };
