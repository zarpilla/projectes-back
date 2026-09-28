'use strict';

/**
 * POST /api/upload returned 500 with
 *   Error: Metadata for "orders-imports" not found
 *     at getMorphToManyRowsLinkedToMorphOne (morph-relations.js)
 *     at Object.create (entity-manager) -> POST /api/upload (61 ms) 500
 *
 * v3 sent the model NAME in the upload's `ref` field; v5 resolves `ref`
 * through db.metadata and needs the UID. The frontend passes whatever the
 * FileUpload component was given, and those are a mix of plural
 * ("orders-imports", "contacts") and singular ("task", "project") v3 names --
 * so every upload that targets an entity failed, not just this one.
 */

const { __test__ } = require('../src/middlewares/v3-compat');
const { normalizeUploadRef, resetRefMap } = __test__;

const ct = (kind, singularName, pluralName) => ({ kind, info: { singularName, pluralName } });

const strapi = {
  contentTypes: {
    'api::orders-import.orders-import': ct('collectionType', 'orders-import', 'orders-imports'),
    'api::contact.contact': ct('collectionType', 'contact', 'contacts'),
    'api::task.task': ct('collectionType', 'task', 'tasks'),
    'api::project.project': ct('collectionType', 'project', 'projects'),
    'api::me.me': ct('singleType', 'me', 'mes'),
    'plugin::users-permissions.user': ct('collectionType', 'user', 'users'),
  },
};

const run = (body) => {
  const ctx = { request: { body } };
  normalizeUploadRef(ctx, strapi);
  return ctx.request.body;
};

beforeEach(() => resetRefMap());

describe('upload ref compatibility', () => {
  // the exact values the frontend passes to FileUpload
  it.each([
    ['orders-imports', 'api::orders-import.orders-import'],
    ['contacts', 'api::contact.contact'],
    ['task', 'api::task.task'],
    ['project', 'api::project.project'],
  ])('maps v3 ref %s -> %s', (ref, uid) => {
    expect(run({ ref, refId: '7', field: 'file' }).ref).toBe(uid);
  });

  it('leaves a UID untouched', () => {
    const uid = 'api::contact.contact';
    expect(run({ ref: uid }).ref).toBe(uid);
  });

  it('leaves an unknown ref alone rather than guessing', () => {
    expect(run({ ref: 'not-a-model' }).ref).toBe('not-a-model');
  });

  it('preserves the other upload fields', () => {
    expect(run({ ref: 'task', refId: '42', field: 'attachments' }))
      .toEqual({ ref: 'api::task.task', refId: '42', field: 'attachments' });
  });

  it.each([
    ['no body', undefined],
    ['no ref', { refId: '1' }],
    ['ref sent twice', { ref: ['task', 'project'] }],
  ])('tolerates %s', (_label, body) => {
    expect(() => run(body)).not.toThrow();
  });

  it('resolves the users-permissions user', () => {
    expect(run({ ref: 'user' }).ref).toBe('plugin::users-permissions.user');
  });
});
