'use strict';

/**
 * issues/416: Tresoreria filters by several projects, project types or scopes
 * in the browser, so the `projects` the forecast returns carry their type and
 * scope ({ id, name } or null).
 */

const fs = require('fs');
const path = require('path');
const { forecastProjectOption } = require('../src/api/treasury/services/project-filter');

describe('forecast project options (issues/416)', () => {
  it('carries the project type and scope', () => {
    const option = forecastProjectOption({
      id: 7,
      name: 'ACTGI',
      code: 'x',
      project_state: { id: 1, name: 'En curs', color: 'red' },
      project_type: { id: 3, name: 'Formació', extra: 1 },
      project_scope: { id: 5, name: 'Agroecologia' },
      mother: null,
    });
    expect(option).toEqual({
      id: 7,
      name: 'ACTGI',
      project_state: { id: 1, name: 'En curs' },
      project_type: { id: 3, name: 'Formació' },
      project_scope: { id: 5, name: 'Agroecologia' },
      mother: null,
    });
  });

  it('gives null for a missing or sentinel relation', () => {
    const option = forecastProjectOption({ id: 8, name: 'B', project_type: 0 });
    expect(option.project_type).toBeNull();
    expect(option.project_scope).toBeNull();
    expect(option.mother).toBeNull();
    expect(option.project_state).toBeNull();
  });

  it('the forecast populates type and scope on its projects', () => {
    const controller = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'api', 'treasury', 'controllers', 'treasury.js'),
      'utf8',
    );
    const start = controller.indexOf('const PROJECT_FORECAST_POPULATE = {');
    const populate = controller.slice(start, controller.indexOf('};', start));
    expect(populate).toMatch(/\bproject_scope:\s*true\b/);
    expect(populate).toMatch(/FILTER_RELATIONS\.map/);
    expect(controller).toMatch(/projects: projects\.map\(forecastProjectOption\)/);
  });
});
