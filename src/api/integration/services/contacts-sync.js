'use strict';
/* global strapi */

/**
 * PUT /api/integrations/contacts — a member's delivery points from her own
 * system, identified by her `external_id` (services/integrations/refs.js).
 *
 * - An external_id not seen yet: if she already has exactly one point with
 *   the same NIF and the same trade name, it is linked to it (`linked`, and
 *   updated with what was sent); otherwise a new point is created, hers,
 *   with the fields the CSV import requires but the sector and the legal form
 *   (the user's decision 2026-10-30: a point without them is not refused, and
 *   an unknown one is left empty with a warning).
 * - A point whose town has no route is saved with a warning
 *   (TOWN_WITHOUT_ROUTES): its orders can't be given a route.
 * - An external_id seen before: the fields sent are written (`updated`), the
 *   ones not sent are kept; nothing different → `unchanged`.
 *
 * Her rules are the app's (middlewares/app-permissions.js): the fields she can
 * write on her points (MEMBER_CONTACT_FIELDS), never the office's (discounts,
 * flags, owner). A point the office gave to someone else is no longer hers.
 */
const { memberRules } = require('../../../middlewares/app-permissions');
const refs = require('../../../services/integrations/refs');
const { norm, normNif, isBlank, resolveNamed } = require('./lookups');
const { reject } = require('./sync-common');
const { townRoutesOf } = require('./route-assignment');

const CONTACT = 'api::contact.contact';
// «Punt d'entrega»: the type the members' point form gives a new point (ContactsUserForm)
const DELIVERY_POINT_TYPE = 4;

const TEXT_FIELDS = [
  'name',
  'trade_name',
  'nif',
  'phone',
  'email',
  'address',
  'postcode',
  'city',
  'contact_person',
  'contact_phone',
  'notes',
];
const SLOT_FIELDS = ['time_slot_1_ini', 'time_slot_1_end', 'time_slot_2_ini', 'time_slot_2_end'];
const RELATION_FIELDS = ['sector', 'legal_form'];
const FIELDS = [...TEXT_FIELDS, ...SLOT_FIELDS, ...RELATION_FIELDS];

// what the CSV order import checks on a point before sending an order to it
const REQUIRED = {
  name: 'el nom (name)',
  nif: 'el NIF (nif)',
  phone: 'el telèfon (phone)',
  address: "l'adreça (address)",
  postcode: 'el codi postal (postcode)',
  city: 'la població (city)',
  time_slot_1_ini: "l'hora d'inici de l'horari (time_slot_1_ini)",
  time_slot_1_end: "l'hora de final de l'horari (time_slot_1_end)",
};

const MIN_SLOT_HOURS = 3;

/** «9», 9.5, «9:30» → 9.5; blank → null; anything else → NaN. */
function hourOf(value) {
  if (isBlank(value)) return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim().replace(',', '.');
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60;
  return /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
}

function postcodeOf(value) {
  const code = String(value).trim();
  return /^\d{4}$/.test(code) ? `0${code}` : code;
}

/** The point's fields as sent (only the ones present), normalised. */
async function dataOf(item, lookups, warnings = []) {
  const data = {};
  for (const field of TEXT_FIELDS) {
    if (!(field in item)) continue;
    const value = item[field];
    if (value !== null && value !== undefined && typeof value === 'object') {
      reject('INVALID', `El camp ${field} ha de ser un text`, { field });
    }
    data[field] = isBlank(value) ? null : String(value).trim();
  }
  if (data.nif) data.nif = normNif(data.nif);
  if (data.postcode) data.postcode = postcodeOf(data.postcode);
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    reject('INVALID', "L'adreça electrònica no és vàlida", { field: 'email' });
  }
  for (const field of SLOT_FIELDS) {
    if (!(field in item)) continue;
    const hour = hourOf(item[field]);
    if (Number.isNaN(hour) || (hour !== null && (hour < 0 || hour > 24))) {
      reject('INVALID', `${field}: hora no vàlida (de 0 a 24, p. ex. 9, 9.5 o «9:30»)`, { field });
    }
    data[field] = hour;
  }
  if ('sector' in item) {
    if (isBlank(item.sector)) data.sector = null;
    else {
      const found = resolveNamed(await lookups.sectors(), item.sector);
      if (found.item) data.sector = found.item.id;
      else {
        warnings.push({
          code: 'SECTOR_NOT_FOUND',
          message: `Sector «${item.sector}» no trobat: es deixa buit`,
          field: 'sector',
        });
      }
    }
  }
  if ('legal_form' in item) {
    if (isBlank(item.legal_form)) data.legal_form = null;
    else {
      const found = resolveNamed(await lookups.legalForms(), item.legal_form);
      if (found.item) data.legal_form = found.item.id;
      else {
        warnings.push({
          code: 'LEGAL_FORM_NOT_FOUND',
          message: `Forma jurídica «${item.legal_form}» no trobada: es deixa buida`,
          field: 'legal_form',
        });
      }
    }
  }
  return data;
}

