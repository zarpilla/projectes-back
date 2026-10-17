'use strict';
/* global strapi */

/**
 * city lifecycles (issues/093). Town names are trimmed, and a town that
 * already exists under the same name (ignoring case and spaces) is refused:
 * Diligència had «Barcelona» and «Barcelona », each with its own routes, so a
 * delivery point matched one or the other depending on how its town was typed.
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

module.exports = {
  beforeCreate: checkName,
  beforeUpdate: checkName,
};
