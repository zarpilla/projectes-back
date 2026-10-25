'use strict';
/* global strapi */

/**
 * Comunitat energètica: the members (contacts with the «Sòcia» type), their
 * supply points (CUPS), the installations and the history of distribution
 * coefficients. Used by the `admin_energy` permission (and projects/admin) from
 * the «Comunitat energètica» screens, only through /api/energy/* (see
 * routes/energy.js): this permission reaches no other contact.
 *
 * The rules of the coefficients' history are in services/energy-coefficients.js.
 */
const { errors } = require('@strapi/utils');
const { checkCups, cupsKey } = require('../../../services/energy-cups');
const rules = require('../../../services/energy-coefficients');

const CONTACT = 'api::contact.contact';
const CONTACT_TYPE = 'api::contact-type.contact-type';
const SUPPLY = 'api::energy.energy-supply';
const INSTALLATION = 'api::energy.energy-installation';
const COEFFICIENT = 'api::energy.energy-coefficient';
const LINK_TABLE = 'contacts_contact_types_lnk';

const PARTNER_TYPE = 'Sòcia';
const PARTNER_TYPE_NAMES = ['socia', 'socies', 'soci', 'socis'];

// what the screens may write on a member
const PARTNER_FIELDS = [
  'name',
  'nif',
  'email',
  'phone',
  'address',
  'city',
  'postcode',
  'notes',
  'join_date',
  'leave_date',
  'privacy_accepted',
  'partner_amount',
  'partner_amount_date',
];
const DATE_FIELDS = ['join_date', 'leave_date', 'partner_amount_date'];
const PARTNER_SELECT = ['id', 'documentId', ...PARTNER_FIELDS];
const SUPPLY_FIELDS = ['cups', 'holder_name', 'address', 'city', 'submitted', 'active', 'notes'];
const INSTALLATION_FIELDS = ['name', 'power_kw', 'cau', 'address', 'start_date', 'active', 'notes'];

const idOf = (value) => (value && typeof value === 'object' ? value.id : value);
const plain = (text) =>
  String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

/** A date column as 'YYYY-MM-DD' (the driver may give a Date). */
function toDay(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Turns the pure rules' 400 errors into Strapi's. */
async function guarded(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error && error.status === 400 && !(error instanceof errors.ApplicationError)) {
      throw new errors.ValidationError(error.message);
    }
    throw error;
  }
}

function pick(data, fields) {
  const out = {};
  for (const field of fields) {
    if (data && Object.prototype.hasOwnProperty.call(data, field)) out[field] = data[field];
  }
  return out;
}

function cleanPartner(data) {
  const out = pick(data, PARTNER_FIELDS);
  for (const field of DATE_FIELDS) if (field in out && !out[field]) out[field] = null;
  if ('partner_amount' in out && (out.partner_amount === '' || out.partner_amount === undefined)) {
    out.partner_amount = null;
  }
  if ('name' in out) {
    out.name = String(out.name || '').trim();
    if (!out.name) throw new errors.ValidationError('Falta el nom');
  }
  if ('email' in out && !out.email) out.email = null;
  if (data && Array.isArray(data.documents)) out.documents = data.documents.map(idOf).filter(Boolean);
  return out;
}

// --- the «Sòcia» contact type --------------------------------------------------

/** The id of the members' contact type; created when `create` and missing. */
async function partnerTypeId({ create = false } = {}) {
  const types = await strapi.db.query(CONTACT_TYPE).findMany({ select: ['id', 'name'] });
  const found = types.find((t) => PARTNER_TYPE_NAMES.includes(plain(t.name)));
  if (found) return found.id;
  if (!create) return null;
  const created = await strapi.db.query(CONTACT_TYPE).create({ data: { name: PARTNER_TYPE } });
  return created.id;
}

async function partnerIds() {
  const typeId = await partnerTypeId();
  if (!typeId) return [];
  const rows = await strapi.db.connection(LINK_TABLE).select('contact_id').where({ contact_type_id: typeId });
  return [...new Set(rows.map((r) => r.contact_id))];
}

