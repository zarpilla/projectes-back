'use strict';

/**
 * A tiny in-memory `strapi.db` for the reconciliation tests (issues/413,
 * issues/415): `query(uid)` with findOne / findMany / create / update /
 * delete / count over plain rows, `where` with equality, `{ id }` for
 * relations, `$null`, `$gte` / `$lte`; and `connection(table).where().update()`
 * for the raw writes, applied to the rows of the uid owning that table.
 *
 * Relations are stored as ids; `populate` turns the ones listed in `refs`
 * ({ uid: { field: targetUid } }) back into rows.
 */

function memoryDb(tables, { refs = {}, tableNames = {} } = {}) {
  const rows = {};
  for (const [uid, list] of Object.entries(tables)) rows[uid] = list.map((r) => ({ ...r }));
  const nextId = {};
  const raw = [];

  const idOf = (v) => (v && typeof v === 'object' ? v.id : v);

  const matches = (r, where = {}) =>
    Object.entries(where).every(([k, cond]) => {
      const v = r[k];
      if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        if ('$null' in cond) return cond.$null ? v === null || v === undefined : v !== null && v !== undefined;
        if ('id' in cond) {
          return cond.id && typeof cond.id === 'object' && '$in' in cond.id ? cond.id.$in.includes(idOf(v)) : idOf(v) === cond.id;
        }
        if ('$gte' in cond || '$lte' in cond) {
          return (cond.$gte === undefined || v >= cond.$gte) && (cond.$lte === undefined || v <= cond.$lte);
        }
      }
      return idOf(v) === cond;
    });

  const populated = (uid, r, populate) => {
    if (!r || !populate) return r ? { ...r } : r;
    const out = { ...r };
    for (const field of Object.keys(populate)) {
      const target = refs[uid] && refs[uid][field];
      if (!target) continue;
      const id = idOf(r[field]);
      out[field] = id ? { ...(rows[target] || []).find((x) => x.id === id) } : null;
    }
    return out;
  };

  const store = (uid) => {
    if (!rows[uid]) rows[uid] = [];
    return rows[uid];
  };

  const db = {
    rows,
    raw,
    query: (uid) => ({
      findOne: async ({ where, populate } = {}) => populated(uid, store(uid).find((r) => matches(r, where)), populate),
      findMany: async ({ where, populate } = {}) => store(uid).filter((r) => matches(r, where)).map((r) => populated(uid, r, populate)),
      count: async ({ where } = {}) => store(uid).filter((r) => matches(r, where)).length,
      create: async ({ data }) => {
        const list = store(uid);
        nextId[uid] = nextId[uid] || list.reduce((m, r) => Math.max(m, r.id), 0);
        const row = { ...data, id: ++nextId[uid] };
        list.push(row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = store(uid).find((r) => matches(r, where));
        if (row) Object.assign(row, data);
        return row ? { ...row } : null;
      },
      delete: async ({ where }) => {
        const list = store(uid);
        const i = list.findIndex((r) => matches(r, where));
        if (i >= 0) list.splice(i, 1);
      },
    }),
    metadata: { get: (uid) => ({ tableName: tableNames[uid] || uid }) },
    connection: (table) => ({
      where: (w) => ({
        update: async (data) => {
          raw.push({ table, id: w.id, ...data });
          const uid = Object.keys(tableNames).find((u) => tableNames[u] === table) || table;
          const row = store(uid).find((r) => r.id === w.id);
          if (row) Object.assign(row, data);
        },
      }),
    }),
  };
  return db;
}

module.exports = { memoryDb };
