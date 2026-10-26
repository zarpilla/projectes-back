'use strict';

/**
 * FACe's REST API answers the registry number as `registryCode` and the status
 * as `status` + `statusHistory` codes. The service read `numero_registro` and
 * `estado`, so no queue row ever got its registry number (the Número registre
 * column stayed empty and status checks were skipped) and a paid or rejected
 * invoice stayed «Registrada». Found on the local FACe test env, 2026-10-26.
 */

const service = require('../src/api/face-queue/utils/face-status');

// Trimmed from a real FACe test answer (2026-10-26)
const answer = (codes, status) => ({
  number: '2026-051',
  registryCode: 'REGAGE26e00000470629',
  status,
  statusHistory: codes.map((code) => ({ code: String(code), name: 'x' })),
});

describe('FACe status answer', () => {
  it('a registered invoice stays registered', () => {
    expect(service.mapFaceEstado(answer([1200], 'Registrada'))).toBe('registered');
    expect(service.mapFaceEstado(answer([1200, 1300], 'Registrada en RCF'))).toBe('registered');
  });

  it('accounted for or paid is delivered', () => {
    expect(service.mapFaceEstado(answer([1200, 1300, 2400], 'Contabilizada la obligación de pago'))).toBe('delivered');
    expect(service.mapFaceEstado(answer([1200, 1300, 2400, 2500], 'Pagada'))).toBe('delivered');
  });

  it('rejected or cancelled is rejected', () => {
    expect(service.mapFaceEstado(answer([1200, 2600], 'Rechazada'))).toBe('rejected');
    expect(service.mapFaceEstado(answer([1200, 3100], 'Anulada'))).toBe('rejected');
  });

  it('still understands the old string values', () => {
    expect(service.mapFaceEstado('REC02')).toBe('rejected');
    expect(service.mapFaceEstado('REC01')).toBe('delivered');
  });
});

describe('FACe registry number of a queue row', () => {
  it('uses the saved column', () => {
    expect(service.registrationNumberOf({ registration_number: 'REGAGE1' })).toBe('REGAGE1');
  });

  it('falls back to registryCode in the saved answer (rows sent before the fix)', () => {
    const row = { registration_number: null, response_body: JSON.stringify(answer([1200], 'Registrada'), null, 2) };
    expect(service.registrationNumberOf(row)).toBe('REGAGE26e00000470629');
  });

  it('has none for an error answer', () => {
    expect(service.registrationNumberOf({ response_body: '{"errors":["x"],"code":"400"}' })).toBeNull();
    expect(service.registrationNumberOf({ response_body: 'FACe pre-validation error: …' })).toBeNull();
  });
});

describe('FACe submit result', () => {
  it('reads registryCode as the registration number', () => {
    const src = require('fs').readFileSync(require.resolve('../src/api/face-queue/services/face-queue'), 'utf8');
    expect(src).toMatch(/registrationNumber:\s*response\.data\.registryCode/);
  });
});

describe('FACe settings reads load the certificate', () => {
  // v5 leaves the media relation out unless populated: the status check said
  // «FACe certificate not configured in settings» with the certificate set.
  it.each([
    'src/api/face-queue/controllers/face-queue.js',
    'src/api/face-queue/services/face-queue.js',
  ])('%s populates face_certificate on every settings read', (file) => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', file), 'utf8');
    const reads = src.match(/documents\(ME_UID\)\.findFirst\([^)]*\)/g) || [];
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read).toMatch(/face_certificate/);
  });
});
