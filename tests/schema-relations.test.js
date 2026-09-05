'use strict';

/**
 * Guards the relation declarations across every content type.
 *
 * A v5 relation needs exactly one owning side: the owner declares `inversedBy`
 * and gets the `<table>_<attr>_lnk` join table, the other declares `mappedBy`.
 * Get this wrong and there is no error anywhere — the join table is simply never
 * created, the ETL silently skips it (it fills whatever tables exist), and every
 * populate of that relation returns null. That is what emptied `user.role`
 * (401 on every authenticated request) and `project.project_phases` (the project
 * detail page), among 22 relations in total.
 */

const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, '..', 'src', 'api');
const USER_SCHEMA = path.join(
  __dirname, '..', 'src', 'extensions', 'users-permissions', 'content-types', 'user', 'schema.json',
);

function loadSchemas() {
  const schemas = new Map();
  for (const api of fs.readdirSync(API_DIR)) {
    const ctDir = path.join(API_DIR, api, 'content-types');
    if (!fs.existsSync(ctDir)) continue;
    for (const ct of fs.readdirSync(ctDir)) {
      const file = path.join(ctDir, ct, 'schema.json');
      if (!fs.existsSync(file)) continue;
      schemas.set(`api::${api}.${ct}`, JSON.parse(fs.readFileSync(file, 'utf8')).attributes || {});
    }
  }
  schemas.set(
    'plugin::users-permissions.user',
    JSON.parse(fs.readFileSync(USER_SCHEMA, 'utf8')).attributes || {},
  );
  return schemas;
}

describe('content-type relations', () => {
  const schemas = loadSchemas();

  test('every two-sided relation has exactly one owning side', () => {
    const problems = [];
    for (const [uid, attrs] of schemas) {
      for (const [name, attr] of Object.entries(attrs)) {
        if (attr.type !== 'relation' || !attr.target) continue;
        const back = attr.mappedBy || attr.inversedBy;
        if (!back) continue; // unidirectional by design
        const target = schemas.get(attr.target);
        if (!target) continue; // plugin type this test does not load (e.g. the role)

        const counter = target[back];
        if (!counter) {
          problems.push(`${uid}.${name}: ${attr.target}.${back} does not exist`);
          continue;
        }
        const counterBack = counter.mappedBy || counter.inversedBy;
        if (counterBack !== name) {
          problems.push(
            `${uid}.${name}: ${attr.target}.${back} points back at '${counterBack}', not '${name}'`,
          );
          continue;
        }
        if (attr.mappedBy && counter.mappedBy) {
          problems.push(`${uid}.${name}: both sides declare mappedBy — no join table is created`);
        }
        if (attr.inversedBy && counter.inversedBy) {
          problems.push(`${uid}.${name}: both sides declare inversedBy`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('the users-permissions user owns its role relation', () => {
    // mappedBy here leaves users role-less, and the auth strategy reads
    // user.role.id — so every authenticated request 401s.
    const role = schemas.get('plugin::users-permissions.user').role;
    expect(role.relation).toBe('manyToOne');
    expect(role.inversedBy).toBe('users');
    expect(role.mappedBy).toBeUndefined();
  });
});
