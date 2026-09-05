'use strict';

const { adaptQuery } = require('../src/services/query-adapter');

describe('query-adapter (v3 → v5)', () => {
  describe('pagination: _limit / _start', () => {
    test('_limit:-1 → pagination.limit -1 (return-all)', () => {
      expect(adaptQuery({ _limit: '-1' }).pagination).toEqual({ limit: -1 });
    });
    test('_limit:25 → numeric', () => {
      expect(adaptQuery({ _limit: '25' }).pagination).toEqual({ limit: 25 });
    });
    test('_start offset', () => {
      expect(adaptQuery({ _start: '50' }).pagination).toEqual({ start: 50 });
    });
    test('no limit/start → no pagination key', () => {
      expect(adaptQuery({}).pagination).toBeUndefined();
    });
  });

  describe('sort: _sort', () => {
    test('field:DESC → [{ field: "desc" }]', () => {
      expect(adaptQuery({ _sort: 'id:DESC' }).sort).toEqual([{ id: 'desc' }]);
    });
    test('field:ASC', () => {
      expect(adaptQuery({ _sort: 'name:ASC' }).sort).toEqual([{ name: 'asc' }]);
    });
    test('bare field → asc', () => {
      expect(adaptQuery({ _sort: 'created_at' }).sort).toEqual([{ created_at: 'asc' }]);
    });
  });

  describe('bare field → eq', () => {
    test('field=value', () => {
      expect(adaptQuery({ project_state: '3' }).filters).toEqual({ project_state: 3 });
    });
    test('string value preserved', () => {
      expect(adaptQuery({ name: 'Test' }).filters).toEqual({ name: 'Test' });
    });
  });

  describe('flat operators', () => {
    test('_gte / _lte (date ranges)', () => {
      expect(adaptQuery({ created_at_gte: '2024-01-01', created_at_lte: '2024-12-31' }).filters).toEqual({
        created_at: { $gte: '2024-01-01', $lte: '2024-12-31' },
      });
    });
    test('_gt', () => {
      expect(adaptQuery({ structural_expenses_pct_gt: '0' }).filters).toEqual({
        structural_expenses_pct: { $gt: 0 },
      });
    });
    test('_null:true → $null', () => {
      expect(adaptQuery({ vat_paid_date_null: true }).filters).toEqual({
        vat_paid_date: { $null: true },
      });
    });
    test('_null:false → $notNull', () => {
      expect(adaptQuery({ owner_null: 'false' }).filters).toEqual({
        owner: { $notNull: true },
      });
    });
    test('_null:true from string "true"', () => {
      expect(adaptQuery({ last_status_check_null: 'true' }).filters).toEqual({
        last_status_check: { $null: true },
      });
    });
    test('_in comma-string → array', () => {
      expect(adaptQuery({ project_state_in: '1,2,3' }).filters).toEqual({
        project_state: { $in: [1, 2, 3] },
      });
    });
    test('_in array form', () => {
      expect(adaptQuery({ id_in: ['1', '2'] }).filters).toEqual({ id: { $in: [1, 2] } });
    });
    test('_ne', () => {
      expect(adaptQuery({ status_ne: 'draft' }).filters).toEqual({ status: { $ne: 'draft' } });
    });
  });

  describe('_where (nested form)', () => {
    test('_where.project_state_in', () => {
      const r = adaptQuery({ _where: { project_state_in: '1,2,3' } });
      expect(r.filters).toEqual({ project_state: { $in: [1, 2, 3] } });
    });
    test('_where.project_state_eq', () => {
      const r = adaptQuery({ _where: { project_state_eq: '5' } });
      expect(r.filters).toEqual({ project_state: 5 });
    });
    test('_where.year_eq scalar', () => {
      expect(adaptQuery({ _where: { year_eq: '2024' } }).filters).toEqual({ year: 2024 });
    });
    test('_where._or with _null and _lt (FACe cron shape)', () => {
      const thirtyMinAgo = '2024-01-01T00:00:00Z';
      const r = adaptQuery({
        _where: {
          _or: [{ last_status_check_null: true }, { last_status_check_lt: thirtyMinAgo }],
        },
      });
      expect(r.filters).toEqual({
        $or: [{ last_status_check: { $null: true } }, { last_status_check: { $lt: thirtyMinAgo } }],
      });
    });
    test('_where._and', () => {
      const r = adaptQuery({ _where: { _and: [{ a_eq: '1' }, { b_eq: '2' }] } });
      expect(r.filters).toEqual({ $and: [{ a: 1 }, { b: 2 }] });
    });
  });

  describe('dual form: flat + _where both accepted', () => {
    test('flat project_state_in works (v3 controllers read both)', () => {
      expect(adaptQuery({ project_state_in: '1,2,3' }).filters).toEqual({
        project_state: { $in: [1, 2, 3] },
      });
    });
  });

  // v3 kept the live/trashed state in `published_at` (null = trashed). Draft &
  // Publish is off on the five types that used it — v5's version renumbers a row
  // on every save — and v5 owns the `published_at` column, so the state lives in
  // a `trashed` boolean.
  describe('published_at_null', () => {
    test('published_at_null:false → not trashed', () => {
      expect(adaptQuery({ published_at_null: false }).filters.trashed).toBe(false);
      expect(adaptQuery({ published_at_null: false }).status).toBeUndefined();
    });
    test('published_at_null:true → trashed', () => {
      expect(adaptQuery({ published_at_null: true }).filters.trashed).toBe(true);
    });
  });

  describe('_q full-text', () => {
    test('_q exposed as q', () => {
      const r = adaptQuery({ _q: 'foo' });
      expect(r.q).toBe('foo');
    });
    test('_q with searchFields → $or of $contains', () => {
      const r = adaptQuery({ _q: 'foo' }, { searchFields: ['name', 'description'] });
      expect(r.filters.$or).toEqual([{ name: { $contains: 'foo' } }, { description: { $contains: 'foo' } }]);
    });
  });

  describe('populate (2nd positional arg in v3)', () => {
    test('populate array passed through', () => {
      const pop = ['leader', 'project_state', 'project_phases.incomes'];
      expect(adaptQuery({}, { populate: pop }).populate).toBe(pop);
    });
    test('empty array populate stays empty (NOT *)', () => {
      expect(adaptQuery({}, { populate: [] }).populate).toEqual([]);
    });
    test('no populate passed → undefined', () => {
      expect(adaptQuery({}).populate).toBeUndefined();
    });
  });

  describe('combined real-world queries', () => {
    test('project findWithBasicInfo shape', () => {
      const r = adaptQuery({
        published_at_null: false,
        project_state_in: '1,2,3',
        structural_expenses_pct_gt: '0',
        _limit: '-1',
      });
      expect(r.filters.trashed).toBe(false);
      expect(r.pagination).toEqual({ limit: -1 });
      expect(r.filters).toEqual({
        trashed: false,
        project_state: { $in: [1, 2, 3] },
        structural_expenses_pct: { $gt: 0 },
      });
    });

    test('incidences.infoAll shape (year range + sort)', () => {
      const r = adaptQuery({
        year: '2024',
        created_at_gte: '2024-01-01',
        created_at_lte: '2024-12-31',
        _limit: '-1',
        _sort: 'id:DESC',
      });
      expect(r.pagination).toEqual({ limit: -1 });
      expect(r.sort).toEqual([{ id: 'desc' }]);
      expect(r.filters).toEqual({
        year: 2024,
        created_at: { $gte: '2024-01-01', $lte: '2024-12-31' },
      });
    });

    test('contacts withorders shape (_limit -1 + date range + populate)', () => {
      const r = adaptQuery(
        { _limit: '-1', estimated_delivery_date_gte: '2024-06-01' },
        { populate: ['contact'] },
      );
      expect(r.pagination).toEqual({ limit: -1 });
      expect(r.populate).toEqual(['contact']);
      expect(r.filters).toEqual({ estimated_delivery_date: { $gte: '2024-06-01' } });
    });
  });

  describe('edge cases', () => {
    test('empty query', () => {
      const r = adaptQuery({});
      expect(r.filters).toEqual({});
      expect(r.pagination).toBeUndefined();
      expect(r.sort).toBeUndefined();
    });
    test('null/undefined query', () => {
      expect(adaptQuery(null).filters).toEqual({});
      expect(adaptQuery(undefined).filters).toEqual({});
    });
    test('float coercion', () => {
      expect(adaptQuery({ amount_gt: '1.5' }).filters).toEqual({ amount: { $gt: 1.5 } });
    });
    test('_eq produces scalar form (v5 accepts field: value as $eq)', () => {
      expect(adaptQuery({ name_eq: 'hello' }).filters).toEqual({ name: 'hello' });
    });
  });
});

