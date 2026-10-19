'use strict';

/**
 * strategy lifecycles (v5). Ported from v3 api/strategy/models/strategy.js.
 * Maintains the denormalized code_name = "code - name", or just "code" when
 * there is no name (it stored «code - undefined», issues/183).
 */
const UID = 'api::strategy.strategy';

module.exports = {
  async beforeCreate(event) {
    event.params.data.code_name = codeName(event.params.data);
  },
  async beforeUpdate(event) {
    const { data, where } = event.params;
    // the server owns code_name: a value sent by the client is ignored
    delete data.code_name;
    if (!('code' in data) && !('name' in data)) return;
    let current = {};
    if (!('code' in data && 'name' in data) && where) {
      current = (await strapi.db.query(UID).findOne({ where, select: ['code', 'name'] })) || {};
    }
    data.code_name = codeName({ ...current, ...data });
  },
  codeName,
};

function codeName({ code, name }) {
  const parts = [code, name].map((v) => (v == null ? '' : String(v).trim())).filter(Boolean);
  return parts.join(' - ') || null;
}
