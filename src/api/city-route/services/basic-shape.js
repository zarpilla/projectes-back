'use strict';

/**
 * The shape every caller of the city-route list actually reads.
 *
 * `city-routes?_limit=-1` is the core route, so the v3-compat middleware gives
 * it populate='*' and the content API sanitises every field of every row.
 * Measured on 901 rows: 35ms of query, 124ms of sanitisation, 0.479 MB — and
 * the VPS runs 16 Strapi instances on shared CPU, where the same request takes
 * 3-5 seconds.
 *
 * All four callers (CityRoute, ContactsTable, OrdersTable, OrdersForm) read
 * only the row id, the city id, and the route's id and name. Selecting just
 * those gives 6ms and 0.049 MB.
 */
const BASIC_SELECT = ['id'];

const BASIC_POPULATE = {
  // Only the id is read off the city.
  city: { select: ['id'] },
  // The route comes back WHOLE. Narrowing it to id+name emptied the "Ruta"
  // picker in OrdersForm: it filters on `cr.route.active`, which a narrowed
  // select leaves undefined, so every row was rejected. The derived objects
  // are also handed on as the selected route (checkTransferNeeded reads
  // transfer_pickup off them), so the whole row has to be here.
  route: true,
};

module.exports = { BASIC_SELECT, BASIC_POPULATE };
