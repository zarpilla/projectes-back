'use strict';

/**
 * face-queue core router (v5). Registers standard CRUD routes at /api/<plural>.
 * Custom (non-CRUD) routes live in routes/01-custom-face-queue.js.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::face-queue.face-queue', {
  config: {
    // the server creates these rows itself (emitted-invoice lifecycles, with
    // strapi.db.query); their afterCreate sends to AEAT/FACe, so a `projects`
    // user who isn't admin could submit any invoice (issues/398)
    create: { policies: ['global::isAdmin'] },
    update: { policies: ['global::isAdmin'] },
    delete: { policies: ['global::isAdmin'] },
  },
});