describe('adaptCtxQuery (v3 REST compatibility for core find)', () => {
  const { adaptCtxQuery } = require('../src/services/query-adapter');

  const mkCtx = (query) => ({ query });

  test('translates v3 list params into v5 REST params', () => {
    const ctx = mkCtx({ _limit: '-1', _sort: 'name:ASC', mother: '5' });
    adaptCtxQuery(ctx);
    expect(ctx.query).toEqual({
      filters: { mother: 5 },
      sort: ['name:asc'],
      pagination: { limit: -1 },
    });
  });

  test('translates _where and published_at_null', () => {
    const ctx = mkCtx({ _where: { 'multidelivery_eq': 'true' }, published_at_null: 'false' });
    adaptCtxQuery(ctx);
    expect(ctx.query.filters).toEqual({
      multidelivery: true,
      trashed: false,
    });
  });

  test('leaves v5-native queries untouched', () => {
    const query = { filters: { name: { $contains: 'x' } }, 'sort': ['id:desc'], pagination: { limit: 10 } };
    const ctx = mkCtx({ ...query });
    adaptCtxQuery(ctx);
    expect(ctx.query).toEqual(query);
  });

  test('leaves empty queries untouched', () => {
    const ctx = mkCtx({});
    adaptCtxQuery(ctx);
    expect(ctx.query).toEqual({});
  });

  // The v3-compat middleware defaults `populate` to '*' (v3 populated the first
  // relation level by default). Translating the v3 params must not drop it, and
  // it must never be mistaken for a v3 field filter.
  test('carries v5-native params through a v3 translation', () => {
    const ctx = mkCtx({ populate: '*', _limit: '10', mother: '5' });
    adaptCtxQuery(ctx);
    expect(ctx.query).toEqual({
      populate: '*',
      filters: { mother: 5 },
      pagination: { limit: 10 },
    });
  });

  test('an explicit caller populate wins over the query one', () => {
    const ctx = mkCtx({ populate: '*', _limit: '10' });
    adaptCtxQuery(ctx, { populate: ['contact'] });
    expect(ctx.query.populate).toEqual(['contact']);
  });

  test('v5-native params are not turned into filters', () => {
    const ctx = mkCtx({ populate: '*', fields: ['id'], status: 'published', _sort: 'id:DESC' });
    adaptCtxQuery(ctx);
    expect(ctx.query.filters).toBeUndefined();
    expect(ctx.query.fields).toEqual(['id']);
  });
});

