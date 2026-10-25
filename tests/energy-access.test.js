'use strict';

/**
 * Comunitat energètica (2026-10-25): the `admin_energy` permission reaches the
 * members, CUPS, installations and coefficients only through /api/energy/*,
 * plus the upload of the members' documents; no other contact, no projects.
 * The members' documents and dates are dropped for everyone else without full
 * access.
 */
const { isAllowed } = require('../src/services/app-access-rules');
const { rulesFor, sanitizeResponse } = require('../src/services/response-sanitizer');
const routes = require('../src/api/energy/routes/energy');

describe('admin_energy permission', () => {
  test('every /energy route is allowed to admin_energy and full access only', () => {
    for (const route of routes.routes) {
      const action = `api::energy.${route.handler}`;
      expect(isAllowed(action, ['admin_energy'])).toBe(true);
      expect(isAllowed(action, ['projects'])).toBe(true);
      expect(isAllowed(action, ['admin'])).toBe(true);
      expect(isAllowed(action, ['orders_admin'])).toBe(false);
      expect(isAllowed(action, ['hours'])).toBe(false);
      expect(isAllowed(action, [])).toBe(false);
    }
  });

  test('admin_energy uploads documents but reaches no other contact nor projects', () => {
    expect(isAllowed('plugin::upload.content-api.upload', ['admin_energy'])).toBe(true);
    expect(isAllowed('api::contact.contact.find', ['admin_energy'])).toBe(false);
    expect(isAllowed('api::contact.contact.update', ['admin_energy'])).toBe(false);
    expect(isAllowed('api::project.project.find', ['admin_energy'])).toBe(false);
    // what every page reads after login
    expect(isAllowed('plugin::users-permissions.user.me', ['admin_energy'])).toBe(true);
    expect(isAllowed('api::me.me.find', ['admin_energy'])).toBe(true);
  });

  test('the members’ documents are dropped for the logistics staff', () => {
    const strapi = {
      contentTypes: {
        'api::contact.contact': {
          attributes: { name: { type: 'string' }, documents: { type: 'media' }, join_date: { type: 'date' } },
        },
      },
    };
    const contact = () => ({
      id: 1,
      name: 'A',
      documents: [{ id: 5 }],
      join_date: '2024-04-27',
      privacy_accepted: true,
    });

    const office = contact();
    sanitizeResponse(strapi, 'api::contact.contact', office, rulesFor({ permissions: ['orders_admin'] }));
    expect(office).toEqual({ id: 1, name: 'A' });

    const energy = contact();
    sanitizeResponse(strapi, 'api::contact.contact', energy, rulesFor({ permissions: ['admin_energy'] }));
    expect(energy).toEqual(contact());

    // a logistics member keeps losing the office's fields too
    const member = { ...contact(), partner_amount: 100 };
    sanitizeResponse(
      strapi,
      'api::contact.contact',
      member,
      rulesFor({ member: true, permissions: ['orders'] }),
    );
    expect(member).toEqual({ id: 1, name: 'A' });
  });
});
