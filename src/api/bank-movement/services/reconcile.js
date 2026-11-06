'use strict';
/* global strapi */

/**
 * «Conciliació» (issues/413): bank statements uploaded as Norma 43 files,
 * their movements matched with the lines of Tresoreria.
 *
 * - importStatement: parses the file (services/norma43.js), finds each account
 *   among the bank accounts by its IBAN, stores the new movements (a movement
 *   already imported, from an overlapping statement, is skipped by its hash),
 *   notes the closing balance as the account's «saldo real» at the start of
 *   the next day (issues/316), and runs the automatic pass.
 * - autoReconcile: accepts the movements with one clear line
 *   (matching.js), pairs the transfers between the entity's own accounts and
 *   applies the rules to what is left.
 * - acceptLines: a movement is one or more lines. A pending document is
 *   marked collected or paid on the bank's date, in full or in part
 *   (treasury-validation/services/settle.js, issues/415); a line already paid
 *   is validated. Every validation points to the movement.
 * - createFromMovement: a movement without a document becomes an «Operació de
 *   tresoreria» (bank fees, …) or a paid expense, validated.
 * - transfer: two movements of the own accounts, each noted as an «Operació de
 *   tresoreria» on its account, so the per-account balances stay right and
 *   the total doesn't change.
 * - undo: puts everything back: the validations (and what they marked paid)
 *   and the records the movement created.
 */

const crypto = require('crypto');
const moment = require('moment');
const { parseNorma43, matchesIban, Norma43Error } = require('../../../services/norma43');
const {
  candidatesFromForecast,
  suggest,
  autoMatches,
  transferPairs,
  ruleFor,
  round2,
} = require('./matching');

const MOVEMENT = 'api::bank-movement.bank-movement';
const IMPORT = 'api::bank-import.bank-import';
const RULE = 'api::bank-rule.bank-rule';
const ACCOUNT = 'api::bank-account.bank-account';
const VALIDATION = 'api::treasury-validation.treasury-validation';
const TREASURY = 'api::treasury.treasury';
const EXPENSE = 'api::received-expense.received-expense';
const CENT = 0.005;
// «Tria les línies» without a search: executed lines up to this many days from the movement
const CANDIDATE_DAYS = 60;

class ReconcileError extends Error {}

// required lazily: settle.js needs movement-dates, and the validation
// controller requires this file
const settle = () => require('../../treasury-validation/services/settle');

const MOVEMENT_POPULATE = { bank_account: true, rule: { select: ['id', 'name'] }, transfer_movement: { select: ['id'] } };

/** A stored movement as matching.js reads it. */
const forMatching = (m) => ({
  id: m.id,
  amount: round2(m.amount),
  date: String(m.date).substring(0, 10),
  account: (m.bank_account && m.bank_account.name) || null,
  concept: m.concept,
  reference: m.reference,
  document: m.document,
});

/** Every row of Tresoreria, as GET /treasuries/forecast answers. */
async function forecastRows() {
  const res = await strapi.controller('api::treasury.treasury').forecast({ query: {}, state: {} });
  return (res && res.treasury) || [];
}

const loadCandidates = async () => candidatesFromForecast(await forecastRows());

const loadMovement = (id) => strapi.db.query(MOVEMENT).findOne({ where: { id: Number(id) }, populate: MOVEMENT_POPULATE });

const loadPending = () =>
  strapi.db.query(MOVEMENT).findMany({ where: { status: 'pending' }, populate: MOVEMENT_POPULATE, orderBy: { date: 'asc' } });

const parseKey = (key) => {
  const [entity_type, id, ...rest] = String(key).split(':');
  return { entity_type, entity_id: Number(id), sub_type: rest.length ? rest.join(':') : null };
};

const keyWhere = ({ entity_type, entity_id, sub_type }) => ({
  entity_type,
  entity_id,
  sub_type: sub_type ? sub_type : { $null: true },
});

const decode = (base64) => {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // banks write Latin-1
    return buf.toString('latin1');
  }
};

const cccLabel = (a) => `${a.bank} ${a.branch} ** ${a.account}`;