async function isPartner(contactId) {
  const typeId = await partnerTypeId();
  if (!typeId) return false;
  const row = await strapi.db
    .connection(LINK_TABLE)
    .first('id')
    .where({ contact_id: contactId, contact_type_id: typeId });
  return Boolean(row);
}

async function loadPartner(id) {
  const contactId = Number(id);
  if (!contactId || !(await isPartner(contactId)))
    throw new errors.NotFoundError('Aquesta sòcia no existeix');
  return strapi.db.query(CONTACT).findOne({
    where: { id: contactId },
    select: PARTNER_SELECT,
    populate: { documents: true },
  });
}

// --- reading ----------------------------------------------------------------------

function formatSupply(supply) {
  const check = checkCups(supply.cups);
  return {
    id: supply.id,
    cups: supply.cups,
    cups_valid: check.valid,
    cups_problem: check.reason,
    holder_name: supply.holder_name || null,
    address: supply.address || null,
    city: supply.city || null,
    submitted: Boolean(supply.submitted),
    active: supply.active !== false,
    notes: supply.notes || null,
    contact: idOf(supply.contact) || null,
  };
}

function formatCoefficient(row, installations) {
  const installation = installations.get(idOf(row.installation));
  const power = installation ? installation.power_kw : null;
  return {
    id: row.id,
    supply: idOf(row.supply),
    installation: installation ? { id: installation.id, name: installation.name } : null,
    coefficient: Number(row.coefficient),
    start_date: toDay(row.start_date),
    end_date: toDay(row.end_date),
    notes: row.notes || null,
    kw:
      power !== null && power !== undefined
        ? Math.round(Number(row.coefficient) * Number(power) * 1000) / 1000
        : null,
  };
}

async function installationsById() {
  const list = await strapi.db.query(INSTALLATION).findMany({ orderBy: { name: 'asc' } });
  return new Map(list.map((i) => [i.id, i]));
}

async function coefficientsOf(where) {
  return strapi.db.query(COEFFICIENT).findMany({
    where,
    populate: { supply: { select: ['id'] }, installation: { select: ['id'] } },
    orderBy: [{ start_date: 'desc' }, { id: 'desc' }],
  });
}

/** The members with their CUPS and the coefficients in force on `date`. */
async function listPartners({ date } = {}) {
  const day = rules.isDate(date) ? date : today();
  const ids = await partnerIds();
  if (!ids.length) return [];
  const contacts = await strapi.db.query(CONTACT).findMany({
    where: { id: { $in: ids } },
    select: PARTNER_SELECT,
    populate: { documents: { select: ['id'] } },
    orderBy: { name: 'asc' },
  });
  const supplies = await strapi.db.query(SUPPLY).findMany({
    where: { contact: { id: { $in: ids } } },
    populate: { contact: { select: ['id'] } },
    orderBy: { id: 'asc' },
  });
  const installations = await installationsById();
  const coefficients = supplies.length
    ? await coefficientsOf({ supply: { id: { $in: supplies.map((s) => s.id) } } })
    : [];
  const bySupply = new Map();
  for (const row of coefficients) {
    const c = formatCoefficient(row, installations);
    if (!rules.isActiveOn(c, day)) continue;
    if (!bySupply.has(c.supply)) bySupply.set(c.supply, []);
    bySupply.get(c.supply).push(c);
  }
  const suppliesOf = new Map();
  for (const supply of supplies) {
    const s = formatSupply(supply);
    s.coefficients = bySupply.get(s.id) || [];
    if (!suppliesOf.has(s.contact)) suppliesOf.set(s.contact, []);
    suppliesOf.get(s.contact).push(s);
  }
  return contacts.map(({ documents, ...contact }) => ({
    ...contact,
    documents_count: (documents || []).length,
    supplies: suppliesOf.get(contact.id) || [],
  }));
}

