'use strict';

/**
 * issues/094 (2026-10-16): two lines of project 487 showed «Imports diferents»
 * against documents F 2024-562 and F 2024-125. The warning is stored on each
 * project line, but only the document form computed it, when the document was
 * saved: editing the lines in the project (amount, document, deleting one)
 * left it stale. Saving the project now recomputes it for every document its
 * execution lines pointed to before or after the save, from all the lines of
 * that document, in any project.
 */

const INCOME = 'api::phase-income.phase-income';
const EXPENSE = 'api::phase-expense.phase-expense';
const EMITTED = 'api::emitted-invoice.emitted-invoice';

// lines: { uid, id, invoice, income, expense, quantity, amount, warning, project }
function mockStrapi({ lines, documents }) {
  const updates = [];
  const ids = (cond) => (cond && cond.id && cond.id.$in) || null;
  global.strapi = {
    db: {
      query: jest.fn((uid) => ({
        findMany: jest.fn(async ({ where }) => {
          if (documents[uid]) {
            return documents[uid].filter((d) => ids(where).includes(d.id));
          }
          const field = Object.keys(where).find((k) => ['invoice', 'income', 'expense'].includes(k));
          return lines
            .filter((l) => l.uid === uid && l[field] != null)
            .filter((l) => !ids(where[field]) || ids(where[field]).includes(l[field]))
            .filter((l) => !(where.project_phase && where.project_phase.project) || l.project === where.project_phase.project.id)
            .map((l) => ({ ...l, [field]: { id: l[field] } }));
        }),
        updateMany: jest.fn(async ({ where, data }) => {
          for (const id of where.id.$in) updates.push({ uid, id, ...data });
        }),
      })),
    },
    log: { info: jest.fn() },
  };
  return { updates };
}

const load = () => require('../src/services/refresh-line-warnings');

describe('«Imports diferents» warning of project lines (issues/094)', () => {
  beforeEach(() => jest.resetModules());
  afterEach(() => { delete global.strapi; });

  it('clears a stale warning once the lines of all projects add up to the base', async () => {
    const { updates } = mockStrapi({
      documents: { [EMITTED]: [{ id: 562, total_base: 100 }] },
      lines: [
        { uid: INCOME, id: 1, invoice: 562, quantity: 1, amount: 60, warning: true, project: 487 },
        { uid: INCOME, id: 2, invoice: 562, quantity: 2, amount: 20, warning: null, project: 12 },
      ],
    });
    const { documentsOfProject, refreshLineWarnings } = load();
    await refreshLineWarnings(await documentsOfProject(487));
    expect(updates).toEqual([{ uid: INCOME, id: 1, warning: false }, { uid: INCOME, id: 2, warning: false }]);
  });

  it('warns on every line of the document when they no longer add up', async () => {
    const { updates } = mockStrapi({
      documents: { [EMITTED]: [{ id: 125, total_base: '2452.41' }] },
      lines: [
        { uid: INCOME, id: 3, invoice: 125, quantity: 1, amount: 2000, warning: false, project: 487 },
        { uid: INCOME, id: 4, invoice: 125, quantity: 1, amount: 400, warning: false, project: 487 },
      ],
    });
    const { documentsOfProject, refreshLineWarnings } = load();
    await refreshLineWarnings(await documentsOfProject(487));
    expect(updates).toEqual([{ uid: INCOME, id: 3, warning: true }, { uid: INCOME, id: 4, warning: true }]);
  });

  it('accepts a difference of a cent and leaves right lines untouched', async () => {
    const { updates } = mockStrapi({
      documents: { [EMITTED]: [{ id: 9, total_base: 2452.41 }, { id: 110, total_base: 78.18 }] },
      lines: [
        { uid: INCOME, id: 5, invoice: 9, quantity: 1, amount: 2452.4, warning: false, project: 1 },
        // 78.18 - 78.17 is 0.010000000000005 in floating point
        { uid: INCOME, id: 6, invoice: 110, quantity: 1, amount: 78.17, warning: false, project: 1 },
      ],
    });
    const { documentsOfProject, refreshLineWarnings } = load();
    await refreshLineWarnings(await documentsOfProject(1));
    expect(updates).toEqual([]);
  });

  it('rechecks the document a line was moved away from', async () => {
    const before = { [`${INCOME}#invoice`]: new Set([562]) };
    const { updates } = mockStrapi({
      documents: { [EMITTED]: [{ id: 562, total_base: 100 }, { id: 600, total_base: 40 }] },
      lines: [
        // line 1 now points to 600; 562 keeps only the line of the other project
        { uid: INCOME, id: 1, invoice: 600, quantity: 1, amount: 40, warning: true, project: 487 },
        { uid: INCOME, id: 2, invoice: 562, quantity: 1, amount: 60, warning: false, project: 12 },
      ],
    });
    const { documentsOfProject, mergeDocuments, refreshLineWarnings } = load();
    await refreshLineWarnings(mergeDocuments(before, await documentsOfProject(487)));
    expect(updates).toEqual([{ uid: INCOME, id: 2, warning: true }, { uid: INCOME, id: 1, warning: false }]);
  });

  it('covers received invoices and expenses on the expense lines', async () => {
    const { updates } = mockStrapi({
      documents: {
        'api::received-invoice.received-invoice': [{ id: 7, total_base: 50 }],
        'api::received-expense.received-expense': [{ id: 8, total_base: 10 }],
      },
      lines: [
        { uid: EXPENSE, id: 20, invoice: 7, quantity: 1, amount: 45, warning: false, project: 3 },
        { uid: EXPENSE, id: 21, expense: 8, quantity: 1, amount: 10, warning: true, project: 3 },
      ],
    });
    const { documentsOfProject, refreshLineWarnings } = load();
    await refreshLineWarnings(await documentsOfProject(3));
    expect(updates).toEqual([{ uid: EXPENSE, id: 20, warning: true }, { uid: EXPENSE, id: 21, warning: false }]);
  });
});
