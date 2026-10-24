'use strict';

/**
 * What the Tresoreria forecast reads from `strapi.db` besides `query()`
 * (issues/328): the project's attributes (to leave the stored totals out) and
 * the link tables of the budget lines' documents. Spread into a test's
 * `strapi.db` stub; `links` gives rows per link table.
 */
const LINKS = {
  'api::phase-expense.phase-expense': {
    invoice: ['phase_expenses_invoice_lnk', 'phase_expense_id', 'received_invoice_id'],
    expense: ['phase_expenses_expense_lnk', 'phase_expense_id', 'received_expense_id'],
  },
  'api::phase-income.phase-income': {
    invoice: ['phase_incomes_invoice_lnk', 'phase_income_id', 'emitted_invoice_id'],
    income: ['phase_incomes_income_lnk', 'phase_income_id', 'received_income_id'],
  },
};

const PROJECT_ATTRIBUTES = {
  id: { type: 'increments' },
  name: { type: 'string' },
  is_mother: { type: 'boolean' },
  trashed: { type: 'boolean' },
  dirty: { type: 'boolean' },
  balance: { type: 'decimal' },
  project_phases: { type: 'relation' },
};

function treasuryDb(links = {}) {
  return {
    metadata: {
      get(uid) {
        if (uid === 'api::project.project') return { tableName: 'projects', attributes: PROJECT_ATTRIBUTES };
        const rel = LINKS[uid];
        if (!rel) return { tableName: uid, attributes: {} };
        const attributes = {};
        for (const [field, [name, join, inverse]] of Object.entries(rel)) {
          attributes[field] = {
            type: 'relation',
            joinTable: { name, joinColumn: { name: join }, inverseJoinColumn: { name: inverse } },
          };
        }
        return { tableName: uid, attributes };
      },
    },
    connection: (table) => ({ select: async () => links[table] || [] }),
  };
}

module.exports = { treasuryDb, PROJECT_ATTRIBUTES };