async function markMatched(id, data, userId) {
  await strapi.db.query(MOVEMENT).update({
    where: { id },
    data: { status: 'matched', matched_by: userId || null, matched_at: new Date(), ...data },
  });
}

/**
 * @param {{ fileName: string, content: string (base64), userId: number }} p
 */
async function importStatement({ fileName, content, userId }) {
  let parsed;
  try {
    parsed = parseNorma43(decode(content));
  } catch (e) {
    if (e instanceof Norma43Error) throw new ReconcileError(e.message);
    throw e;
  }
  const bankAccounts = await strapi.db.query(ACCOUNT).findMany({});
  const resolved = parsed.accounts.map((a) => ({ a, account: bankAccounts.find((b) => matchesIban(b.iban, a)) }));
  const missing = resolved.filter((r) => !r.account);
  if (missing.length) {
    throw new ReconcileError(
      `El compte ${missing.map((r) => cccLabel(r.a)).join(', ')} del fitxer no és cap dels comptes bancaris de l'entitat: afegiu-ne l'IBAN a Administració › Comptes bancaris`,
    );
  }

  const accounts = [];
  for (const { a, account } of resolved) {
    const imp = await strapi.db.query(IMPORT).create({
      data: {
        file_name: fileName || null,
        bank_account: account.id,
        date_from: a.start,
        date_to: a.end,
        opening_balance: a.opening,
        closing_balance: a.closing,
        imported_by: userId || null,
      },
    });
    const seen = new Map();
    let created = 0;
    let duplicate = 0;
    for (const m of a.movements) {
      const reference = [m.reference1, m.reference2].filter(Boolean).join(' ');
      const base = [account.id, m.date, m.value_date, m.amount.toFixed(2), m.common_concept, m.own_concept, m.document, reference, m.concept].join('|');
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      const hash = crypto.createHash('sha1').update(`${base}|${n}`).digest('hex');
      const exists = await strapi.db.query(MOVEMENT).findOne({ where: { hash }, select: ['id'] });
      if (exists) {
        duplicate++;
        continue;
      }
      await strapi.db.query(MOVEMENT).create({
        data: {
          bank_account: account.id,
          bank_import: imp.id,
          date: m.date,
          value_date: m.value_date,
          amount: m.amount,
          concept: m.concept || null,
          reference: reference || null,
          document: m.document || null,
          common_concept: m.common_concept,
          hash,
          status: 'pending',
        },
      });
      created++;
    }
    await strapi.db.query(IMPORT).update({ where: { id: imp.id }, data: { movements_new: created, movements_duplicate: duplicate } });
    await noteClosingBalance(account, a, userId);
    accounts.push({ bank_account: account.name, from: a.start, to: a.end, created, duplicate, closing: a.closing });
  }

  const auto = await autoReconcile(userId);
  return { accounts, auto };
}

// the balance at the end of the statement is the balance at the start of the
// next day, as Tresoreria reads a noted balance (services/balances.js)
async function noteClosingBalance(account, a, userId) {
  const date = moment(a.end, 'YYYY-MM-DD').add(1, 'day').format('YYYY-MM-DD');
  const where = { is_real_balance: true, date, bank_account: { id: account.id } };
  const existing = await strapi.db.query(TREASURY).findOne({ where });
  const row = existing
    ? await strapi.db.query(TREASURY).update({ where: { id: existing.id }, data: { total: a.closing } })
    : await strapi.db.query(TREASURY).create({
        data: { comment: "Saldo segons l'extracte bancari", total: a.closing, date, bank_account: account.id, is_real_balance: true },
      });
  const key = { entity_type: 'treasuries', entity_id: row.id, sub_type: null };
  const validated = await strapi.db.query(VALIDATION).findOne({ where: keyWhere(key) });
  if (!validated) {
    await strapi.db.query(VALIDATION).create({ data: { ...key, validated_by: userId || null, publishedAt: new Date() } });
  }
}

/**
 * @param {number} movementId
 * @param {{ id: string, amount?: number }[]} picks candidate ids (matching.js); `amount` for part of a pending document
 */
