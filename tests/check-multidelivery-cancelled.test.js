'use strict';

/**
 * issues/235 (review 7, 2026-10-19): the order form of a NEW order previewed
 * «Descompte multientrega −20 %» when the only other order of that point and
 * day was cancelled (24898); the save then stored 0 % (24899). With no id,
 * check-multidelivery counted every order of the day, cancelled included,
 * unlike the edit branch and the lifecycles.
 */

const path = require('path');

describe('check-multidelivery for a new order (issues/235)', () => {
  let orders;
  function load() {
    jest.resetModules();
    const ct = {
      uid: 'api::order.order',
      modelName: 'order',
      apiName: 'order',
      kind: 'collectionType',
      attributes: {},
    };
    global.strapi = {
      contentType: () => ct,
      contentTypes: { [ct.uid]: ct },
      log: { warn: () => {}, info: () => {} },
      documents: () => ({ findFirst: async () => ({ orders_options: { multidelivery_discount: 20 } }) }),
      db: {
        query: (uid) => ({
          findOne: async () => null,
          findMany: async () => (uid === 'api::order.order' ? orders : []),
        }),
      },
    };
    return require(path.join(__dirname, '..', 'src', 'api', 'order', 'controllers', 'order.js'))({
      strapi: global.strapi,
    });
  }
  const body = { date: '2026-10-21T22:00:00.000Z', contactId: 9, ownerId: 5 };
  afterEach(() => {
    delete global.strapi;
  });

  it('a cancelled order of the same point and day gives no discount', async () => {
    orders = [{ id: 24898, status: 'cancelled' }];
    const res = await load().checkMultidelivery({ request: { body } });
    expect(res.multidelivery_discount).toBe(0);
  });

  it('an active one still does', async () => {
    orders = [
      { id: 24898, status: 'cancelled' },
      { id: 24900, status: 'pending' },
    ];
    const res = await load().checkMultidelivery({ request: { body } });
    expect(res.multidelivery_discount).toBe(20);
  });
});
