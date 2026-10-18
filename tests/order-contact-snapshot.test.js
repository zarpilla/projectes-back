/**
 * issues/157 (2026-10-18): an order keeps a copy of its delivery point
 * (contact_* fields: name, address, phone, time slots…). Two ways of moving an
 * order to another point left the old point's copy behind:
 * - «Unificar» punts d'entrega (POST /contacts/unify) only changed `contact`;
 * - the quick edit of the orders list (PUT /orders/:id with just `contact`).
 * Both now copy the new point's data onto the order. Callers that send their
 * own contact_* fields (the order form) keep them.
 */

const TARGET = {
  id: 20,
  name: 'Botiga Nova SL',
  trade_name: 'Botiga Nova',
  nif: 'B20',
  address: 'C/ Nou, 2',
  postcode: '17002',
  notes: 'timbre',
  phone: '600200',
  city: 'Girona',
  legal_form: { id: 3 },
  time_slot_1_ini: 9,
  time_slot_1_end: 13,
  time_slot_2_ini: null,
  time_slot_2_end: null,
  pickup_discount: 1.5,
};

const SNAPSHOT = {
  contact_name: 'Botiga Nova SL',
  contact_trade_name: 'Botiga Nova',
  contact_nif: 'B20',
  contact_address: 'C/ Nou, 2',
  contact_postcode: '17002',
  contact_notes: 'timbre',
  contact_phone: '600200',
  contact_city: 'Girona',
  contact_legal_form: 3,
  contact_time_slot_1_ini: 9,
  contact_time_slot_1_end: 13,
  contact_time_slot_2_ini: null,
  contact_time_slot_2_end: null,
  contact_pickup_discount: 1.5,
};

describe('contact snapshot of orders (issues/157)', () => {
  let updates;
  let superUpdate;

  const stub = ({ orders = [], currentContact = 10 } = {}) => {
    updates = [];
    global.strapi = {
      db: {
        query: (uid) => ({
          findOne: async ({ where }) => {
            if (uid === 'api::contact.contact') {
              if (where.id === 20) return TARGET;
              if (where.id === 10) return { id: 10, name: 'Vella' };
              return null;
            }
            if (uid === 'api::order.order') return { id: where.id, contact: currentContact ? { id: currentContact } : null };
            return null;
          },
          findMany: async () => orders,
          update: async ({ where, data }) => {
            updates.push({ uid, id: where.id, data });
            return { id: where.id, ...data };
          },
        }),
      },
    };
  };

  beforeEach(() => {
    jest.resetModules();
    superUpdate = jest.fn(async (ctx) => ({ data: ctx.request.body }));
    jest.doMock('@strapi/strapi', () => ({
      factories: {
        createCoreController: (uid, build) => (deps) => Object.setPrototypeOf(build(deps), { update: superUpdate }),
      },
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete global.strapi;
    jest.restoreAllMocks();
  });

  describe('Unificar', () => {
    it("moves the orders with the target point's data", async () => {
      stub({ orders: [{ id: 1 }, { id: 2 }] });
      const controller = require('../src/api/contact/controllers/contact')({ strapi: global.strapi });
      const result = await controller.unify({
        request: { body: { sourceContactId: 10, targetContactId: 20 } },
        state: { user: { id: 1 } },
        badRequest: jest.fn(),
        notFound: jest.fn(),
      });
      expect(result.movedOrders).toBe(2);
      expect(updates).toEqual([
        { uid: 'api::order.order', id: 1, data: { contact: 20, ...SNAPSHOT } },
        { uid: 'api::order.order', id: 2, data: { contact: 20, ...SNAPSHOT } },
      ]);
    });
  });

  describe('quick edit (PUT /orders/:id with only the point)', () => {
    const put = async (body, id = 5) => {
      const controller = require('../src/api/order/controllers/order')({ strapi: global.strapi });
      const ctx = { params: { id: String(id) }, state: { user: { id: 1 } }, request: { body } };
      await controller.update(ctx);
      return superUpdate.mock.calls[0][0].request.body;
    };

    it("copies the new point's data", async () => {
      stub();
      const body = await put({ contact: 20, units: 2 });
      expect(body).toMatchObject({ contact: 20, units: 2, ...SNAPSHOT });
    });

    it('leaves the copy alone when the point does not change', async () => {
      stub({ currentContact: 20 });
      const body = await put({ contact: 20, units: 2 });
      expect(body).not.toHaveProperty('contact_name');
    });

    it('keeps the contact_* fields the order form sends', async () => {
      stub();
      const body = await put({ contact: 20, contact_name: 'Escrit a mà', contact_address: 'C/ Altre' });
      expect(body.contact_name).toBe('Escrit a mà');
      expect(body.contact_address).toBe('C/ Altre');
      expect(body).not.toHaveProperty('contact_phone');
    });
  });
});
