'use strict';

/**
 * The frontend edits the entity it just fetched and PUTs the whole graph back.
 * v5 rejects any key that is not a schema attribute — at EVERY level, not just
 * the root ("Invalid key created_at at leader", "Invalid key
 * total_expenses_vat at project_phases.expenses") — where v3 ignored them.
 */
const { _internal } = require('../src/middlewares/v3-compat');
const { cleanPayload } = _internal;

// a miniature registry shaped like strapi.contentTypes / strapi.components
const strapi = {
  contentTypes: {
    'api::project.project': {
      attributes: {
        name: { type: 'string' },
        leader: { type: 'relation', target: 'plugin::users-permissions.user' },
        project_phases: { type: 'relation', target: 'api::project-phase.project-phase' },
        periodification: { type: 'component', component: 'periodification.periodification' },
        trashed: { type: 'boolean' },
      },
    },
    'plugin::users-permissions.user': {
      attributes: { username: { type: 'string' }, email: { type: 'email' } },
    },
    'api::project-phase.project-phase': {
      attributes: {
        name: { type: 'string' },
        expenses: { type: 'relation', target: 'api::phase-expense.phase-expense' },
      },
    },
    'api::phase-expense.phase-expense': {
      attributes: { concept: { type: 'string' }, amount: { type: 'decimal' } },
    },
  },
  components: {
    'periodification.periodification': { attributes: { year: { type: 'integer' } } },
  },
};

const clean = (data) =>
  cleanPayload(data, strapi.contentTypes['api::project.project'].attributes, strapi, true, 0);

describe('write-body sanitizer', () => {
  test('drops row identity and managed timestamps at the root', () => {
    expect(
      clean({
        id: 25,
        documentId: 'abc',
        createdAt: 'x',
        updatedAt: 'x',
        publishedAt: 'x',
        locale: null,
        name: 'Logística',
      }),
    ).toEqual({ name: 'Logística' });
  });

  test('drops server-computed fields the form echoes back', () => {
    // `allByYear` is added by the project controller, not a schema attribute
    expect(clean({ name: 'x', allByYear: [1, 2], balance: 35004.2 })).toEqual({ name: 'x' });
  });

  test('keeps id inside a relation payload but drops its timestamps', () => {
    expect(
      clean({ leader: { id: 20, username: 'Carla', createdAt: 'x', created_at: 'x', locale: null } }),
    ).toEqual({ leader: { id: 20, username: 'Carla' } });
  });

  test('cleans arrays and nested relations all the way down', () => {
    expect(
      clean({
        project_phases: [
          {
            id: 20,
            name: '1T 2026',
            publishedAt: null,
            expenses: [
              { id: 5, concept: 'a', amount: 1, total_expenses_vat: 99, updatedAt: 'x' },
            ],
          },
        ],
      }),
    ).toEqual({
      project_phases: [
        { id: 20, name: '1T 2026', expenses: [{ id: 5, concept: 'a', amount: 1 }] },
      ],
    });
  });

  test('cleans components too', () => {
    expect(clean({ periodification: { id: 3, year: 2026, createdAt: 'x' } })).toEqual({
      periodification: { id: 3, year: 2026 },
    });
  });

  test('null relations and scalars pass through', () => {
    expect(clean({ leader: null, name: 'x', trashed: false })).toEqual({
      leader: null,
      name: 'x',
      trashed: false,
    });
  });
});
