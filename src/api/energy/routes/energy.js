'use strict';

/**
 * Comunitat energètica (/api/energy/*): members, their CUPS, installations and
 * distribution coefficients. Allowed to `admin_energy` and to full access
 * (projects/admin) by services/app-access-rules.js; the members are read and
 * written only here, so this permission reaches no other contact.
 */
const route = (method, path, handler) => ({ method, path, handler: `energy.${handler}` });

module.exports = {
  routes: [
    route('GET', '/energy/partners', 'listPartners'),
    route('POST', '/energy/partners', 'createPartner'),
    route('GET', '/energy/partners/:id', 'getPartner'),
    route('PUT', '/energy/partners/:id', 'updatePartner'),
    route('POST', '/energy/supplies', 'createSupply'),
    route('PUT', '/energy/supplies/:id', 'updateSupply'),
    route('DELETE', '/energy/supplies/:id', 'deleteSupply'),
    route('GET', '/energy/installations', 'listInstallations'),
    route('POST', '/energy/installations', 'createInstallation'),
    route('PUT', '/energy/installations/:id', 'updateInstallation'),
    route('DELETE', '/energy/installations/:id', 'deleteInstallation'),
    route('GET', '/energy/installations/:id/distribution', 'distribution'),
    route('POST', '/energy/installations/:id/distribution', 'setDistribution'),
    route('POST', '/energy/coefficients', 'addCoefficient'),
    route('PUT', '/energy/coefficients/:id', 'updateCoefficient'),
    route('DELETE', '/energy/coefficients/:id', 'deleteCoefficient'),
  ],
};
