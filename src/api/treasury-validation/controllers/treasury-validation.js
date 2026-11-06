'use strict';
/* global strapi */

/**
 * treasury-validation controller (v5). Ported from v3 api/treasury-validation/controllers.
 * Custom endpoints: toggle, findByKey. Core find/delete inherit from createCoreController.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const { settleDocument, unsettle, SettleError } = require('../services/settle');
const { releaseMovement } = require('../../bank-movement/services/reconcile');
const { isPaymentSubType } = require('../../../services/partial-payments');

// irpf / ss / other, or one partial payment of a document, `payment-<id>`
// (issues/412: was an enumeration of the first three)
const SUB_TYPES = ['irpf', 'ss', 'other'];
const validSubType = (subType) => !subType || SUB_TYPES.includes(subType) || isPaymentSubType(subType);

module.exports = createCoreController('api::treasury-validation.treasury-validation', ({ strapi }) => ({
  // v3 query-param compatibility (P9): translate _limit/_start/_sort/_q/_where
  // and flat field operators to native v5 params before core handling.
  // v5-native queries pass through untouched.
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  /**
   * POST /api/treasury-validations/toggle
   * Toggles validation for a treasury movement.
   * Body: { entity_type, entity_id, sub_type?, notes?, validated? }
   * With `validated` (true/false) it sets that state instead of toggling: a
   * Tresoreria line grouping several payrolls validates them all at once,
   * some of which may already be validated (issues/347).
   */
  async toggle(ctx) {
    const { entity_type, entity_id, sub_type, notes, validated } = ctx.request.body;

    if (!entity_type || !entity_id) {
      return ctx.badRequest('entity_type and entity_id are required');
    }
    if (!validSubType(sub_type)) {
      return ctx.badRequest('invalid sub_type');
    }

    const where = { entity_type, entity_id: parseInt(entity_id) };
    if (sub_type) {
      where.sub_type = sub_type;
    } else {
      where.sub_type = { $null: true };
    }

    const existing = await strapi.db
      .query('api::treasury-validation.treasury-validation')
      .findOne({ where, populate: { bank_movement: { select: ['id'] } } });

    const target = typeof validated === 'boolean' ? validated : !existing;
    if (target === !!existing) {
      return { validated: target, message: target ? 'Movement validated' : 'Validation removed' };
    }

    if (existing) {
      // Delete validation (unvalidate). One that marked its document paid
      // puts it back (issues/415); one from a bank movement leaves the
      // movement pending again when it was its last one (issues/413).
      const reverted = await unsettle(existing);
      await strapi.db
        .query('api::treasury-validation.treasury-validation')
        .delete({ where: { id: existing.id } });
      if (existing.bank_movement) await releaseMovement(existing.bank_movement.id);
      return { validated: false, reverted, message: 'Validation removed' };
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
   * POST /api/treasury-validations/settle (issues/415)
   * Body: { entity_type, entity_id, date }
   * Marks a pending document collected or paid on `date` and validates it
   * (services/settle.js).
   */
  async settle(ctx) {
    const { entity_type, entity_id, date } = ctx.request.body || {};
    try {
      ctx.body = await settleDocument({ entity_type, entity_id, date, userId: ctx.state.user && ctx.state.user.id });
    } catch (e) {
      if (e instanceof SettleError) return ctx.badRequest(e.message);
      throw e;
    }
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
