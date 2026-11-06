'use strict';

/**
 * bank-import core router (v5), read only: imports are made by
 * POST /bank-movements/import (issues/413).
 */
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::bank-import.bank-import', { only: ['find', 'findOne'] });
