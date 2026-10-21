'use strict';

/**
 * issues/309: forecast and phases-both declare to the read cache (issues/307)
 * the tables their queries read, so the MySQL stamps of those tables are read
 * before the first load and that load can be kept (it was loaded twice).
 * queryTables must give what the query reads: the entity's table, the link
 * tables and targets of what is populated (nested too), components, and the
 * files' morph link table; nothing that isn't populated.
 */

const { queryTables } = require('../src/services/query-tables');

const META = {
  'api::project.project': {
    tableName: 'projects',
    attributes: {
      name: { type: 'string' },
      project_state: { type: 'relation', target: 'api::project-state.project-state', joinTable: { name: 'projects_project_state_lnk' } },
      leader: { type: 'relation', target: 'plugin::users-permissions.user', joinTable: { name: 'projects_leader_lnk' } },
      project_phases: { type: 'relation', target: 'api::project-phase.project-phase', joinTable: { name: 'projects_project_phases_lnk' } },
      periodification: { type: 'relation', target: 'project.periodification', joinTable: { name: 'projects_cmps' } },
      logo: { type: 'relation', relation: 'morphOne', target: 'plugin::upload.file', morphBy: 'related' },
    },
  },
  'api::project-state.project-state': { tableName: 'project_states', attributes: {} },
  'plugin::users-permissions.user': { tableName: 'users-permissions_user', attributes: {} },
  'api::project-phase.project-phase': {
    tableName: 'project_phases',
    attributes: {
      incomes: { type: 'relation', target: 'api::phase-income.phase-income', joinTable: { name: 'phase_incomes_project_phase_lnk' } },
    },
  },
  'api::phase-income.phase-income': { tableName: 'phase_incomes', attributes: {} },
  'project.periodification': { tableName: 'components_project_periodifications', attributes: {} },
  'plugin::upload.file': { tableName: 'files', attributes: { related: { type: 'relation', joinTable: { name: 'files_related_mph' } } } },
};
const strapi = { db: { metadata: { get: (uid) => META[uid] } } };

describe('tables a query reads (issues/309)', () => {
  it('the entity, what is populated, nested, components and files', () => {
    const tables = queryTables(strapi, 'api::project.project', {
      project_state: true,
      project_phases: { populate: { incomes: true } },
      periodification: true,
      logo: true,
    });
    expect([...tables].sort()).toEqual([
      'components_project_periodifications',
      'files',
      'files_related_mph',
      'phase_incomes',
      'phase_incomes_project_phase_lnk',
      'project_phases',
      'project_states',
      'projects',
      'projects_cmps',
      'projects_project_phases_lnk',
      'projects_project_state_lnk',
    ]);
  });

  it('nothing that is not populated', () => {
    expect([...queryTables(strapi, 'api::project.project', null)]).toEqual(['projects']);
    expect([...queryTables(strapi, 'api::project.project', { project_state: true })].sort()).toEqual([
      'project_states',
      'projects',
      'projects_project_state_lnk',
    ]);
  });

  it("'*' populates every relation one level down", () => {
    const tables = queryTables(strapi, 'api::project.project', '*');
    expect(tables.has('users-permissions_user')).toBe(true);
    expect(tables.has('project_phases')).toBe(true);
    expect(tables.has('phase_incomes')).toBe(false);
  });

  it('an unknown uid gives nothing', () => {
    expect([...queryTables(strapi, 'api::nope.nope', true)]).toEqual([]);
    expect([...queryTables({}, 'api::project.project', true)]).toEqual([]);
  });
});
