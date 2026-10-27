'use strict';
/* global strapi */

/**
 * Comunitat energètica (routes/energy.js). Thin: the work is in
 * services/energy.js, which throws Strapi's ValidationError (400) and
 * NotFoundError (404).
 */
const service = () => strapi.service('api::energy.energy');
const body = (ctx) => {
  const b = (ctx.request && ctx.request.body) || {};
  return b.data && typeof b.data === 'object' ? b.data : b;
};
const query = (ctx) => ctx.query || {};

module.exports = {
  async listPartners(ctx) {
    ctx.body = await service().listPartners(query(ctx));
  },
  async getPartner(ctx) {
    ctx.body = await service().getPartner(ctx.params.id);
  },
  async createPartner(ctx) {
    ctx.body = await service().createPartner(body(ctx));
  },
  async updatePartner(ctx) {
    ctx.body = await service().updatePartner(ctx.params.id, body(ctx));
  },
  async createSupply(ctx) {
    ctx.body = await service().createSupply(body(ctx));
  },
  async updateSupply(ctx) {
    ctx.body = await service().updateSupply(ctx.params.id, body(ctx));
  },
  async deleteSupply(ctx) {
    ctx.body = await service().deleteSupply(ctx.params.id);
  },
  async listInstallations(ctx) {
    ctx.body = await service().listInstallations(query(ctx));
  },
  async createInstallation(ctx) {
    ctx.body = await service().createInstallation(body(ctx));
  },
  async updateInstallation(ctx) {
    ctx.body = await service().updateInstallation(ctx.params.id, body(ctx));
  },
  async deleteInstallation(ctx) {
    ctx.body = await service().deleteInstallation(ctx.params.id);
  },
  async distribution(ctx) {
    ctx.body = await service().distribution(ctx.params.id, query(ctx));
  },
  async setDistribution(ctx) {
    ctx.body = await service().setDistribution(ctx.params.id, body(ctx));
  },
  async addCoefficient(ctx) {
    ctx.body = await service().addCoefficient(body(ctx));
  },
  async updateCoefficient(ctx) {
    ctx.body = await service().updateCoefficient(ctx.params.id, body(ctx));
  },
  async deleteCoefficient(ctx) {
    ctx.body = await service().deleteCoefficient(ctx.params.id);
  },
};
