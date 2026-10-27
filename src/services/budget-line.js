'use strict';

/**
 * Budget lines (phase incomes / expenses, current and original plan): quantity
 * and unit price keep 4 decimals, the line total is rounded to cents. The one
 * formula every total uses — project totals, Resum, treasury, reports
 * (issues/194: a typed 0,0357 was stored as 0,04 and each place added it up
 * its own way).
 */
const BUDGET_LINE_SCALE = 4;

const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

const lineTotal = (line) => round2((Number(line && line.quantity) || 0) * (Number(line && line.amount) || 0));

// A quantity or price the database can store: empty (null) or a number, also
// as text ("7.25"). Anything else made the decimal column throw and the save
// answer a 500 (issues/224: a typed 1.000,5 reached the API as "1.000.5").
const isStorableNumber = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
};

const LINE_FIELDS = { quantity: 'La quantitat', amount: 'El preu' };

/** The first non-numeric quantity / price of a phases payload, as a message; null if all are valid. */
const invalidLineValueMessage = (phases) => {
  for (const phase of Array.isArray(phases) ? phases : []) {
    for (const line of [...((phase && phase.incomes) || []), ...((phase && phase.expenses) || [])]) {
      for (const [field, label] of Object.entries(LINE_FIELDS)) {
        if (line && !isStorableNumber(line[field])) {
          const concept = line.concept ? ` de «${line.concept}»` : '';
          return `${label}${concept} no és un número vàlid: «${line[field]}»`;
        }
      }
    }
  }
  return null;
};

/**
 * issues/345: the lines of a phase keep the order the form sends them in (the
 * user can reorder them with drag & drop). Sets `position` to each line's index
 * and returns the saved lines that only moved: new and edited (`dirty`) lines
 * carry the position in their own write.
 */
const assignLinePositions = (lines) => {
  const moved = [];
  (lines || []).forEach((line, index) => {
    if (!line) return;
    if (line.id && !line.dirty && line.position !== index) moved.push({ id: line.id, position: index });
    line.position = index;
  });
  return moved;
};

/**
 * The saved order of a list (phases of a project, lines of a phase): by
 * `position`, the rows without one (never reordered) after them in the order
 * they came. Stable; sorts in place and returns the list.
 */
const sortByPosition = (rows) => {
  if (!Array.isArray(rows)) return rows;
  const rank = (row) => {
    const p = row && row.position;
    return p === null || p === undefined || p === '' ? Infinity : Number(p);
  };
  const sorted = rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index);
  sorted.forEach((item, i) => {
    rows[i] = item.row;
  });
  return rows;
};

/**
 * Phases and their lines in the saved order (issues/345 lines, phases too).
 * Every endpoint that hands phases to the front sorts them: a form that saves
 * them back without showing them (an invoice fixing its #ESBORRANY# line, for
 * instance) sends them in this order, and updatePhases stores that order.
 */
const sortPhasesByPosition = (phases) => {
  if (!Array.isArray(phases)) return phases;
  sortByPosition(phases);
  phases.forEach((phase) => {
    if (!phase) return;
    sortByPosition(phase.incomes);
    sortByPosition(phase.expenses);
  });
  return phases;
};

module.exports = {
  BUDGET_LINE_SCALE,
  lineTotal,
  isStorableNumber,
  invalidLineValueMessage,
  assignLinePositions,
  sortByPosition,
  sortPhasesByPosition,
};
