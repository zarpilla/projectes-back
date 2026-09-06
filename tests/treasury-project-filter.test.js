'use strict';

/**
 * Guards the /vat (treasury forecast) project filter.
 *
 * The whole page came back empty in v5 — 0 projects, 0 VAT documents, every
 * quarter blank — with no error in any log. Cause: `project_state` was a v3 FK
 * column (a plain integer, always present on the row) and is a v5 relation,
 * which the ORM omits unless populated. `[1,2,3].includes(undefined)` is false,
 * so every project was filtered out, which then emptied every document list
 * downstream via `allowedProjectIds`.
 *
 * Two halves, and both matter: the comparison must accept the v5 object shape,
 * and the controller must actually populate the relations it compares.
 */

const fs = require('fs');
const path = require('path');
const {
  FILTER_RELATIONS,
  filterProjects,
  parseIdList,
  relationId,
} = require('../src/api/treasury/services/project-filter');

const project = (id, extra = {}) => ({ id, ...extra });
const ids = (rows) => rows.map((p) => p.id);

describe('relationId', () => {
  it('reads the id out of a populated v5 relation', () => {
    expect(relationId({ id: 7, name: 'Aprovat' })).toBe(7);
  });

  it('passes a v3 FK id through untouched', () => {
    expect(relationId(3)).toBe(3);
    expect(relationId(null)).toBe(null);
    expect(relationId(undefined)).toBe(undefined);
  });
});

describe('parseIdList', () => {
  it('treats an absent param as "no filter"', () => {
    expect(parseIdList(undefined)).toBe(null);
    expect(parseIdList(null)).toBe(null);
  });

  it('treats an empty param as "match nothing"', () => {
    expect(parseIdList('')).toEqual([]);
  });

  it('parses ids and the "null" (Sense) token', () => {
    expect(parseIdList('1,null,3')).toEqual([1, null, 3]);
  });
});

describe('filterProjects', () => {
  it('matches on a populated v5 relation object — the /vat regression', () => {
    const projects = [
      project(1, { project_state: { id: 2, name: 'Aprovat' } }),
      project(2, { project_state: { id: 9, name: 'Arxivat' } }),
    ];
    expect(ids(filterProjects(projects, { states: [1, 2, 3] }))).toEqual([1]);
  });

  it('still matches on a bare v3 FK id', () => {
    const projects = [project(1, { project_state: 2 }), project(2, { project_state: 9 })];
    expect(ids(filterProjects(projects, { states: [1, 2, 3] }))).toEqual([1]);
  });

  it('keeps every project when a filter is not sent', () => {
    const projects = [project(1, { project_state: { id: 9 } }), project(2, {})];
    expect(ids(filterProjects(projects, {}))).toEqual([1, 2]);
  });

  it('keeps nothing when a filter is sent empty (all deselected)', () => {
    const projects = [project(1, { project_state: { id: 2 } })];
    expect(filterProjects(projects, { states: [] })).toEqual([]);
  });

  it('puts an unset type/likelihood in the null ("Sense") bucket', () => {
    const projects = [
      project(1, { project_type: null }),
      project(2, { project_type: { id: 5 } }),
    ];
    expect(ids(filterProjects(projects, { types: [null] }))).toEqual([1]);
  });

  it('buckets the legacy 0 sentinel with the unset values', () => {
    // Dirty v3 data stores 0 instead of NULL for type/likelihood.
    const projects = [project(1, { project_likelihood: 0 })];
    expect(ids(filterProjects(projects, { likelihoods: [null] }))).toEqual([1]);
  });

  it('applies all three filters together', () => {
    const projects = [
      project(1, { project_state: { id: 1 }, project_type: { id: 4 }, project_likelihood: { id: 8 } }),
      project(2, { project_state: { id: 1 }, project_type: { id: 5 }, project_likelihood: { id: 8 } }),
    ];
    const kept = filterProjects(projects, { states: [1], types: [4], likelihoods: [8] });
    expect(ids(kept)).toEqual([1]);
  });
});

describe('treasury forecast controller', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api', 'treasury', 'controllers', 'treasury.js'),
    'utf8',
  );

  it('populates every relation the filter dereferences', () => {
    // Populating from FILTER_RELATIONS is what keeps the two in step; if the
    // controller ever spells the populate out by hand again, this fails.
    expect(source).toContain('FILTER_RELATIONS.map((r) => [r, true])');
  });

  it('delegates the filtering instead of comparing raw relation values', () => {
    expect(source).toContain('filterProjects(allProjects');
    expect(source).not.toMatch(/includes\(\s*p\.project_state\s*\)/);
  });
});