/** A member, her documents, her CUPS and each CUPS's whole history. */
async function getPartner(id) {
  const contact = await loadPartner(id);
  const supplies = await strapi.db.query(SUPPLY).findMany({
    where: { contact: { id: contact.id } },
    populate: { contact: { select: ['id'] } },
    orderBy: { id: 'asc' },
  });
  const installations = await installationsById();
  const coefficients = supplies.length
    ? await coefficientsOf({ supply: { id: { $in: supplies.map((s) => s.id) } } })
    : [];
  const day = today();
  return {
    ...contact,
    documents: contact.documents || [],
    supplies: supplies.map((supply) => {
      const s = formatSupply(supply);
      s.coefficients = coefficients
        .filter((row) => idOf(row.supply) === s.id)
        .map((row) => {
          const c = formatCoefficient(row, installations);
          return { ...c, current: rules.isActiveOn(c, day) };
        });
      return s;
    }),
  };
}

// --- members ----------------------------------------------------------------------

async function createPartner(data) {
  const clean = cleanPartner(data);
  if (!clean.name) throw new errors.ValidationError('Falta el nom');
  const typeId = await partnerTypeId({ create: true });
  const created = await strapi.documents(CONTACT).create({ data: clean });
  await strapi.db
    .connection(LINK_TABLE)
    .insert({ contact_id: created.id, contact_type_id: typeId, contact_type_ord: 1 });
  return getPartner(created.id);
}

async function updatePartner(id, data) {
  const contact = await loadPartner(id);
  const clean = cleanPartner(data);
  await strapi.documents(CONTACT).update({ documentId: contact.documentId, data: clean });
  return getPartner(contact.id);
}

// --- supply points (CUPS) -------------------------------------------------------

/** Another active CUPS for the same point, owned by anyone. */
async function duplicateSupply(cups, exceptId) {
  const key = cupsKey(cups);
  const rows = await strapi.db.query(SUPPLY).findMany({
    where: { cups: { $startsWith: key } },
    populate: { contact: { select: ['id', 'name'] } },
  });
  return rows.find((r) => r.id !== exceptId && r.active !== false && cupsKey(r.cups) === key);
}

async function cleanSupply(data, existing = null) {
  const out = pick(data, SUPPLY_FIELDS);
  if ('cups' in out) {
    out.cups = checkCups(out.cups).cups;
    if (!out.cups) throw new errors.ValidationError('Falta el CUPS');
  }
  const cups = 'cups' in out ? out.cups : existing && existing.cups;
  const active = 'active' in out ? out.active !== false : !existing || existing.active !== false;
  if (cups && active) {
    const other = await duplicateSupply(cups, existing && existing.id);
    if (other) {
      const owner = other.contact ? other.contact.name : 'una altra fitxa';
      throw new errors.ValidationError(`Aquest CUPS ja està actiu a ${owner}`);
    }
  }
  return out;
}

async function loadSupply(id) {
  const supply = await strapi.db
    .query(SUPPLY)
    .findOne({ where: { id: Number(id) }, populate: { contact: { select: ['id'] } } });
  if (!supply) throw new errors.NotFoundError('Aquest CUPS no existeix');
  return supply;
}

async function createSupply(data) {
  const contact = await loadPartner(idOf(data && data.contact));
  const clean = await cleanSupply(data);
  if (!clean.cups) throw new errors.ValidationError('Falta el CUPS');
  const created = await strapi.db
    .query(SUPPLY)
    .create({ data: { active: true, ...clean, contact: contact.id } });
  return formatSupply({ ...created, contact: contact.id });
}

async function updateSupply(id, data) {
  const supply = await loadSupply(id);
  const clean = await cleanSupply(data, supply);
  const updated = await strapi.db.query(SUPPLY).update({ where: { id: supply.id }, data: clean });
  return formatSupply({ ...updated, contact: idOf(supply.contact) });
}

async function deleteSupply(id) {
  const supply = await loadSupply(id);
  const used = await strapi.db.query(COEFFICIENT).count({ where: { supply: { id: supply.id } } });
  if (used) {
    throw new errors.ValidationError(
      'Aquest CUPS té coeficients a l’històric: desactiva’l en lloc d’esborrar-lo',
    );
  }
  await strapi.db.query(SUPPLY).delete({ where: { id: supply.id } });
  return { id: supply.id };
}

// --- installations --------------------------------------------------------------