const storedValue = (stored, field) => {
  if (RELATION_FIELDS.includes(field)) {
    const rel = stored[field];
    return rel && typeof rel === 'object' ? rel.id : rel || null;
  }
  const value = stored[field];
  if (SLOT_FIELDS.includes(field)) return value === null || value === undefined ? null : Number(value);
  return isBlank(value) ? null : String(value).trim();
};

/** The fields of `data` that differ from the stored point. */
function changedFields(data, stored) {
  return Object.keys(data).filter((field) => {
    const before = storedValue(stored, field);
    const after = data[field];
    if (field === 'nif') return normNif(before || '') !== normNif(after || '');
    return before !== after;
  });
}

/** The CSV import's checks, on the point as it will be after the write. */
function checkComplete(point) {
  const missing = Object.keys(REQUIRED).filter((field) => isBlank(point[field]));
  if (missing.length) {
    reject('INCOMPLETE', `Falta ${missing.map((f) => REQUIRED[f]).join(', ')}`, { fields: missing });
  }
  const [ini1, end1, ini2, end2] = SLOT_FIELDS.map((f) => (isBlank(point[f]) ? null : Number(point[f])));
  if (ini1 !== null && end1 !== null && ini1 >= end1) {
    reject('INVALID', "L'hora d'inici de l'horari 1 ha de ser anterior a la de final", {
      field: 'time_slot_1_ini',
    });
  }
  if ((ini2 === null) !== (end2 === null)) {
    reject('INVALID', "L'horari 2 necessita l'hora d'inici i la de final", { field: 'time_slot_2_ini' });
  }
  if (ini2 !== null && end2 !== null && ini2 >= end2) {
    reject('INVALID', "L'hora d'inici de l'horari 2 ha de ser anterior a la de final", {
      field: 'time_slot_2_ini',
    });
  }
  const long1 = ini1 !== null && end1 !== null && end1 - ini1 >= MIN_SLOT_HOURS;
  const long2 = ini2 !== null && end2 !== null && end2 - ini2 >= MIN_SLOT_HOURS;
  if (!long1 && !long2) {
    reject('INVALID', `L'horari d'entrega ha de ser de ${MIN_SLOT_HOURS} hores com a mínim`, {
      field: 'time_slot_1_end',
    });
  }
}

async function loadPoint(id) {
  return strapi.db.query(CONTACT).findOne({
    where: { id },
    populate: { sector: { select: ['id'] }, legal_form: { select: ['id'] }, owner: { select: ['id'] } },
  });
}

const ownerOf = (contact) =>
  contact && contact.owner && typeof contact.owner === 'object' ? contact.owner.id : null;

/** Her points with this NIF and this trade name (the link of a point she already had). */
async function samePoints(userId, data, cache) {
  if (!data.nif) return [];
  if (!cache.own) {
    cache.own = await strapi.db.query(CONTACT).findMany({
      where: { owner: { id: userId } },
      select: ['id', 'nif', 'name', 'trade_name'],
    });
  }
  const name = norm(data.trade_name || data.name);
  return cache.own.filter(
    (c) => normNif(c.nif) === data.nif && name && norm(c.trade_name || c.name) === name,
  );
}

const pointOut = (id) => ({ contact_id: id });

/** A warning when the point's town has no route: its orders can't get one. */
async function townWarnings(point, lookups) {
  if (!point || isBlank(point.city)) return [];
  const { routes } = await townRoutesOf(point, lookups);
  if (routes.length) return [];
  return [
    {
      code: 'TOWN_WITHOUT_ROUTES',
      message: `La població «${String(point.city).trim()}» no té cap ruta: les comandes a aquest punt no es podran fer fins que l'oficina n'hi posi una`,
      field: 'city',
    },
  ];
}

