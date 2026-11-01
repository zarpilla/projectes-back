'use strict';

/**
 * issues/398 (security review round 3, 2026-11-01): on a copy of Arran de
 * Terra user 14 (`projects`, not admin) created a VeriFactu chain row and a
 * FACe queue item (201). Their afterCreate sends to AEAT / starts the FACe
 * process, so any invoice (a draft, a duplicate) could be submitted, or a
 * forged `ok` row could break the hash chain. Update/delete were admin only;
 * create now is too. The server creates its rows with strapi.db.query.
 */

jest.mock('@strapi/strapi', () => ({ factories: { createCoreRouter: (uid, opts) => ({ uid, opts }) } }));

describe('VeriFactu and FACe rows: only admins write them (issues/398)', () => {
  it.each([
    ['verifactu-chain', ['create', 'update', 'delete']],
    ['face-queue', ['create', 'update', 'delete']],
    ['verifactu-declaration', ['create', 'update', 'delete']],
  ])('%s', (name, actions) => {
    const router = require(`../src/api/${name}/routes/${name}.js`);
    for (const action of actions) expect(router.opts.config[action]).toEqual({ policies: ['global::isAdmin'] });
    expect(router.opts.config.find).toBeUndefined();
  });
});