function cleanInstallation(data) {
  const out = pick(data, INSTALLATION_FIELDS);
  if ('name' in out) {
    out.name = String(out.name || '').trim();
    if (!out.name) throw new errors.ValidationError('Falta el nom');
  }
  if ('power_kw' in out && (out.power_kw === '' || out.power_kw === undefined)) out.power_kw = null;
  if ('start_date' in out && !out.start_date) out.start_date = null;
  return out;
}

async function loadInstallation(id) {
  const installation = await strapi.db.query(INSTALLATION).findOne({ where: { id: Number(id) } });
  if (!installation) throw new errors.NotFoundError('Aquesta instal·lació no existeix');
  return installation;
}

/** The installations with the sum of the coefficients in force on `date`. */
async function listInstallations({ date } = {}) {
  const day = rules.isDate(date) ? date : today();
  const list = await strapi.db.query(INSTALLATION).findMany({ orderBy: { name: 'asc' } });
  const rows = await coefficientsOf({});
  return list.map((installation) => {
    const own = rows
      .filter((r) => idOf(r.installation) === installation.id)
      .map((r) => ({ ...r, start_date: toDay(r.start_date), end_date: toDay(r.end_date) }));
    const { sum, over, free, kw_assigned, rows: active } = rules.summarize(own, day, installation.power_kw);
    // the first change after `date` (a distribution already set for later)
    const next_change =
      own
        .flatMap((r) => [r.start_date, r.end_date && rules.dayAfter(r.end_date)])
        .filter((d) => d && d > day)
        .sort()[0] || null;
    return {
      ...installation,
      date: day,
      sum,
      over,
      free,
      kw_assigned,
      supplies_count: active.length,
      next_change,
    };
  });
}

async function createInstallation(data) {
  const clean = cleanInstallation(data);
  if (!clean.name) throw new errors.ValidationError('Falta el nom');
  return strapi.db.query(INSTALLATION).create({ data: { active: true, ...clean } });
}

async function updateInstallation(id, data) {
  const installation = await loadInstallation(id);
  return strapi.db
    .query(INSTALLATION)
    .update({ where: { id: installation.id }, data: cleanInstallation(data) });
}

async function deleteInstallation(id) {
  const installation = await loadInstallation(id);
  const used = await strapi.db.query(COEFFICIENT).count({ where: { installation: { id: installation.id } } });
  if (used)
    throw new errors.ValidationError('Aquesta instal·lació té coeficients a l’històric: no es pot esborrar');
  await strapi.db.query(INSTALLATION).delete({ where: { id: installation.id } });
  return { id: installation.id };
}

/** The rows of an installation, as the rules read them. */
async function installationRows(installationId, supplyId) {
  const where = { installation: { id: installationId } };
  if (supplyId) where.supply = { id: supplyId };
  const rows = await coefficientsOf(where);
  return rows.map((r) => ({
    id: r.id,
    supply: idOf(r.supply),
    coefficient: Number(r.coefficient),
    start_date: toDay(r.start_date),
    end_date: toDay(r.end_date),
  }));
}

/** Who gets what from an installation on `date`: CUPS, member, coefficient and kW. */
async function distribution(id, { date } = {}) {
  const installation = await loadInstallation(id);
  const day = rules.isDate(date) ? date : today();
  const rows = await installationRows(installation.id);
  const summary = rules.summarize(rows, day, installation.power_kw);
  const supplies = await suppliesWithPartner(summary.rows.map((r) => r.supply));
  return {
    installation,
    date: day,
    sum: summary.sum,
    over: summary.over,
    free: summary.free,
    kw_assigned: summary.kw_assigned,
    // the days the distribution changed, for the history picker
    change_dates: [...new Set(rows.flatMap((r) => [r.start_date, r.end_date && rules.dayAfter(r.end_date)]))]
      .filter(Boolean)
      .sort()
      .reverse(),
    rows: summary.rows
      .map((r) => ({ ...r, ...supplies.get(r.supply) }))
      .sort((a, b) => String(a.partner_name || '').localeCompare(String(b.partner_name || ''), 'ca')),
  };
}

