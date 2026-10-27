'use strict';

/**
 * The history of the energy community's distribution coefficients: the share
 * (0–1) of an installation's power each CUPS gets, from `start_date` to
 * `end_date` (empty: still in force). Pure functions: they look at the rows of
 * one CUPS and one installation (or of one installation) and say what to write.
 * services/../api/energy/services/energy.js does the reading and writing.
 *
 * Rules:
 *  - The periods of a CUPS in an installation never overlap.
 *  - A new coefficient from a date closes the one in force the day before, so
 *    the history is kept: changing a coefficient is adding a row, not editing.
 *  - A coefficient of 0 from a date only closes the one in force: the CUPS
 *    leaves the installation.
 *  - The coefficients of an installation on a day should add up to 1 at most;
 *    more is allowed while the board fills them in, and shown as a warning.
 *
 * Dates are 'YYYY-MM-DD' strings, compared as text.
 */

const EPSILON = 1e-9;

const idOf = (value) => (value && typeof value === 'object' ? value.id : value);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** '2026-03-01' → '2026-02-28' */
function dayBefore(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** '2026-02-28' → '2026-03-01' */
function dayAfter(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Whether the row is in force on `date`. */
function isActiveOn(row, date) {
  return row.start_date <= date && (!row.end_date || row.end_date >= date);
}

/** Whether two periods share a day (an empty end goes on forever). */
function overlaps(a, b) {
  const aEnd = a.end_date || '9999-12-31';
  const bEnd = b.end_date || '9999-12-31';
  return a.start_date <= bEnd && b.start_date <= aEnd;
}

/** A coefficient as stored: a number from 0 to 1, rounded to 6 decimals. */
function parseCoefficient(value) {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n)) {
    throw badRequest('El coeficient ha de ser un número');
  }
  if (n < 0 || n > 1 + EPSILON) throw badRequest('El coeficient ha de ser entre 0 i 1');
  return Math.round(n * 1e6) / 1e6;
}

/**
 * What to write to give a CUPS `coefficient` of an installation from
 * `start_date`. `rows`: that CUPS's rows in that installation.
 * → { updates: [{ id, data }], create: data | null, remove: [id] }
 */
function planAdd(rows, { start_date, coefficient }) {
  if (!isDate(start_date)) throw badRequest('Falta la data d’inici');
  const value = parseCoefficient(coefficient);
  const updates = [];
  const remove = [];

  const same = rows.find((r) => r.start_date === start_date);
  const active = rows.find((r) => r.start_date < start_date && isActiveOn(r, start_date));
  const next = rows
    .filter((r) => r.start_date > start_date)
    .sort((a, b) => (a.start_date < b.start_date ? -1 : 1))[0];

  if (same) {
    // the same day again: it corrects that row
    if (value === 0) remove.push(same.id);
    else updates.push({ id: same.id, data: { coefficient: value } });
    return { updates, create: null, remove };
  }

  if (active) updates.push({ id: active.id, data: { end_date: dayBefore(start_date) } });
  if (value === 0) return { updates, create: null, remove };

  let end_date = null;
  if (next) end_date = dayBefore(next.start_date);
  else if (active && active.end_date) end_date = active.end_date;
  return { updates, create: { start_date, end_date, coefficient: value }, remove };
}

/**
 * Checks a row being corrected by hand against the other rows of the same CUPS
 * and installation. Returns the clean data.
 */
function checkRow(others, row) {
  if (!isDate(row.start_date)) throw badRequest('Falta la data d’inici');
  const end_date = row.end_date ? row.end_date : null;
  if (end_date && !isDate(end_date)) throw badRequest('La data de final no és vàlida');
  if (end_date && end_date < row.start_date) throw badRequest('La data de final és anterior a la d’inici');
  const clean = { start_date: row.start_date, end_date, coefficient: parseCoefficient(row.coefficient) };
  const clash = others.find((o) => o.id !== row.id && overlaps(o, clean));
  if (clash) {
    throw badRequest(
      `Se solapa amb el coeficient del ${clash.start_date}${clash.end_date ? ` al ${clash.end_date}` : ''}`,
    );
  }
  return clean;
}

/**
 * What to write when a row is deleted: the previous row, closed the day before
 * it started, takes its end again (deleting the last change undoes it).
 */
function planDelete(rows, id) {
  const row = rows.find((r) => r.id === id);
  if (!row) return { updates: [] };
  const previous = rows.find((r) => r.id !== id && r.end_date === dayBefore(row.start_date));
  return { updates: previous ? [{ id: previous.id, data: { end_date: row.end_date || null } }] : [] };
}

/**
 * A whole new distribution of an installation from `start_date`: every CUPS in
 * `entries` ([{ supply, coefficient }]) gets its coefficient, and the CUPS in
 * force that day but missing from `entries` leave the installation.
 * `rows`: all the rows of the installation (with `supply`).
 * → { updates, creates: [data with supply], remove }
 */
function planDistribution(rows, start_date, entries) {
  if (!isDate(start_date)) throw badRequest('Falta la data d’inici');
  const bySupply = new Map();
  for (const row of rows) {
    const supply = idOf(row.supply);
    if (!bySupply.has(supply)) bySupply.set(supply, []);
    bySupply.get(supply).push(row);
  }
  const wanted = new Map();
  for (const entry of entries || []) {
    const supply = idOf(entry.supply);
    if (!supply) throw badRequest('Falta el CUPS d’una fila');
    if (wanted.has(supply)) throw badRequest('Un CUPS surt dues vegades al repartiment');
    wanted.set(supply, entry.coefficient);
  }
  for (const [supply, list] of bySupply) {
    if (!wanted.has(supply) && list.some((r) => isActiveOn(r, start_date))) wanted.set(supply, 0);
  }

  const plan = { updates: [], creates: [], remove: [] };
  for (const [supply, coefficient] of wanted) {
    const step = planAdd(bySupply.get(supply) || [], { start_date, coefficient });
    plan.updates.push(...step.updates);
    plan.remove.push(...step.remove);
    if (step.create) plan.creates.push({ ...step.create, supply });
  }
  return plan;
}

/**
 * The rows of an installation in force on `date`, their sum and the power each
 * one gets. `power`: the installation's power in kW (may be empty).
 */
function summarize(rows, date, power) {
  const active = rows.filter((r) => isActiveOn(r, date));
  const sum = Math.round(active.reduce((s, r) => s + Number(r.coefficient || 0), 0) * 1e6) / 1e6;
  const kw = Number(power);
  const withPower = Number.isFinite(kw) && power !== null && power !== '';
  return {
    rows: active.map((r) => ({
      ...r,
      kw: withPower ? Math.round(Number(r.coefficient) * kw * 1000) / 1000 : null,
    })),
    sum,
    over: sum > 1 + EPSILON,
    free: Math.round((1 - sum) * 1e6) / 1e6,
    kw_assigned: withPower ? Math.round(sum * kw * 1000) / 1000 : null,
  };
}

module.exports = {
  dayBefore,
  dayAfter,
  isActiveOn,
  overlaps,
  parseCoefficient,
  planAdd,
  checkRow,
  planDelete,
  planDistribution,
  summarize,
  isDate,
};
