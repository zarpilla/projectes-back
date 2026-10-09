'use strict';

/**
 * document-change-log core router (v5). Read-only over the API: rows are only
 * written by services/change-log.js, so nobody can forge or erase history.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::document-change-log.document-change-log', {
  only: ['find', 'findOne'],
});