async function acceptLines(movementId, picks, userId, { auto = false, lines = null } = {}) {
  const m = await loadMovement(movementId);
  if (!m) throw new ReconcileError('Moviment no trobat');
  if (m.status !== 'pending') throw new ReconcileError('Aquest moviment ja està conciliat');
  if (!Array.isArray(picks) || !picks.length) throw new ReconcileError('Tria almenys una línia');
  const all = lines || (await loadCandidates());
  const amount = round2(m.amount);

  const chosen = picks.map((p) => {
    const line = all.find((l) => l.id === p.id);
    if (!line) throw new ReconcileError('Una de les línies ja no està pendent de conciliar: torna a carregar la pàgina');
    const part = p.amount !== undefined && p.amount !== null ? round2(p.amount) : line.amount;
    if (Math.abs(part - line.amount) >= CENT && !line.settle) {
      throw new ReconcileError('Només un document pendent es pot cobrar o pagar en part');
    }
    return { line, part };
  });
  const sum = round2(chosen.reduce((s, c) => s + c.part, 0));
  if (Math.abs(sum - amount) >= CENT) {
    throw new ReconcileError(`Les línies sumen ${sum.toFixed(2)} € i el moviment és de ${amount.toFixed(2)} €`);
  }

  try {
    for (const { line, part } of chosen) {
      if (line.settle) {
        await settle().settleDocument({
          entity_type: line.settle.kind,
          entity_id: line.settle.id,
          date: String(m.date).substring(0, 10),
          amount: Math.abs(part - line.amount) >= CENT ? part : undefined,
          userId,
          bankMovementId: m.id,
        });
        continue;
      }
      for (const key of line.keys) {
        const k = parseKey(key);
        if (await strapi.db.query(VALIDATION).findOne({ where: keyWhere(k) })) {
          throw new ReconcileError('Una de les línies ja està validada: torna a carregar la pàgina');
        }
        await strapi.db.query(VALIDATION).create({
          data: { ...k, validated_by: userId || null, bank_movement: m.id, publishedAt: new Date() },
        });
      }
    }
  } catch (e) {
    await removeValidations(m.id);
    if (e instanceof settle().SettleError) throw new ReconcileError(e.message);
    throw e;
  }
  await markMatched(m.id, { match_kind: 'lines', auto }, userId);
  return { matched: true };
}

async function removeValidations(movementId) {
  const validations = await strapi.db.query(VALIDATION).findMany({ where: { bank_movement: { id: movementId } } });
  for (const v of validations) {
    await settle().unsettle(v);
    await strapi.db.query(VALIDATION).delete({ where: { id: v.id } });
  }
}

const truncate = (s, n) => (s && s.length > n ? `${s.substring(0, n - 1)}…` : s);

async function createAnnotation(m, { comment, project }, userId) {
  const row = await strapi.db.query(TREASURY).create({
    data: {
      comment: truncate(comment || m.concept || 'Moviment bancari', 255),
      total: round2(m.amount),
      date: String(m.date).substring(0, 10),
      bank_account: m.bank_account ? m.bank_account.id : null,
      project: project || null,
    },
  });
  await strapi.db.query(VALIDATION).create({
    data: { entity_type: 'treasuries', entity_id: row.id, validated_by: userId || null, bank_movement: m.id, publishedAt: new Date() },
  });
  return { uid: TREASURY, id: row.id };
}

async function createExpense(m, { comment, project, contact, document_type }, userId) {
  if (!(m.amount < 0)) throw new ReconcileError('Només un càrrec pot ser una despesa');
  if (!contact || !project) throw new ReconcileError('Una despesa necessita un contacte i un projecte');
  const date = String(m.date).substring(0, 10);
  const serie = await strapi.db.query('api::serie.serie').findOne({ where: { name: date.substring(0, 4) } });
  if (!serie) throw new ReconcileError(`No hi ha cap sèrie ${date.substring(0, 4)} per numerar la despesa`);
  const paymentMethod = m.bank_account
    ? await strapi.db.query('api::payment-method.payment-method').findOne({ where: { bank_account: { id: m.bank_account.id } } })
    : null;
  const expense = await strapi.documents(EXPENSE).create({
    data: {
      emitted: date,
      paybefore: date,
      paid: true,
      paid_date: date,
      contact: { connect: [{ id: Number(contact) }] },
      projects: { connect: [{ id: Number(project) }] },
      serial: { connect: [{ id: serie.id }] },
      ...(document_type ? { document_type: { connect: [{ id: Number(document_type) }] } } : {}),
      ...(paymentMethod ? { payment_method: { connect: [{ id: paymentMethod.id }] } } : {}),
      lines: [{ concept: truncate(comment || m.concept || 'Moviment bancari', 255), base: -round2(m.amount), quantity: 1, vat: 0, irpf: 0 }],
    },
  });
  await strapi.db.query(VALIDATION).create({
    data: { entity_type: 'received-expenses', entity_id: expense.id, validated_by: userId || null, bank_movement: m.id, publishedAt: new Date() },
  });
  return { uid: EXPENSE, id: expense.id };
}

