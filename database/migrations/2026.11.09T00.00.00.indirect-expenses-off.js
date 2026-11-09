'use strict';

/**
 * issues/420: «Despesa indirecta als projectes» starts off on every tenant.
 *
 * The option only showed the project field «Despesa Indirecta (%)», hidden in
 * the front since 2024, so it showed nothing. New tenants got it on from the
 * seed. With issues/420 the field comes back with a new meaning (a % of the
 * project's expenses, shown in its «Resum»), so it is turned off everywhere and
 * each organization turns it on in Configuració general if it wants it.
 *
 * Runs once (Strapi records it); a tenant without the table or the column does
 * nothing.
 */

async function turnOff(knex) {
  if (!(await knex.schema.hasTable('components_options_options'))) return 0;
  if (!(await knex.schema.hasColumn('components_options_options', 'structural_expenses'))) return 0;
  return knex('components_options_options').update({ structural_expenses: false });
}

module.exports = {
  async up(knex) {
    await turnOff(knex);
  },
  async down() {
    // nothing to restore: which tenants had it on is not kept
  },
  turnOff,
};
