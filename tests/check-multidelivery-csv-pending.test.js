'use strict';

/**
 * issues/298 (review 9, 2026-10-20): the CSV import preview showed each row
 * without the discounts the save applies (20,15 € shown, 16,12 € saved): two
 * rows to the same point and day get the multidelivery discount once both are
 * saved, and enough rows on a route the volume discount. check-multidelivery
 * now takes the rows not saved yet (pendingSameContact, pendingSameRoute), so
 * the preview asks the same rules the lifecycles apply.
 */

const path = require('path');

describe('check-multidelivery with unsaved CSV rows (issues/298)', () => {
  let orders;
  function load() {
    jest.resetModules();
    const ct = { uid: 'api::order.order', modelName: 'order', apiName: 'order', kind: 'collectionType', attributes: {} };
    global.strapi = {
      contentType: () => ct,
      contentTypes: { [ct.uid]: ct },
      log: { warn: () => {}, info: () => {} },
      documents: () => ({ findFirst: async () => ({ orders_options: { multidelivery_discount: 20 } }) }),
      db: {
        query: (uid) => ({
          findOne: async () =>
            uid === 'api::route.route' ? { id: 3, volume_discount_number_of_orders: 3, volume_discount_price: 2 } : null,
          findMany: async () => (uid === 'api::order.order' ? orders : []),
        }),
      },
    };
    return require(path.join(__dirname, '..', 'src', 'api', 'order', 'controllers', 'order.js'))({
      strapi: global.strapi,
    });
  }
  const body = { date: '2026-10-21', contactId: 9, ownerId: 5, routeId: 3 };
  afterEach(() => {
    delete global.strapi;
  });

  it('alone, no discount', async () => {
    orders = [];
    const res = await load().checkMultidelivery({ request: { body } });
    expect(res).toEqual({ multidelivery_discount: 0, volume_discount: 0 });
  });

  it('another unsaved row to the same point gives the multidelivery discount', async () => {
    orders = [];
    const res = await load().checkMultidelivery({ request: { body: { ...body, pendingSameContact: 1 } } });
    expect(res.multidelivery_discount).toBe(20);
  });

  it('unsaved rows on the route count for the volume discount', async () => {
    orders = [{ id: 1, status: 'pending' }];
    const res = await load().checkMultidelivery({ request: { body: { ...body, pendingSameRoute: 1 } } });
    expect(res.volume_discount).toBe(2);
  });

  it('ignores counts that are not whole positive numbers', async () => {
    orders = [];
    const res = await load().checkMultidelivery({
      request: { body: { ...body, pendingSameContact: 'x', pendingSameRoute: -4 } },
    });
    expect(res).toEqual({ multidelivery_discount: 0, volume_discount: 0 });
  });
});
