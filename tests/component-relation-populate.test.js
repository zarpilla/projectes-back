'use strict';

/**
 * Populating a component does not populate the relations inside it.
 *
 * `grantable_years` is a repeatable component whose entries each hold a `year`
 * relation. Asking for `'grantable_years'` returns the component with its
 * amounts but no `year` key at all — the relation is simply absent, exactly as
 * an unpopulated relation is on a content type. ProjectGrantableYears binds
 * `<b-select :value="getYearId(yearData)">` against options keyed by year id,
 * so the "Imports per any" dropdown rendered blank while the list behind it was
 * fully populated.
 *
 * The fix is to name the nested path, `'grantable_years.year'`. These
 * assertions pin that for the three project populate lists and check the
 * expansion produces the nested shape the ORM expects.
 */

const fs = require('fs');
const path = require('path');
const { expandPopulate } = require('../src/services/query-adapter');

const SRC = path.join(__dirname, '..', 'src');

/** The component attributes of a content type that themselves hold relations. */
function componentsHoldingRelations() {
  const NON_SCALAR = ['relation', 'component', 'media'];
  const byUid = {};
  const componentsDir = path.join(SRC, 'components');
  for (const group of fs.readdirSync(componentsDir)) {
    for (const file of fs.readdirSync(path.join(componentsDir, group))) {
      if (!file.endsWith('.json')) continue;
      const schema = JSON.parse(fs.readFileSync(path.join(componentsDir, group, file), 'utf8'));
      const relations = Object.entries(schema.attributes || {})
        .filter(([, def]) => def && NON_SCALAR.includes(def.type))
        .map(([name]) => name);
      if (relations.length) byUid[`${group}.${file.replace('.json', '')}`] = relations;
    }
  }
  return byUid;
}

describe('grantable components', () => {
  const projectAttrs = JSON.parse(
    fs.readFileSync(path.join(SRC, 'api', 'project', 'content-types', 'project', 'schema.json'), 'utf8'),
  ).attributes;
  const componentRelations = componentsHoldingRelations();

  it('really do hold the relations these assertions are about', () => {
    expect(componentRelations[projectAttrs.grantable_years.component]).toContain('year');
    expect(componentRelations[projectAttrs.grantable_contacts.component]).toContain('contact');
  });

  it('are populated with their nested relation in every project populate list', () => {
    const source = fs.readFileSync(
      path.join(SRC, 'api', 'project', 'controllers', 'project.js'),
      'utf8',
    );
    // Three lists: findOne, findOneExtended and the economic detail read.
    expect((source.match(/'grantable_years\.year'/g) || []).length).toBe(3);
    expect((source.match(/'grantable_contacts\.contact'/g) || []).length).toBe(3);
    // And never the bare form, which is what returned a component with no year.
    expect(source).not.toMatch(/'grantable_years',/);
    expect(source).not.toMatch(/'grantable_contacts',/);
  });
});

describe('expandPopulate over component paths', () => {
  it('nests the relation under the component', () => {
    expect(expandPopulate(['grantable_years.year', 'grantable_contacts.contact'])).toEqual({
      grantable_years: { populate: { year: true } },
      grantable_contacts: { populate: { contact: true } },
    });
  });

  it('leaves a component with no relations as a plain true', () => {
    expect(expandPopulate(['periodification'])).toEqual({ periodification: true });
  });

  it('merges a bare entry with a deeper one instead of overwriting it', () => {
    // Order must not decide whether the nested populate survives.
    expect(expandPopulate(['grantable_years', 'grantable_years.year'])).toEqual({
      grantable_years: { populate: { year: true } },
    });
    expect(expandPopulate(['grantable_years.year', 'grantable_years'])).toEqual({
      grantable_years: { populate: { year: true } },
    });
  });
});
