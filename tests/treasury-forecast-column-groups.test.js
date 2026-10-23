'use strict';

/**
 * issues/328 — Loki, 2026-10-23: on raiels the Tresoreria forecast was rebuilt
 * from the database 8 times in 26 minutes, up to 16 s per request. Two causes:
 *   - every hours entry writes `projects.dirty` and the totals cron writes the
 *     stored totals; the cached pieces held whole projects, so both dropped
 *     them (now: no piece holds those columns, and they ignore the column
 *     group `projects#totals`);
 *   - the projects piece populated each budget line's document, so every new
 *     invoice, expense or income dropped the heaviest piece (now: the links
 *     come from the link tables, the documents from the document pieces).
 * The answer must stay the same.
 */

const { treasuryDb } = require('./helpers/treasury-db');
const { withPhaseDocuments } = require('../src/api/treasury/services/phase-documents');
const { PROJECT_TOTALS, PROJECT_TOTALS_COLUMNS } = require('../src/services/read-cache/column-groups');

const deepFreeze = (value, seen = new Set()) => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const k of Object.keys(value)) deepFreeze(value[k], seen);
  return value;
};

const RECEIVED = { id: 31, code: 'R-31', emitted: '2026-02-10', total_vat: 42, paid: true, total: 242, total_base: 200 };
const EMITTED = { id: 51, code: 'F-51', emitted: '2026-03-05', total_vat: 21, paid: true, total: 121, total_base: 100 };
const RINCOME = { id: 61, code: 'I-61', emitted: '2026-04-01', paid: true, total: 50, total_base: 50, document_type: { id: 1, name: 'Subvenció' } };
const REXPENSE = { id: 71, code: 'D-71', emitted: '2026-05-01', paid: true, total: 30, total_base: 30, document_type: { id: 2, name: 'Tiquet' } };

const line = (id, extra = {}) => ({ id, quantity: 1, amount: 100, total_amount: 100, date: '2026-06-01', paid: false, ...extra });

// the project as populate gave it before: documents on the lines
const projectWithDocs = () => ({
  id: 1,
  name: 'P1',
  trashed: false,
  is_mother: false,
  project_state: { id: 1, name: 'Aprovat' },
  mother: null,
  periodification: [],
  project_phases: [
    {
      id: 10,
      name: 'F1',
      expenses: [
        line(101, { paid: true, invoice: RECEIVED, expense: null }),
        line(102, { paid: true, invoice: null, expense: REXPENSE }),
        line(103, { invoice: null, expense: null }),
      ],
      incomes: [line(201, { paid: true, invoice: EMITTED, income: null }), line(202, { invoice: null, income: RINCOME })],
    },
  ],
});

// the same project as the new projects piece reads it: no document fields
const projectWithoutDocs = () => {
  const p = projectWithDocs();
  for (const ph of p.project_phases) {
    for (const l of [...ph.expenses, ...ph.incomes]) {
      delete l.invoice;
      delete l.expense;
      delete l.income;
    }
  }
  return p;
};

const LINK_ROWS = {
  phase_expenses_invoice_lnk: [{ phase_expense_id: 101, received_invoice_id: 31 }],
  phase_expenses_expense_lnk: [{ phase_expense_id: 102, received_expense_id: 71 }],
  phase_incomes_invoice_lnk: [{ phase_income_id: 201, emitted_invoice_id: 51 }],
  phase_incomes_income_lnk: [{ phase_income_id: 202, received_income_id: 61 }],
};

describe('withPhaseDocuments', () => {
  const links = {
    'expenses.invoice': [[101, 31]],
    'expenses.expense': [[102, 71], [103, 999]],
    'incomes.invoice': [[201, 51]],
    'incomes.income': [[202, 61]],
  };
  const docs = { received: [RECEIVED], receivedExpenses: [REXPENSE], emitted: [EMITTED], receivedIncomes: [RINCOME] };

  it('puts each line its documents back, null where it has none, as populate did', () => {
    const [p] = withPhaseDocuments(deepFreeze([projectWithoutDocs()]), links, docs);
    expect(p).toEqual(projectWithDocs());
  });

  it('a link to a document that is gone gives null (103 → 999)', () => {
    const [p] = withPhaseDocuments([projectWithoutDocs()], links, docs);
    expect(p.project_phases[0].expenses[2].expense).toBeNull();
  });

  it('never changes the cached, frozen projects', () => {
    const frozen = deepFreeze([projectWithoutDocs()]);
    const before = JSON.stringify(frozen);
    withPhaseDocuments(frozen, links, docs);
    expect(JSON.stringify(frozen)).toBe(before);
  });
});

