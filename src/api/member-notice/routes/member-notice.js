'use strict';

/**
 * member-notice core router (v5): the notices the app leaves a member in
 * Avisos (issues/430: a monthly draft that could not be made). She reads hers
 * and marks them read; the server writes them.
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::member-notice.member-notice', {
  only: ['find', 'update'],
});
