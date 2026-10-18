'use strict';
/* global strapi */

/**
 * city lifecycles (issues/093). Town names are trimmed, and a town that
 * already exists under the same name (ignoring case and spaces) is refused:
 * Diligència had «Barcelona» and «Barcelona », each with its own routes, so a
 * delivery point matched one or the other depending on how its town was typed.
 *
 * A town in use can't be deleted (issues/159, «Taules auxiliars › Poblacions»):
 * routes reach it through city-routes, pickup points point to it, and contacts
 * (delivery points) keep it as text, matched by name when an order is routed.
 */
const { errors: { ApplicationError } } = require('@strapi/utils');

const UID = 'api::city.city';

const normalize = (name) => String(name).trim().replace(/\s+/g, ' ');

async function checkName(event) {
  const { data } = event.params;
  if (!data || data.name == null) return;
  data.name = normalize(data.name);
  const ownId = event.params.where && event.params.where.id;
  const others = await strapi.db.query(UID).findMany({ select: ['id', 'name'] });
  const taken = others.find((c) => c.id !== ownId && normalize(c.name).toLowerCase() === data.name.toLowerCase());
  if (taken) {
    throw new ApplicationError(`La població «${data.name}» ja existeix`);
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function guardDelete(event) {
  const where = event && event.params && event.params.where;
  if (!where) return;
  const cities = await strapi.db.query(UID).findMany({ where, select: ['id', 'name'] });
  for (const city of cities) {
    const [routes, pickups, contacts] = await Promise.all([
      strapi.db.query('api::city-route.city-route').count({ where: { city: city.id } }),
      strapi.db.query('api::pickup.pickup').count({ where: { city: city.id } }),
      strapi.db.query('api::contact.contact').count({ where: { city: { $eqi: normalize(city.name) } } }),
    ]);
    const uses = [];
    if (routes) uses.push(plural(routes, 'ruta', 'rutes'));
    if (pickups) uses.push(plural(pickups, 'punt de recollida', 'punts de recollida'));
    if (contacts) uses.push(plural(contacts, 'contacte', 'contactes'));
    if (uses.length) {
      const list = uses.length > 1 ? `${uses.slice(0, -1).join(', ')} i ${uses[uses.length - 1]}` : uses[0];
      throw new ApplicationError(
        `No es pot esborrar la població «${city.name}»: la fan servir ${list}. Canvia-ho abans d'esborrar-la.`,
      );
    }
  }
}

module.exports = {
  beforeCreate: checkName,
  beforeUpdate: checkName,
  beforeDelete: guardDelete,
  beforeDeleteMany: guardDelete,
};