async function suppliesWithPartner(ids) {
  if (!ids.length) return new Map();
  const list = await strapi.db.query(SUPPLY).findMany({
    where: { id: { $in: [...new Set(ids)] } },
    populate: { contact: { select: ['id', 'name', 'nif'] } },
  });
  return new Map(
    list.map((s) => [
      s.id,
      {
        cups: s.cups,
        cups_valid: checkCups(s.cups).valid,
        holder_name: s.holder_name || null,
        partner_id: s.contact ? s.contact.id : null,
        partner_name: s.contact ? s.contact.name : null,
        partner_nif: s.contact ? s.contact.nif : null,
      },
    ]),
  );
}

async function applyPlan(plan) {
  for (const id of plan.remove || []) await strapi.db.query(COEFFICIENT).delete({ where: { id } });
  for (const { id, data } of plan.updates || []) {
    await strapi.db.query(COEFFICIENT).update({ where: { id }, data });
  }
  for (const data of plan.creates || []) await strapi.db.query(COEFFICIENT).create({ data });
}

/** A new distribution of an installation from `start_date` (see planDistribution). */
async function setDistribution(id, { start_date, rows: entries } = {}) {
  const installation = await loadInstallation(id);
  return guarded(async () => {
    for (const entry of entries || []) await loadSupply(idOf(entry.supply));
    await strapi.db.transaction(async () => {
      const rows = await installationRows(installation.id);
      const plan = rules.planDistribution(rows, start_date, entries);
      plan.creates = plan.creates.map((c) => ({ ...c, installation: installation.id }));
      await applyPlan(plan);
    });
    return distribution(installation.id, { date: start_date });
  });
}

// --- coefficients one by one (the member's form) --------------------------------

async function addCoefficient(data = {}) {
  const supply = await loadSupply(idOf(data.supply));
  const installation = await loadInstallation(idOf(data.installation));
  return guarded(async () => {
    await strapi.db.transaction(async () => {
      const rows = await installationRows(installation.id, supply.id);
      const step = rules.planAdd(rows, data);
      const creates = step.create
        ? [{ ...step.create, notes: data.notes || null, supply: supply.id, installation: installation.id }]
        : [];
      await applyPlan({ ...step, creates });
    });
    return getPartner(idOf(supply.contact));
  });
}

async function loadCoefficient(id) {
  const row = await strapi.db.query(COEFFICIENT).findOne({
    where: { id: Number(id) },
    populate: { supply: { populate: { contact: { select: ['id'] } } }, installation: { select: ['id'] } },
  });
  if (!row) throw new errors.NotFoundError('Aquest coeficient no existeix');
  return row;
}

async function updateCoefficient(id, data = {}) {
  const row = await loadCoefficient(id);
  return guarded(async () => {
    const others = await installationRows(idOf(row.installation), row.supply.id);
    const merged = {
      id: row.id,
      start_date: 'start_date' in data ? data.start_date : toDay(row.start_date),
      end_date: 'end_date' in data ? data.end_date : toDay(row.end_date),
      coefficient: 'coefficient' in data ? data.coefficient : row.coefficient,
    };
    const clean = rules.checkRow(others, merged);
    if ('notes' in data) clean.notes = data.notes || null;
    await strapi.db.query(COEFFICIENT).update({ where: { id: row.id }, data: clean });
    return getPartner(idOf(row.supply.contact));
  });
}

async function deleteCoefficient(id) {
  const row = await loadCoefficient(id);
  await strapi.db.transaction(async () => {
    const rows = await installationRows(idOf(row.installation), row.supply.id);
    const plan = rules.planDelete(rows, row.id);
    await strapi.db.query(COEFFICIENT).delete({ where: { id: row.id } });
    await applyPlan(plan);
  });
  return getPartner(idOf(row.supply.contact));
}

module.exports = {
  PARTNER_TYPE,
  partnerTypeId,
  listPartners,
  getPartner,
  createPartner,
  updatePartner,
  createSupply,
  updateSupply,
  deleteSupply,
  listInstallations,
  createInstallation,
  updateInstallation,
  deleteInstallation,
  distribution,
  setDistribution,
  addCoefficient,
  updateCoefficient,
  deleteCoefficient,
};