/**
 * @param {{ kind: 'annotation'|'expense', comment?, project?, contact?, document_type? }} what
 */
async function createFromMovement(movementId, what, userId, { rule = null, auto = false } = {}) {
  const m = await loadMovement(movementId);
  if (!m) throw new ReconcileError('Moviment no trobat');
  if (m.status !== 'pending') throw new ReconcileError('Aquest moviment ja està conciliat');
  const kind = what && what.kind;
  if (!['annotation', 'expense'].includes(kind)) throw new ReconcileError('Què s\'ha de crear?');
  const record = kind === 'expense' ? await createExpense(m, what, userId) : await createAnnotation(m, what, userId);
  await markMatched(m.id, { match_kind: kind, created_records: [record], rule: rule ? rule.id : null, auto }, userId);
  return { matched: true, record };
}

async function transfer(idA, idB, userId, { auto = false } = {}) {
  const a = await loadMovement(idA);
  const b = await loadMovement(idB);
  if (!a || !b) throw new ReconcileError('Moviment no trobat');
  if (a.status !== 'pending' || b.status !== 'pending') throw new ReconcileError('Algun dels moviments ja està conciliat');
  if (!a.bank_account || !b.bank_account || a.bank_account.id === b.bank_account.id) {
    throw new ReconcileError('Un traspàs és entre dos comptes diferents');
  }
  if (Math.abs(round2(a.amount) + round2(b.amount)) >= CENT) {
    throw new ReconcileError('Els imports dels dos moviments no es compensen');
  }
  const [out, inn] = a.amount < 0 ? [a, b] : [b, a];
  const comment = `Traspàs ${out.bank_account.name} → ${inn.bank_account.name}`;
  for (const [m, other] of [[a, b], [b, a]]) {
    const record = await createAnnotation(m, { comment }, userId);
    await markMatched(m.id, { match_kind: 'transfer', created_records: [record], transfer_movement: other.id, auto }, userId);
  }
  return { matched: true };
}

async function ignore(movementId, userId) {
  const m = await loadMovement(movementId);
  if (!m) throw new ReconcileError('Moviment no trobat');
  if (m.status !== 'pending') throw new ReconcileError('Aquest moviment ja està conciliat');
  await strapi.db.query(MOVEMENT).update({
    where: { id: m.id },
    data: { status: 'ignored', matched_by: userId || null, matched_at: new Date() },
  });
  return { ignored: true };
}

async function undoOne(m) {
  await removeValidations(m.id);
  for (const r of m.created_records || []) {
    if (r.uid === EXPENSE) {
      const assigned = await strapi.db
        .query('api::phase-expense.phase-expense')
        .findOne({ where: { expense: { id: r.id } }, select: ['id'] });
      if (assigned) continue; // assigned to a project line since: it stays
      const expense = await strapi.db.query(EXPENSE).findOne({ where: { id: r.id }, select: ['id', 'documentId'] });
      if (expense) await strapi.documents(EXPENSE).delete({ documentId: expense.documentId });
    } else if (r.uid === TREASURY) {
      await strapi.db.query(TREASURY).delete({ where: { id: r.id } });
    }
  }
  await strapi.db.query(MOVEMENT).update({
    where: { id: m.id },
    data: {
      status: 'pending',
      match_kind: null,
      created_records: null,
      transfer_movement: null,
      rule: null,
      auto: false,
      matched_by: null,
      matched_at: null,
    },
  });
}

