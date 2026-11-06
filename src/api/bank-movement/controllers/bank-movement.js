'use strict';

/**
 * bank-movement controller (v5): «Tresoreria › Conciliació» (issues/413).
 * The work is in services/reconcile.js; a ReconcileError answers 400 with its
 * message.
 */
const { createCoreController } = require('@strapi/strapi').factories;
const { adaptCtxQuery } = require('../../../services/query-adapter');
const reconcile = require('../services/reconcile');

const userOf = (ctx) => (ctx.state.user ? ctx.state.user.id : null);

async function answer(ctx, work) {
  try {
    ctx.body = await work();
  } catch (e) {
    if (e instanceof reconcile.ReconcileError) return ctx.badRequest(e.message);
    throw e;
  }
}

module.exports = createCoreController('api::bank-movement.bank-movement', () => ({
  async find(ctx) {
    adaptCtxQuery(ctx);
    return super.find(ctx);
  },

  // POST /bank-movements/import { file_name, content (base64) }
  async import(ctx) {
    const body = ctx.request.body || {};
    return answer(ctx, () => reconcile.importStatement({ fileName: body.file_name, content: body.content, userId: userOf(ctx) }));
  },

  // GET /bank-movements/reconciliation?status=&bank_account=&from=&to=
  async reconciliation(ctx) {
    const q = ctx.query || {};
    return answer(ctx, () =>
      reconcile.reconciliation({ status: q.status || 'pending', bankAccount: q.bank_account || null, from: q.from || null, to: q.to || null }),
    );
  },

  // GET /bank-movements/:id/candidates?q=
  async candidates(ctx) {
    return answer(ctx, () => reconcile.candidates(ctx.params.id, ctx.query && ctx.query.q));
  },

  // POST /bank-movements/auto
  async auto(ctx) {
    return answer(ctx, () => reconcile.autoReconcile(userOf(ctx)));
  },

  // POST /bank-movements/:id/accept { lines: [{ id, amount? }] }
  async accept(ctx) {
    const body = ctx.request.body || {};
    return answer(ctx, () => reconcile.acceptLines(ctx.params.id, body.lines, userOf(ctx)));
  },

  // POST /bank-movements/:id/create { kind: 'annotation'|'expense', comment?, project?, contact?, document_type? }
  async createRecord(ctx) {
    return answer(ctx, () => reconcile.createFromMovement(ctx.params.id, ctx.request.body || {}, userOf(ctx)));
  },

  // POST /bank-movements/:id/transfer { with }
  async transfer(ctx) {
    const body = ctx.request.body || {};
    return answer(ctx, () => reconcile.transfer(ctx.params.id, body.with, userOf(ctx)));
  },

  // POST /bank-movements/:id/ignore
  async ignore(ctx) {
    return answer(ctx, () => reconcile.ignore(ctx.params.id, userOf(ctx)));
  },

  // POST /bank-movements/:id/undo
  async undo(ctx) {
    return answer(ctx, () => reconcile.undo(ctx.params.id));
  },
}));