/** The write of one point; `ctx` = { userId, lookups, dryRun, cache }. */
async function syncContact(item, externalId, ctx) {
  const { userId, lookups, dryRun } = ctx;
  if (!item || typeof item !== 'object' || Array.isArray(item))
    reject('INVALID', 'Cada punt ha de ser un objecte');
  const warnings = [];
  const data = await dataOf(item, lookups, warnings);
  const done = async (out, point) => ({
    ...out,
    warnings: [...warnings, ...(await townWarnings(point, lookups))],
  });
  // the trade name is required on a point: the name stands in, as in the CSV import
  if (!('trade_name' in data) && data.name) data.trade_name = data.name;

  const found = (await refs.findRefs(userId, 'contact', [externalId])).get(externalId);
  let stored = found && found.target ? await loadPoint(found.target) : null;
  if (found && !stored && !dryRun) {
    // reserved by a write that died, or the office deleted the point: start again
    await refs.release(found.id);
  }

  if (stored) {
    if (ownerOf(stored) !== userId) {
      reject(
        'FORBIDDEN',
        "Aquest punt d'entrega ja no és teu: l'oficina l'ha canviat. Parla amb l'oficina.",
        pointOut(stored.id),
      );
    }
    return done(await writeUpdate(stored, data, ctx, 'updated'), { ...stored, ...data });
  }

  const same = await samePoints(userId, data, ctx.cache);
  if (same.length > 1) {
    reject(
      'AMBIGUOUS_MATCH',
      `Ja tens ${same.length} punts d'entrega amb aquest NIF i aquest nom comercial: no sabem quin és`,
      { contact_ids: same.map((c) => c.id) },
    );
  }
  if (same.length === 1) {
    const linkedTo = (await refs.externalIdsOf(userId, 'contact', [same[0].id])).get(same[0].id);
    if (linkedTo) {
      reject(
        'ALREADY_LINKED',
        `El punt d'entrega amb aquest NIF i aquest nom ja té un altre external_id («${linkedTo}»)`,
        { contact_id: same[0].id, linked_external_id: linkedTo },
      );
    }
    stored = await loadPoint(same[0].id);
    if (!dryRun && !(await refs.link(userId, 'contact', externalId, stored.id))) {
      reject('BUSY', "Aquest external_id ja s'està desant en una altra petició");
    }
    return done(await writeUpdate(stored, data, ctx, 'linked'), { ...stored, ...data });
  }

  return done(await writeCreate(externalId, data, ctx), data);
}

async function writeUpdate(stored, data, ctx, result) {
  const changed = changedFields(data, stored);
  if (!changed.length)
    return { result: result === 'linked' ? 'linked' : 'unchanged', ...pointOut(stored.id) };
  const after = { ...Object.fromEntries(FIELDS.map((f) => [f, storedValue(stored, f)])), ...data };
  checkComplete(after);
  const payload = Object.fromEntries(changed.map((f) => [f, data[f]]));
  memberRules.memberNewContact(payload, ctx.userId);
  if (!ctx.dryRun) {
    await strapi.service(CONTACT).update(stored.documentId, { data: payload });
  }
  return { result, ...pointOut(stored.id), changed };
}

async function writeCreate(externalId, data, ctx) {
  checkComplete(data);
  if (ctx.cache.pointType === undefined) {
    const type = await strapi.db
      .query('api::contact-type.contact-type')
      .findOne({ where: { id: DELIVERY_POINT_TYPE }, select: ['id'] });
    ctx.cache.pointType = type ? type.id : null;
  }
  const payload = memberRules.memberNewContact(
    { ...data, owner: ctx.userId, ...(ctx.cache.pointType ? { contact_types: [ctx.cache.pointType] } : {}) },
    ctx.userId,
  );
  payload.owner = ctx.userId;
  if (ctx.dryRun) return { result: 'created', contact_id: null };
  const refId = await refs.reserve(ctx.userId, 'contact', externalId);
  if (!refId) reject('BUSY', "Aquest external_id ja s'està desant en una altra petició");
  try {
    const created = await strapi.service(CONTACT).create({ data: payload });
    await refs.complete(refId, 'contact', created.id);
    if (ctx.cache.own)
      ctx.cache.own.push({
        id: created.id,
        nif: payload.nif,
        name: payload.name,
        trade_name: payload.trade_name,
      });
    return { result: 'created', ...pointOut(created.id) };
  } catch (error) {
    await refs.release(refId);
    throw error;
  }
}

module.exports = { syncContact, dataOf, changedFields, checkComplete, hourOf, REQUIRED };