describe('dbLimit / expandPopulate / v3FindArgs (db.query bridge)', () => {
  const { adaptQuery, dbLimit, expandPopulate, v3FindArgs } = require('../src/services/query-adapter');

  // knex emits `LIMIT -1` for a negative limit and MySQL rejects it; omitting
  // the limit is how db.query says "all rows".
  test('_limit=-1 becomes no limit for db.query', () => {
    expect(dbLimit(adaptQuery({ _limit: '-1' }))).toBeUndefined();
  });
  test('a real limit passes through', () => {
    expect(dbLimit(adaptQuery({ _limit: '25' }))).toBe(25);
  });
  test('no _limit means no limit', () => {
    expect(dbLimit(adaptQuery({}))).toBeUndefined();
    expect(dbLimit(undefined)).toBeUndefined();
  });
  // the REST path still needs the -1 (config/api.js maxLimit handles it)
  test('the REST adapter keeps -1', () => {
    expect(adaptQuery({ _limit: '-1' }).pagination).toEqual({ limit: -1 });
  });

  test('dotted v3 populate paths expand to nested v5 populate', () => {
    expect(expandPopulate(['leader', 'phases', 'phases.incomes', 'phases.incomes.income_type']))
      .toEqual({
        leader: true,
        phases: { populate: { incomes: { populate: { income_type: true } } } },
      });
  });
  test('a deeper path already seen is not flattened back to true', () => {
    expect(expandPopulate(['a.b', 'a'])).toEqual({ a: { populate: { b: true } } });
  });
  test('empty populate is omitted', () => {
    expect(expandPopulate([])).toBeUndefined();
    expect(expandPopulate(undefined)).toBeUndefined();
  });

  test('v3FindArgs builds db.query findMany args', () => {
    expect(v3FindArgs({ _limit: '-1', _sort: 'name:ASC', mother: '5' }, ['leader']))
      .toEqual({ where: { mother: 5 }, populate: { leader: true }, orderBy: [{ name: 'asc' }] });
  });
  test('v3FindArgs maps published_at_null=false onto trashed', () => {
    expect(v3FindArgs({ published_at_null: 'false' }).where).toEqual({ trashed: false });
  });
  test('v3FindArgs carries _start as offset', () => {
    expect(v3FindArgs({ _start: '20', _limit: '10' })).toEqual({ where: {}, limit: 10, offset: 20 });
  });
});

describe('relationId (lifecycle relation payloads)', () => {
  const { relationId } = require('../src/services/relation-input');

  // What a v5 db lifecycle actually receives after the Document Service has
  // normalised the input — ported v3 code read `.id` off this and fed the
  // operation object into a where clause.
  test('v5 relation operations', () => {
    expect(relationId({ set: [{ id: 5 }] })).toBe(5);
    expect(relationId({ connect: [{ id: 7 }] })).toBe(7);
    expect(relationId({ set: [] })).toBeUndefined();
  });

  test('the v3 shapes still work', () => {
    expect(relationId(5)).toBe(5);
    expect(relationId('5')).toBe(5);
    expect(relationId({ id: 5 })).toBe(5);
    expect(relationId([{ id: 5 }])).toBe(5);
  });

  test('absent or cleared relations', () => {
    expect(relationId(null)).toBeUndefined();
    expect(relationId(undefined)).toBeUndefined();
    expect(relationId({})).toBeUndefined();
  });
});
