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
  cleanPayload(data, strapi.contentTypes['api::project.project'].attributes, strapi, true, 0, true);
// the same payload for a content type whose controller does NOT consume markers
const cleanNoMarkers = (data) =>
  cleanPayload(data, strapi.contentTypes['api::project.project'].attributes, strapi, true, 0, false);

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

describe('"not set" relation placeholders', () => {
  const { isEmptyRelationRef } = _internal;

  // ProjectForm initialises every to-one select as `{ id: 0 }`. v3 stored that
  // as NULL; v5 answers "1 relation(s) of type … do not exist".
  test('recognises the placeholders', () => {
    expect(isEmptyRelationRef({ id: 0 })).toBe(true);
    expect(isEmptyRelationRef({ id: '0' })).toBe(true);
    expect(isEmptyRelationRef(0)).toBe(true);
    expect(isEmptyRelationRef('')).toBe(true);
    expect(isEmptyRelationRef(null)).toBe(true);
  });

  test('an empty object is unset too (the gantt\'s unassigned person)', () => {
    expect(isEmptyRelationRef({})).toBe(true);
  });

  test('leaves real references alone', () => {
    expect(isEmptyRelationRef({ id: 20 })).toBe(false);
    expect(isEmptyRelationRef({ id: '20' })).toBe(false);
    expect(isEmptyRelationRef(20)).toBe(false);
    expect(isEmptyRelationRef({ documentId: 'abc' })).toBe(false);
    // a nested entity being created has no id yet
    expect(isEmptyRelationRef({ name: 'new phase' })).toBe(false);
  });

  test('a to-one placeholder becomes null, a to-many entry is dropped', () => {
    expect(clean({ leader: { id: 0 }, project_phases: [{ id: 0 }, { id: 20, name: 'x' }] })).toEqual({
      leader: null,
      project_phases: [{ id: 20, name: 'x' }],
    });
  });
});

describe('v3 control fields', () => {
  // "GESTIÓ ECONÒMICA" ships the edited phases plus the removed rows, flagged
  // with fields that are not model attributes. Dropping them as "unknown"
  // silently discarded every economic edit on a project.
  test('the phase-edit flags and info survive at the root', () => {
    const body = {
      name: 'x',
      _project_phases_updated: true,
      project_phases_info: { deletedPhases: [1], deletedIncomes: [2], deletedExpenses: [], deletedHours: [] },
      _project_original_phases_updated: true,
      project_original_phases_info: { deletedPhases: [] },
    };
    const out = clean(body);
    expect(out._project_phases_updated).toBe(true);
    expect(out.project_phases_info).toEqual(body.project_phases_info);
    expect(out._project_original_phases_updated).toBe(true);
    expect(out.project_original_phases_info).toEqual({ deletedPhases: [] });
  });

  test('any underscore-prefixed control field survives (e.g. _internal)', () => {
    expect(clean({ name: 'x', _internal: true })._internal).toBe(true);
  });

  test('control fields are root-only — nested payloads stay clean', () => {
    expect(
      clean({ leader: { id: 20, _internal: true, project_phases_info: {} } }),
    ).toEqual({ leader: { id: 20 } });
  });

  test('genuinely unknown root keys are still dropped', () => {
    expect(clean({ name: 'x', allByYear: [] })).toEqual({ name: 'x' });
  });
});

describe('nested row markers', () => {
  // `updatePhases` only writes a phase / income / expense back when the
  // frontend marked it `dirty`, and `dirty` is not a schema attribute on any of
  // them — so dropping it made every edit to an existing "GESTIÓ ECONÒMICA" row
  // a silent no-op.
  test('dirty survives inside a nested row', () => {
    expect(
      clean({
        project_phases: [
          { id: 20, name: 'x', dirty: true, expenses: [{ id: 5, concept: 'a', dirty: true }] },
        ],
      }),
    ).toEqual({
      project_phases: [
        { id: 20, name: 'x', dirty: true, expenses: [{ id: 5, concept: 'a', dirty: true }] },
      ],
    });
  });

  // Markers are only kept for the content type whose controller strips them
  // again (project). Anywhere else they reach v5's input validation and 400.
  test('markers are dropped for content types that do not consume them', () => {
    expect(cleanNoMarkers({ project_phases: [{ id: 20, name: 'x', dirty: true }] }))
      .toEqual({ project_phases: [{ id: 20, name: 'x' }] });
  });

  test('other client-only fields are still dropped from nested rows', () => {
    expect(clean({ project_phases: [{ id: 20, name: 'x', assign: false, total_expenses_vat: 9 }] }))
      .toEqual({ project_phases: [{ id: 20, name: 'x' }] });
  });
});
