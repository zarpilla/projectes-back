'use strict';

/**
 * issues/420: the project field «Despesa Indirecta (%)» (structural_expenses_pct)
 * gets a new meaning: a % of the project's own expenses, shown only in its
 * «Resum» (front). So
 *   - the API no longer adds that % of every project's incomes to the incomes
 *     of the structural projects (the old meaning, field hidden since 2024);
 *   - a migration turns the option «Despesa indirecta als projectes» off on
 *     every existing tenant (the seed is checked in seed-new-database.test.js).
 */
const fs = require('fs');
const path = require('path');

const CONTROLLER = path.join(__dirname, '..', 'src', 'api', 'project', 'controllers', 'project.js');
const MIGRATION = path.join(
  __dirname,
  '..',
  'database',
  'migrations',
  '2026.11.09T00.00.00.indirect-expenses-off.js',
);

describe('indirect expenses (issues/420)', () => {
  test('project totals no longer read structural_expenses_pct', () => {
    const source = fs.readFileSync(CONTROLLER, 'utf8');
    expect(source).not.toMatch(/structural_expenses_pct/);
    expect(source).not.toMatch(/indirectIncomes/);
  });

  const fakeKnex = ({ table = true, column = true } = {}) => {
    const calls = [];
    const knex = (name) => ({
      update: async (values) => {
        calls.push({ name, values });
        return 3;
      },
    });
    knex.schema = {
      hasTable: async () => table,
      hasColumn: async () => column,
    };
    return { knex, calls };
  };

  test('the migration turns the option off on every row', async () => {
    const { knex, calls } = fakeKnex();
    const migration = require(MIGRATION);
    await migration.up(knex);
    expect(calls).toEqual([{ name: 'components_options_options', values: { structural_expenses: false } }]);
  });

  test('the migration does nothing without the table or the column', async () => {
    const migration = require(MIGRATION);
    for (const opts of [{ table: false }, { column: false }]) {
      const { knex, calls } = fakeKnex(opts);
      await expect(migration.turnOff(knex)).resolves.toBe(0);
      expect(calls).toEqual([]);
    }
  });
});
