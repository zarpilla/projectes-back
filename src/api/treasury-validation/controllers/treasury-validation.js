'use strict';
/* global strapi */

/**
 * treasury-validation controller (v5). Ported from v3 api/treasury-validation/controllers.
 * Custom endpoints: toggle, findByKey. Core find/delete inherit from createCoreController.
 */
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::treasury-validation.treasury-validation', ({ strapi }) => ({
  /**
   * POST /api/treasury-validations/toggle
   * Toggles validation for a treasury movement.
   * Body: { entity_type, entity_id, sub_type?, notes? }
   */
  async toggle(ctx) {
    const { entity_type, entity_id, sub_type, notes } = ctx.request.body;

    if (!entity_type || !entity_id) {
      return ctx.badRequest('entity_type and entity_id are required');
    }

    const where = { entity_type, entity_id: parseInt(entity_id) };
    if (sub_type) {
      where.sub_type = sub_type;
    } else {
      where.sub_type = { $null: true };
    }

    const existing = await strapi.db.query('api::treasury-validation.treasury-validation').findOne({ where });

    if (existing) {
      // Delete validation (unvalidate)
      await strapi.db
        .query('api::treasury-validation.treasury-validation')
        .delete({ where: { id: existing.id } });
      return { validated: false, message: 'Validation removed' };
    }

    await strapi.db.query('api::treasury-validation.treasury-validation').create({
      data: {
        entity_type,
        entity_id: parseInt(entity_id),
        sub_type: sub_type || null,
        validated_by: ctx.state.user.id,
        notes: notes || null,
        publishedAt: new Date(),
      },
    });

    return { validated: true, message: 'Movement validated' };
  },

  /**
   * GET /api/treasury-validations/:entity_type/:entity_id/:sub_type?
   * Get validation by composite key.
   */
  async findByKey(ctx) {
    const { entity_type, entity_id, sub_type } = ctx.params;

    const where = { entity_type, entity_id: parseInt(entity_id) };
    if (sub_type && sub_type !== 'null') {
      where.sub_type = sub_type;
    } else {
      where.sub_type = { $null: true };
    }

    const validation = await strapi.db
      .query('api::treasury-validation.treasury-validation')
      .findOne({ where });

    if (!validation) {
      return ctx.notFound('Validation not found');
    }
    return validation;
  },
}));