describe('treasuries/forecast and the read cache (issues/328)', () => {
  let gets;

  function stub({ inline }) {
    const rows = {
      'api::project.project': () => [inline ? projectWithDocs() : projectWithoutDocs()],
      'api::received-invoice.received-invoice': () => [{ ...RECEIVED, projects: [{ id: 1, name: 'P1' }] }],
      'api::emitted-invoice.emitted-invoice': () => [{ ...EMITTED, projects: [{ id: 1, name: 'P1' }] }],
      'api::received-income.received-income': () => [{ ...RINCOME, projects: [{ id: 1, name: 'P1' }] }],
      'api::received-expense.received-expense': () => [{ ...REXPENSE, projects: [{ id: 1, name: 'P1' }] }],
    };
    gets = [];
    global.strapi = {
      db: {
        ...treasuryDb(inline ? {} : LINK_ROWS),
        query: (uid) => ({
          findMany: async (args) => {
            gets.push([uid, args]);
            return rows[uid] ? rows[uid]() : [];
          },
          findOne: async () => null,
          count: async () => 0,
        }),
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    };
  }

  let cacheCalls;
  beforeEach(() => {
    jest.resetModules();
    cacheCalls = [];
    jest.doMock('../src/services/read-cache', () => ({
      getReadCache: () => ({
        get: async (key, loader, options) => {
          cacheCalls.push([key, options]);
          return deepFreeze(await loader());
        },
      }),
    }));
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ options: {} }) }));
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
  });

  afterEach(() => {
    delete global.strapi;
  });

  async function forecast() {
    const controller = require('../src/api/treasury/controllers/treasury.js');
    const actions = typeof controller === 'function' ? controller({ strapi: global.strapi }) : controller;
    const ctx = { query: { _limit: '-1', year: '2026', periodification: 'no', project_states: '1' }, state: { user: { id: 1 } } };
    ctx.request = { query: ctx.query };
    return actions.forecast(ctx);
  }

  it('every forecast piece ignores the projects#totals column group', async () => {
    stub({ inline: false });
    await forecast();
    const pieces = cacheCalls.filter(([key]) => key.startsWith('treasury.forecast:') && key !== 'treasury.forecast:phaseDocumentLinks');
    expect(pieces.length).toBeGreaterThan(8);
    for (const [key, options] of pieces) expect([key, options.ignoreGroups]).toEqual([key, [PROJECT_TOTALS]]);
  });

  it('no piece reads a stored total or dirty; documents keep only their projects id and name', async () => {
    stub({ inline: false });
    await forecast();
    const [, projectArgs] = gets.find(([uid]) => uid === 'api::project.project');
    expect(projectArgs.select).toEqual(expect.arrayContaining(['id', 'name', 'is_mother', 'trashed']));
    for (const c of PROJECT_TOTALS_COLUMNS) expect(projectArgs.select).not.toContain(c);
    for (const uid of ['api::received-invoice.received-invoice', 'api::emitted-invoice.emitted-invoice']) {
      const [, args] = gets.find(([u]) => u === uid);
      expect(args.populate.project).toEqual({ select: ['id', 'name'] });
      expect(args.populate.projects).toEqual({ select: ['id', 'name'] });
    }
  });

  it('the projects piece does not read the documents tables; the links piece reads only link tables', async () => {
    stub({ inline: false });
    await forecast();
    const [, projectArgs] = gets.find(([uid]) => uid === 'api::project.project');
    const lines = projectArgs.populate.project_phases.populate;
    for (const f of ['invoice', 'expense', 'grant', 'ticket', 'diet']) expect(lines.expenses.populate).not.toHaveProperty(f);
    for (const f of ['invoice', 'income']) expect(lines.incomes.populate).not.toHaveProperty(f);
    const [, linkOptions] = cacheCalls.find(([key]) => key === 'treasury.forecast:phaseDocumentLinks');
    expect(linkOptions.tables.sort()).toEqual(Object.keys(LINK_ROWS).sort());
  });

  it('answers exactly as with the documents populated on the lines', async () => {
    stub({ inline: true });
    const before = await forecast();
    jest.resetModules();
    stub({ inline: false });
    const after = await forecast();
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)));
    // and the documents count: the paid lines' real amounts are in the year
    expect(after.forecast_by_year).toBeTruthy();
  });

  it('asks for every piece at once, not one after the other', async () => {
    stub({ inline: false });
    jest.resetModules();
    const waiting = [];
    jest.doMock('../src/services/read-cache', () => ({
      getReadCache: () => ({
        get: (key, loader) =>
          new Promise((resolve) => {
            waiting.push(key);
            // answered only once every piece has been asked for
            setTimeout(async () => resolve(deepFreeze(await loader())), 0);
          }),
      }),
    }));
    jest.doMock('../src/services/me-settings', () => ({ getMe: async () => ({ options: {} }) }));
    jest.doMock('@strapi/strapi', () => ({ factories: { createCoreController: (uid, build) => build } }));
    const done = forecast();
    await Promise.resolve();
    expect(waiting).toHaveLength(12);
    await done;
  });
});