async function undo(movementId) {
  const m = await loadMovement(movementId);
  if (!m) throw new ReconcileError('Moviment no trobat');
  if (m.status === 'pending') return { undone: false };
  const pair = m.match_kind === 'transfer' && m.transfer_movement ? await loadMovement(m.transfer_movement.id) : null;
  await undoOne(m);
  if (pair && pair.status !== 'pending') await undoOne(pair);
  return { undone: true };
}

/**
 * After a validation of a movement is removed from Tresoreria: the movement is
 * pending again once it has none left.
 */
async function releaseMovement(movementId) {
  if (!movementId) return;
  const left = await strapi.db.query(VALIDATION).count({ where: { bank_movement: { id: movementId } } });
  if (left) return;
  await strapi.db.query(MOVEMENT).update({
    where: { id: movementId },
    data: { status: 'pending', match_kind: null, created_records: null, transfer_movement: null, rule: null, auto: false, matched_by: null, matched_at: null },
  });
}

const loadRules = () =>
  strapi.db.query(RULE).findMany({
    where: { active: true },
    populate: { bank_account: true, document_type: { select: ['id'] }, contact: { select: ['id'] }, project: { select: ['id'] } },
    orderBy: { id: 'asc' },
  });

async function applyRule(m, rule, userId) {
  if (rule.action === 'ignore') {
    await strapi.db.query(MOVEMENT).update({
      where: { id: m.id },
      data: { status: 'ignored', rule: rule.id, auto: true, matched_by: userId || null, matched_at: new Date() },
    });
    return;
  }
  await createFromMovement(
    m.id,
    {
      kind: rule.action === 'expense' ? 'expense' : 'annotation',
      comment: m.concept || rule.name,
      project: rule.project ? rule.project.id : null,
      contact: rule.contact ? rule.contact.id : null,
      document_type: rule.document_type ? rule.document_type.id : null,
    },
    userId,
    { rule, auto: true },
  );
}

/**
 * The automatic pass over the pending movements.
 * @returns {{ matched: number, transfers: number, ruled: number }}
 */
async function autoReconcile(userId) {
  const result = { matched: 0, transfers: 0, ruled: 0 };
  let pending = (await loadPending()).map((m) => ({ row: m, m: forMatching(m) }));
  if (!pending.length) return result;
  const lines = await loadCandidates();

  const wanted = autoMatches(pending.map((p) => p.m), lines);
  for (const [id, s] of wanted) {
    try {
      await acceptLines(id, s.lines.map((l) => ({ id: l.id })), userId, { auto: true, lines });
      result.matched++;
    } catch (e) {
      strapi.log.warn(`[bank-reconcile] movement ${id}: ${e.message}`);
    }
  }

  // what is left without a line of its amount
  pending = pending.filter((p) => !wanted.has(p.m.id) && !suggest(p.m, lines, { limit: 5 }).some((s) => s.kind === 'line'));
  for (const [a, b] of transferPairs(pending.map((p) => p.m))) {
    try {
      await transfer(a.id, b.id, userId, { auto: true });
      result.transfers++;
      pending = pending.filter((p) => p.m.id !== a.id && p.m.id !== b.id);
    } catch (e) {
      strapi.log.warn(`[bank-reconcile] transfer ${a.id}/${b.id}: ${e.message}`);
    }
  }

  const rules = await loadRules();
  for (const p of pending) {
    const rule = ruleFor(p.m, rules);
    if (!rule) continue;
    try {
      await applyRule(p.m, rule, userId);
      result.ruled++;
    } catch (e) {
      strapi.log.warn(`[bank-reconcile] rule ${rule.id} on movement ${p.m.id}: ${e.message}`);
    }
  }
  return result;
}

// a Tresoreria row, as «Conciliació» shows it
const lineView = (l) => ({
  id: l.id,
  amount: l.amount,
  date: l.date,
  account: l.account,
  contact: l.contact,
  code: l.code,
  type: l.type,
  to: l.to,
  pending: Boolean(l.pending),
});

/**
 * GET /bank-movements/reconciliation: the movements, with suggestions for the
 * pending ones and what the matched ones are.
 */
