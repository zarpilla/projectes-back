'use strict';

/**
 * form-submission core router (v5). Members send the «Contacta» form; only
 * admins read the messages (Administració › Missatges, issues/159).
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::form-submission.form-submission', {
  only: ['find', 'findOne', 'create'],
  config: {
    find: { policies: ['global::isAdmin'] },
    findOne: { policies: ['global::isAdmin'] },
  },
});
