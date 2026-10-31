'use strict';

/**
 * PUT /api/document-unlock/:type/:id
 *
 * A document saved with «Modificable» off refuses every later save, so the
 * switch could never be turned back on from its form. An app admin can turn
 * it back on here (the route has the isAdmin policy).
 *
 * Emitted invoices are not here: «Modificable» doesn't apply to them (issuing
 * one locks its fiscal data). The flag is written straight to the table: a
 * save through the document service would rerun the lifecycles, which number
 * and total the document from the payload. The change goes to the document's
 * «Historial» when it has one.
 */
const changeLog = require('../../../services/change-log');

const TYPES = {
  'received-invoices': 'api::received-invoice.received-invoice',
  'received-expenses': 'api::received-expense.received-expense',
  'received-incomes': 'api::received-income.received-income',
  'received-grants': 'api::received-grant.received-grant',
  tickets: 'api::ticket.ticket',
  diets: 'api::diet.diet',
};

module.exports = ({ strapi }) => ({
  async unlock(ctx) {
    const { type, id } = ctx.params;
    const uid = TYPES[type];
    if (!uid) return ctx.badRequest(`Tipus de document desconegut: ${type}`);

    const where = /^\d+$/.test(String(id)) ? { id: Number(id) } : { documentId: id };
    const row = await strapi.db.query(uid).findOne({ where, select: ['id', 'updatable'] });
    if (!row) return ctx.notFound('Document no trobat');

    if (row.updatable === false) {
      const before = changeLog.isTracked(uid)
        ? await changeLog.rowWith(uid, { id: row.id }, ['updatable']).catch(() => null)
        : null;
      const { tableName } = strapi.db.metadata.get(uid);
      await strapi.db.connection(tableName).where({ id: row.id }).update({ updatable: true });
      await changeLog.logRawUpdate(uid, before, ['updatable']);
      strapi.log.info(`[document-unlock] ${type} ${row.id} unlocked by user ${ctx.state.user && ctx.state.user.id}`);
    }

    return { id: row.id, updatable: true };
  },
});

module.exports.TYPES = TYPES;