async function reconciliation({ status = 'pending', bankAccount = null, from = null, to = null } = {}) {
  const where = {};
  if (status && status !== 'all') where.status = status;
  if (bankAccount) where.bank_account = { id: Number(bankAccount) };
  if (from || to) where.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const movements = await strapi.db.query(MOVEMENT).findMany({
    where,
    populate: MOVEMENT_POPULATE,
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    limit: 500,
  });
  const matchedIds = movements.filter((m) => m.status === 'matched').map((m) => m.id);
  const validationsOf = new Map();
  if (matchedIds.length) {
    const all = await strapi.db.query(VALIDATION).findMany({
      where: { bank_movement: { id: { $in: matchedIds } } },
      populate: { bank_movement: { select: ['id'] } },
    });
    for (const v of all) {
      const id = v.bank_movement && v.bank_movement.id;
      validationsOf.set(id, [...(validationsOf.get(id) || []), v]);
    }
  }
  const rows = await forecastRows();
  const lines = candidatesFromForecast(rows);
  const byKey = new Map();
  for (const r of rows) {
    for (const k of r.validation_keys || (r.validation_key ? [r.validation_key] : [])) byKey.set(k, r);
  }
  const rules = await loadRules();
  const pendingMatching = movements.filter((m) => m.status === 'pending').map(forMatching);
  const pairs = transferPairs(pendingMatching);

  return {
    movements: movements.map((m) => {
      const base = {
        id: m.id,
        date: String(m.date).substring(0, 10),
        value_date: m.value_date,
        amount: round2(m.amount),
        concept: m.concept,
        reference: m.reference,
        document: m.document,
        bank_account: m.bank_account ? { id: m.bank_account.id, name: m.bank_account.name } : null,
        status: m.status,
        match_kind: m.match_kind,
        auto: Boolean(m.auto),
        rule: m.rule ? m.rule.name : null,
      };
      if (m.status === 'pending') {
        const fm = forMatching(m);
        const pair = pairs.find(([a, b]) => a.id === m.id || b.id === m.id);
        const rule = ruleFor(fm, rules);
        return {
          ...base,
          suggestions: suggest(fm, lines).map((s) => ({ ...s, lines: s.lines.map(lineView) })),
          transfer_with: pair ? (pair[0].id === m.id ? pair[1].id : pair[0].id) : null,
          rule_suggestion: rule ? { id: rule.id, name: rule.name, action: rule.action } : null,
        };
      }
      const validations = (validationsOf.get(m.id) || []).map((v) => {
        const key = [v.entity_type, v.entity_id, v.sub_type].filter(Boolean).join(':');
        const r = byKey.get(key);
        return r
          ? { key, type: r.type, code: r.concept, contact: r.contact, amount: round2(r.total_amount), to: r.to || null }
          : { key };
      });
      return { ...base, validations, created_records: m.created_records || [] };
    }),
  };
}

/** GET /bank-movements/:id/candidates?q=: every line a movement can be, best first. */
async function candidates(movementId, q) {
  const m = await loadMovement(movementId);
  if (!m) throw new ReconcileError('Moviment no trobat');
  const fm = forMatching(m);
  const lines = await loadCandidates();
  const query = String(q || '').trim().toLowerCase();
  const close = (l) => Math.abs(moment(fm.date).diff(moment(l.date), 'days'));
  // without a search: the executed lines of around the movement's date (not
  // years-old payments of a similar amount) and every pending document
  const filtered = lines.filter(
    (l) =>
      Math.sign(l.amount) === Math.sign(fm.amount) &&
      (query
        ? [l.code, l.contact, l.type, String(Math.abs(l.amount))].some((v) => String(v || '').toLowerCase().includes(query))
        : l.pending || close(l) <= CANDIDATE_DAYS),
  );
  return {
    movement: { ...fm, amount: fm.amount },
    lines: filtered
      .sort((a, b) => Math.abs(a.amount - fm.amount) - Math.abs(b.amount - fm.amount) || close(a) - close(b))
      .slice(0, 100)
      .map(lineView),
  };
}

module.exports = {
  importStatement,
  autoReconcile,
  acceptLines,
  createFromMovement,
  transfer,
  ignore,
  undo,
  releaseMovement,
  reconciliation,
  candidates,
  ReconcileError,
};
