'use strict';

/**
 * issues/413 (2026-11-06): «Tresoreria › Conciliació». A Norma 43 statement is
 * uploaded by hand; its movements are stored once (an overlapping statement
 * doesn't duplicate them), the closing balance becomes the account's «saldo
 * real», and the clear movements are reconciled on their own. Accepting a
 * movement marks its pending documents paid on the bank's date (issues/415)
 * or validates its executed lines, always pointing to the movement, and undo
 * puts everything back. Movements without a document become an «Operació de
 * tresoreria», and transfers between own accounts one on each account.
 */

const { memoryDb } = require('./helpers/memory-db');
const { norma43File } = require('./helpers/norma43-file');

const MOVEMENT = 'api::bank-movement.bank-movement';
const IMPORT = 'api::bank-import.bank-import';
const ACCOUNT = 'api::bank-account.bank-account';
const VALIDATION = 'api::treasury-validation.treasury-validation';
const TREASURY = 'api::treasury.treasury';
const RULE = 'api::bank-rule.bank-rule';

const IBAN_A = 'ES91 3025 0001 1112 3456 7890';
const IBAN_B = 'ES12 2100 0002 3300 0000 1111';

const forecastRow = (over) => ({
  type: 'Factura emesa',
  concept: 'F-42',
  contact: 'Clienta Fruita',
  total_amount: 1210,
  datef: '20261001',
  bank_account: 'Banc A',
  paid: false,
  real: true,
  validation_key: 'emitted-invoices:42',
  is_validated: false,
  settle: { kind: 'emitted-invoices', id: 42 },
  ...over,
});

