'use strict';
/* global strapi */

/**
 * face-queue lifecycles (v5). Ported from v3 api/face-queue/models/face-queue.js.
 * Triggers the FACe submission process on create/update of pending items.
 * The FACe service itself is ported in Phase 8; the guarded call no-ops until then.
 */
const startFaceProcess = async (queueItem) => {
  const service = strapi.service('api::face-queue.face-queue');
  if (!service || typeof service.startFaceProcess !== 'function') {
    return;
  }
  await service.startFaceProcess(queueItem);
};

const processingQueueIds = new Set();
const internalUpdateQueueIds = new Set();

const runOncePerQueue = async (queueItem) => {
  if (!queueItem || !queueItem.id) return;
  if (processingQueueIds.has(queueItem.id)) return;
  processingQueueIds.add(queueItem.id);
  try {
    await startFaceProcess(queueItem);
  } finally {
    processingQueueIds.delete(queueItem.id);
  }
};

module.exports = {
  async afterCreate(event) {
    strapi.log.info(`[face-queue] afterCreate id=${event.result && event.result.id}`);
    await runOncePerQueue(event.result);
  },
  async beforeUpdate(event) {
    const queueId = event.params.where && event.params.where.id ? Number(event.params.where.id) : null;
    if (queueId && event.params.data && event.params.data._internal === true) {
      internalUpdateQueueIds.add(queueId);
      strapi.log.info(`[face-queue] beforeUpdate internal id=${queueId}`);
      delete event.params.data._internal;
    }
  },
  async afterUpdate(event) {
    const result = event.result;
    const data = event.params.data;
    const queueId = result && result.id ? Number(result.id) : null;

    if (queueId && internalUpdateQueueIds.has(queueId)) {
      internalUpdateQueueIds.delete(queueId);
      strapi.log.info(`[face-queue] afterUpdate skip internal id=${queueId}`);
      return;
    }
    if (data && data._internal === true) {
      strapi.log.info(`[face-queue] afterUpdate skip data._internal id=${queueId || '-'}`);
      return;
    }
    if (!result || result.status !== 'pending') {
      strapi.log.info(
        `[face-queue] afterUpdate skip status id=${queueId || '-'} status=${result && result.status ? result.status : '-'}`,
      );
      return;
    }

    strapi.log.info(`[face-queue] afterUpdate processing id=${queueId}`);
    await runOncePerQueue(result);
  },
};
