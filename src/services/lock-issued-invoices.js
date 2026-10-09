'use strict';
/* global strapi */

/**
 * Document-service middleware (issues/023): an update can't change the lines
 * of an issued (`real`) emitted invoice.
 *
 * emitted-invoice beforeUpdate pins the locked fields to their stored values,
 * but that db lifecycle runs after the document service has already replaced
 * the components: an update sending new lines (without component ids) deleted
 * the stored line and left the invoice linked to a missing row. Dropping
 * `lines` here, before the document service sees them, keeps them intact.
 * The form sends the lines with their ids and saves issued invoices as before.
 */

const UID = 'api::emitted-invoice.emitted-invoice';

function whereFromParams(params) {
  if (params.documentId) return { documentId: params.documentId };
  if (params.id) return { id: params.id };
  return null;
}

async function lockIssuedInvoiceLines(context, next) {
  const { uid, action, params } = context;
  const data = params && params.data;
  if (uid === UID && action === 'update' && data && data.lines !== undefined) {
    const where = whereFromParams(params);
    const stored = where ? await strapi.db.query(UID).findOne({ where, select: ['id', 'state'] }) : null;
    if (stored && stored.state === 'real') {
      delete data.lines;
    }
  }
  return next();
}

module.exports = { lockIssuedInvoiceLines };
