'use strict';

/**
 * Tresoreria's "Afegir moviment" form kept Enviar disabled whatever was typed.
 *
 * GET /api/treasuries/forecast returns `projects`, which TreasuryAnnotationInput
 * filters with `p.mother === null || (p.mother !== null && p.mother.id && …)`.
 * v3 sent `mother` as an object or null; v5 omits an unpopulated relation, so
 * `p.mother.id` threw inside the render and Vue stopped re-rendering the form.
 * A populated to-one with no row comes back as null, which is the v3 shape.
 */

const fs = require('fs');
const path = require('path');

const controller = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'api', 'treasury', 'controllers', 'treasury.js'),
  'utf8',
);

describe('treasury forecast projects shape', () => {
  it('populates mother on the projects it returns', () => {
    const start = controller.indexOf("query('api::project.project')");
    expect(start).toBeGreaterThan(-1);
    const populate = controller.slice(start, controller.indexOf('});', start));
    expect(populate).toMatch(/\bmother:\s*true\b/);
  });
});
