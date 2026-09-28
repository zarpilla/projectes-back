'use strict';

/**
 * `GET /api/city-routes?_limit=-1` took 3-5s in production for ~900 rows.
 *
 * It is the core route, so the v3-compat middleware gives it populate='*' and
 * the content API sanitises every field of every row. Measured locally: 35ms
 * of query, 124ms of sanitisation, 0.479 MB — and the VPS runs 16 Strapi
 * instances on shared CPU, which is why it is far worse there.
 *
 * All four callers — CityRoute, ContactsTable, OrdersTable, OrdersForm — read
 * only the row id, the city id, and the route's id and name. The lean handler
 * returns 6ms and 0.049 MB.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const { BASIC_SELECT, BASIC_POPULATE } = require('../src/api/city-route/services/basic-shape');

const attrs = JSON.parse(
  read('api', 'city-route', 'content-types', 'city-route', 'schema.json')
).attributes;

describe('city-route basic shape', () => {
  it('selects the row id', () => {
    expect(BASIC_SELECT).toContain('id');
  });

  it('populates exactly the two relations the entity has', () => {
    const relations = Object.entries(attrs)
      .filter(([, a]) => a.type === 'relation')
      .map(([n]) => n);
    expect(relations.sort()).toEqual(['city', 'route']);
    expect(Object.keys(BASIC_POPULATE).sort()).toEqual(['city', 'route']);
  });

  it('narrows city to its id', () => {
    expect(BASIC_POPULATE.city).toEqual({ select: ['id'] });
  });

  it('populates the route whole, not a narrowed select', () => {
    // Narrowing it to id+name emptied the "Ruta" picker: OrdersForm filters on
    // `cr.route.active`, and checkTransferNeeded reads `transfer_pickup` off
    // the same objects. A select drops both silently.
    expect(BASIC_POPULATE.route).toBe(true);
  });

  it('selects nothing that is not an attribute', () => {
    for (const f of BASIC_SELECT) {
      if (f === 'id') continue;
      expect(attrs[f]).toBeDefined();
    }
  });
});

describe('wiring', () => {
  it('the route exists and points at the handler', () => {
    const routes = read('api', 'city-route', 'routes', '01-custom-city-route.js');
    expect(routes).toContain("path: '/city-routes/basic'");
    expect(routes).toContain("handler: 'city-route.basic'");
  });

  it('the route file sorts before the core one, or /:id would shadow it', () => {
    const dir = fs.readdirSync(path.join(SRC, 'api', 'city-route', 'routes')).sort();
    expect(dir.indexOf('01-custom-city-route.js')).toBeLessThan(dir.indexOf('city-route.js'));
  });

  it('the handler uses the shared shape rather than its own copy', () => {
    const controller = read('api', 'city-route', 'controllers', 'city-route.js');
    expect(controller).toContain('async basic()');
    expect(controller).toContain('select: BASIC_SELECT');
    expect(controller).toContain('populate: BASIC_POPULATE');
  });

  it('authenticated users are granted it — an ungranted custom route 403s', () => {
    expect(read('services', 'bootstrap-permissions.js')).toMatch(
      /'city-route': \[[^\]]*'basic'/
    );
  });
});