describe('reconcile (issues/413)', () => {
  let db;
  let rows;
  let reconcile;
  let settled;

  beforeEach(() => {
    jest.resetModules();
    settled = [];
    class SettleError extends Error {}
    jest.doMock('../src/api/treasury-validation/services/settle', () => ({
      SettleError,
      settleDocument: jest.fn(async (p) => {
        if (p.entity_id === 99) throw new SettleError('no');
        settled.push(p);
        await global.strapi.db.query(VALIDATION).create({
          data: { entity_type: p.entity_type, entity_id: p.entity_id, sub_type: null, bank_movement: p.bankMovementId, settlement: { date: p.date } },
        });
        return { validation_key: `${p.entity_type}:${p.entity_id}` };
      }),
      unsettle: jest.fn(async (v) => {
        settled = settled.filter((s) => s.entity_id !== v.entity_id);
        return true;
      }),
    }));
    rows = [
      forecastRow({}),
      forecastRow({ settle: null, paid: true, validation_key: 'received-invoices:7', total_amount: -50, concept: 'R-7', datef: '20261010' }),
    ];
    db = memoryDb(
      {
        [ACCOUNT]: [
          { id: 1, name: 'Banc A', iban: IBAN_A },
          { id: 2, name: 'Banc B', iban: IBAN_B },
        ],
        [MOVEMENT]: [],
        [IMPORT]: [],
        [VALIDATION]: [],
        [TREASURY]: [],
        [RULE]: [],
      },
      {
        refs: {
          [MOVEMENT]: { bank_account: ACCOUNT, transfer_movement: MOVEMENT, rule: RULE },
          [RULE]: { bank_account: ACCOUNT },
          [VALIDATION]: { bank_movement: MOVEMENT },
        },
      },
    );
    global.strapi = {
      db,
      controller: () => ({ forecast: async () => ({ treasury: rows }) }),
      log: { warn: jest.fn(), info() {} },
    };
    reconcile = require('../src/api/bank-movement/services/reconcile');
  });

  afterEach(() => {
    delete global.strapi;
  });

  const statement = (movements, over = {}) =>
    Buffer.from(
      norma43File([{ bank: '3025', branch: '0001', account: '1234567890', start: '2026-10-01', end: '2026-10-31', opening: 100, movements, ...over }]),
      'latin1',
    ).toString('base64');

  const addMovement = async (over) =>
    db.query(MOVEMENT).create({ data: { bank_account: 1, date: '2026-10-03', amount: 1210, concept: 'TRANSF', status: 'pending', ...over } });

  describe('importStatement', () => {
    it('stores the movements, notes the closing balance and reconciles the clear ones', async () => {
      const r = await reconcile.importStatement({
        fileName: 'oct.n43',
        content: statement([
          { date: '2026-10-03', amount: 1210, concept: 'TRANSF CLIENTA FRUITA' },
          { date: '2026-10-15', amount: -3.5, concept: 'COMISSIO' },
        ]),
        userId: 9,
      });
      expect(r.accounts).toEqual([{ bank_account: 'Banc A', from: '2026-10-01', to: '2026-10-31', created: 2, duplicate: 0, closing: 1306.5 }]);
      expect(r.auto).toEqual({ matched: 1, transfers: 0, ruled: 0 });
      expect(db.rows[MOVEMENT].map((m) => [m.amount, m.status, m.bank_account])).toEqual([
        [1210, 'matched', 1],
        [-3.5, 'pending', 1],
      ]);
      // collected on the bank's date
      expect(settled).toEqual([expect.objectContaining({ entity_type: 'emitted-invoices', entity_id: 42, date: '2026-10-03', bankMovementId: 1, userId: 9 })]);
      // the balance at the start of the next day, validated
      expect(db.rows[TREASURY]).toEqual([expect.objectContaining({ is_real_balance: true, date: '2026-11-01', total: 1306.5, bank_account: 1 })]);
      expect(db.rows[VALIDATION]).toEqual(
        expect.arrayContaining([expect.objectContaining({ entity_type: 'treasuries', entity_id: db.rows[TREASURY][0].id })]),
      );
      expect(db.rows[IMPORT][0]).toMatchObject({ file_name: 'oct.n43', movements_new: 2, movements_duplicate: 0, closing_balance: 1306.5 });
    });

    it('skips the movements of an overlapping statement and keeps one closing balance per day', async () => {
      const content = statement([
        { date: '2026-10-15', amount: -3.5, concept: 'COMISSIO' },
        { date: '2026-10-15', amount: -3.5, concept: 'COMISSIO' },
      ]);
      await reconcile.importStatement({ content });
      const again = await reconcile.importStatement({ content });
      expect(again.accounts[0]).toMatchObject({ created: 0, duplicate: 2 });
      expect(db.rows[MOVEMENT]).toHaveLength(2);
      expect(db.rows[TREASURY]).toHaveLength(1);
    });

    it('refuses an account that is none of the entity\'s, and stores nothing', async () => {
      await expect(reconcile.importStatement({ content: statement([], { account: '0000000001' }) })).rejects.toThrow(/Comptes bancaris/);
      expect(db.rows[MOVEMENT]).toEqual([]);
      expect(db.rows[IMPORT]).toEqual([]);
      await expect(reconcile.importStatement({ content: Buffer.from('hola').toString('base64') })).rejects.toThrow(reconcile.ReconcileError);
    });
  });

  describe('acceptLines', () => {
    it('validates executed lines and settles pending documents, pointing to the movement', async () => {
      const m = await addMovement({ amount: 1160, date: '2026-10-12' });
      await reconcile.acceptLines(m.id, [{ id: 'settle:emitted-invoices:42' }, { id: 'keys:received-invoices:7' }], 3);
      expect(settled).toEqual([expect.objectContaining({ entity_id: 42, date: '2026-10-12', bankMovementId: m.id, amount: undefined })]);
      expect(db.rows[VALIDATION]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ entity_type: 'received-invoices', entity_id: 7, sub_type: null, bank_movement: m.id, validated_by: 3 }),
        ]),
      );
      expect(db.rows[MOVEMENT][0]).toMatchObject({ status: 'matched', match_kind: 'lines', matched_by: 3, auto: false });
    });

    it('collects part of a pending document', async () => {
      const m = await addMovement({ amount: 500 });
      await reconcile.acceptLines(m.id, [{ id: 'settle:emitted-invoices:42', amount: 500 }], 3);
      expect(settled[0]).toMatchObject({ amount: 500 });
    });

    it('refuses lines that do not add up to the movement, or a part of an executed line', async () => {
      const m = await addMovement({ amount: 1000 });
      await expect(reconcile.acceptLines(m.id, [{ id: 'settle:emitted-invoices:42' }], 3)).rejects.toThrow(/sumen 1210.00/);
      await expect(reconcile.acceptLines(m.id, [{ id: 'keys:received-invoices:7', amount: -10 }], 3)).rejects.toThrow(/en part/);
      expect(db.rows[MOVEMENT][0].status).toBe('pending');
    });

    it('puts back what it did when one of the lines fails', async () => {
      rows.push(forecastRow({ settle: { kind: 'emitted-invoices', id: 99 }, total_amount: 10, concept: 'F-99' }));
      const m = await addMovement({ amount: 1220 });
      await expect(
        reconcile.acceptLines(m.id, [{ id: 'settle:emitted-invoices:42' }, { id: 'settle:emitted-invoices:99' }], 3),
      ).rejects.toThrow('no');
      expect(settled).toEqual([]);
      expect(db.rows[VALIDATION]).toEqual([]);
      expect(db.rows[MOVEMENT][0].status).toBe('pending');
    });
  });

  describe('undo', () => {
    it('removes the validations (and what they paid) and the movement is pending again', async () => {
      const m = await addMovement({});
      await reconcile.acceptLines(m.id, [{ id: 'settle:emitted-invoices:42' }], 3);
      await reconcile.undo(m.id);
      expect(settled).toEqual([]);
      expect(db.rows[VALIDATION]).toEqual([]);
      expect(db.rows[MOVEMENT][0]).toMatchObject({ status: 'pending', match_kind: null, matched_by: null });
    });

    it('a transfer: both movements and both «Operacions de tresoreria»', async () => {
      const a = await addMovement({ amount: -300, bank_account: 1 });
      const b = await addMovement({ amount: 300, bank_account: 2, date: '2026-10-04' });
      await reconcile.transfer(a.id, b.id, 3);
      expect(db.rows[TREASURY].map((t) => [t.total, t.bank_account, t.comment])).toEqual([
        [-300, 1, 'Traspàs Banc A → Banc B'],
        [300, 2, 'Traspàs Banc A → Banc B'],
      ]);
      expect(db.rows[MOVEMENT].map((m) => [m.status, m.match_kind, m.transfer_movement])).toEqual([
        ['matched', 'transfer', b.id],
        ['matched', 'transfer', a.id],
      ]);
      await reconcile.undo(b.id);
      expect(db.rows[TREASURY]).toEqual([]);
      expect(db.rows[VALIDATION]).toEqual([]);
      expect(db.rows[MOVEMENT].map((m) => m.status)).toEqual(['pending', 'pending']);
    });

    it('refuses a transfer within one account or with amounts that do not cancel out', async () => {
      const a = await addMovement({ amount: -300 });
      const b = await addMovement({ amount: 300 });
      const c = await addMovement({ amount: 200, bank_account: 2 });
      await expect(reconcile.transfer(a.id, b.id, 3)).rejects.toThrow(/dos comptes/);
      await expect(reconcile.transfer(a.id, c.id, 3)).rejects.toThrow(/no es compensen/);
    });
  });

  describe('createFromMovement and the rules', () => {
    it('notes a movement without a document as an «Operació de tresoreria», validated', async () => {
      const m = await addMovement({ amount: -3.5, concept: 'COMISSIO MANTENIMENT' });
      await reconcile.createFromMovement(m.id, { kind: 'annotation' }, 3);
      expect(db.rows[TREASURY]).toEqual([expect.objectContaining({ comment: 'COMISSIO MANTENIMENT', total: -3.5, date: '2026-10-03', bank_account: 1 })]);
      expect(db.rows[VALIDATION]).toEqual([expect.objectContaining({ entity_type: 'treasuries', bank_movement: m.id })]);
      expect(db.rows[MOVEMENT][0]).toMatchObject({ status: 'matched', match_kind: 'annotation' });
    });

    it('the automatic pass applies the rules to what has no line, and pairs the transfers', async () => {
      db.rows[RULE].push({ id: 1, name: 'Comissions', pattern: 'comissio', direction: 'out', action: 'annotation', active: true });
      db.rows[RULE].push({ id: 2, name: 'Quotes', pattern: 'quota', direction: 'any', action: 'ignore', active: true });
      await addMovement({ amount: -3.5, concept: 'COMISSIO' });
      await addMovement({ amount: -12, concept: 'QUOTA TARGETA' });
      await addMovement({ amount: -700, concept: 'TRASPAS', date: '2026-10-20' });
      await addMovement({ amount: 700, concept: 'TRASPAS', date: '2026-10-20', bank_account: 2 });
      const r = await reconcile.autoReconcile(3);
      expect(r).toEqual({ matched: 0, transfers: 1, ruled: 2 });
      expect(db.rows[MOVEMENT].map((m) => [m.status, m.match_kind || null, m.rule || null])).toEqual([
        ['matched', 'annotation', 1],
        ['ignored', null, 2],
        ['matched', 'transfer', null],
        ['matched', 'transfer', null],
      ]);
    });
  });

  it('releaseMovement: a movement whose last validation is removed in Tresoreria is pending again', async () => {
    const m = await addMovement({});
    await reconcile.acceptLines(m.id, [{ id: 'settle:emitted-invoices:42' }], 3);
    await reconcile.releaseMovement(m.id);
    expect(db.rows[MOVEMENT][0].status).toBe('matched');
    db.rows[VALIDATION] = [];
    await reconcile.releaseMovement(m.id);
    expect(db.rows[MOVEMENT][0].status).toBe('pending');
  });

  it('reconciliation: suggestions for the pending movements, the lines of the matched ones', async () => {
    const pending = await addMovement({});
    const done = await addMovement({ amount: -50, date: '2026-10-10' });
    await reconcile.acceptLines(done.id, [{ id: 'keys:received-invoices:7' }], 3);
    rows[1].is_validated = true;
    const r = await reconcile.reconciliation({ status: 'all' });
    const p = r.movements.find((x) => x.id === pending.id);
    expect(p.suggestions[0]).toMatchObject({ kind: 'line', auto: true });
    expect(p.suggestions[0].lines[0]).toMatchObject({ id: 'settle:emitted-invoices:42', code: 'F-42' });
    const d = r.movements.find((x) => x.id === done.id);
    expect(d.validations).toEqual([expect.objectContaining({ key: 'received-invoices:7', code: 'R-7', amount: -50 })]);
  });
  it('candidates: without a search, executed lines near the movement and every pending document; a search finds any', async () => {
    rows.push(
      forecastRow({ settle: null, paid: true, validation_key: 'emitted-invoices:50', total_amount: 1200, concept: 'F-2022', datef: '20220415' }),
      forecastRow({ settle: null, paid: true, validation_key: 'emitted-invoices:51', total_amount: 1100, concept: 'F-NEAR', datef: '20260920' }),
      forecastRow({ settle: { kind: 'emitted-invoices', id: 52 }, total_amount: 900, concept: 'F-OLD-PENDING', datef: '20250301' }),
    );
    const m = await addMovement({});
    const codes = (r) => r.lines.map((l) => l.code);
    expect(codes(await reconcile.candidates(m.id, ''))).toEqual(['F-42', 'F-NEAR', 'F-OLD-PENDING']);
    expect(codes(await reconcile.candidates(m.id, 'f-2022'))).toEqual(['F-2022']);
  });
});
