'use strict';

/**
 * issues/367 (2026-10-30): Inici greeted La Dotzena (a Diligència member) with
 * «Bon dia, La». Users get an optional `display_name`, the name Inici greets
 * with. Guards the field on the user and that a member, who reads the other
 * users through a narrow list of fields, gets it next to the full name.
 */
const schema = require('../src/extensions/users-permissions/content-types/user/schema.json');
const { rulesFor, sanitizeResponse } = require('../src/services/response-sanitizer');

const USER = 'plugin::users-permissions.user';

describe('user display_name (issues/367)', () => {
  test('the user has an optional display_name string', () => {
    expect(schema.attributes.display_name).toEqual({ type: 'string' });
  });

  test('a member reads the other users’ display_name, not their private fields', () => {
    const strapi = {
      contentTypes: {
        [USER]: {
          attributes: {
            username: { type: 'string' },
            fullname: { type: 'string' },
            display_name: { type: 'string' },
            email: { type: 'string' },
          },
        },
      },
    };
    const other = { id: 2, username: 'ladotzena', fullname: 'La Dotzena', display_name: 'La Dotzena', email: 'a@b.c' };
    sanitizeResponse(strapi, USER, other, rulesFor({ member: true, selfId: 1, permissions: ['orders'] }));
    expect(other).toEqual({ id: 2, username: 'ladotzena', fullname: 'La Dotzena', display_name: 'La Dotzena' });
  });
});
