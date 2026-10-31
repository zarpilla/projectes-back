'use strict';

/**
 * `updatable_admin` lets one save through the «Modificable» guard of a
 * document (services/document-lifecycle.js). Only the server sets it (the
 * payment-method route of emitted invoices); a client that sent it could edit
 * a locked document. It is dropped from every request body, so turning
 * «Modificable» back on goes through PUT /api/document-unlock (admins only).
 */
function strip(body) {
  if (!body || typeof body !== 'object') return;
  delete body.updatable_admin;
  if (body.data && typeof body.data === 'object') delete body.data.updatable_admin;
}

module.exports = () => async (ctx, next) => {
  if (ctx.request && ctx.request.body) strip(ctx.request.body);
  return next();
};

module.exports.strip = strip;
