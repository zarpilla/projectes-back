'use strict';

/**
 * Reading AEAT's answer.
 *
 * AEAT returns two statuses and the meaningful one is the per-record
 * EstadoRegistro:
 *
 *   EstadoEnvio     Correcto | ParcialmenteCorrecto | Incorrecto
 *   EstadoRegistro  Correcto | AceptadoConErrores   | Incorrecto
 *
 * "AceptadoConErrores" is an ACCEPTANCE — AEAT registered the invoice and
 * attached remarks. The original code matched "AceptadaConErrores" with a
 * feminine ending, so a real acceptance-with-remarks fell through to the
 * rejection branch: the chain was marked `ko` and, because only the accepted
 * branches call updateInvoiceQr, the invoice never received its QR and the
 * PDF printed without it.
 */

const { aeatValue, chainStateFromResponse } = require('../src/api/verifactu-chain/services/aeat-response');

/** The shape AEAT actually returns, with identifiers replaced. */
const response = (envio, registro, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
 <env:Body>
  <tikR:RespuestaRegFactuSistemaFacturacion xmlns:tikR="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tikeV1.0/Respuesta.xsd">
   <tikR:CSV>A-XXXXXXXXXXXXXX</tikR:CSV>
   <tikR:EstadoEnvio>${envio}</tikR:EstadoEnvio>
   <tikR:RespuestaLinea>
    <tikR:EstadoRegistro>${registro}</tikR:EstadoRegistro>${extra}
   </tikR:RespuestaLinea>
  </tikR:RespuestaRegFactuSistemaFacturacion>
 </env:Body>
</env:Envelope>`;

describe('aeatValue', () => {
  it('reads an element regardless of its namespace prefix', () => {
    expect(aeatValue(response('Correcto', 'Correcto'), 'EstadoEnvio')).toBe('Correcto');
    expect(aeatValue('<x:EstadoEnvio>Correcto</x:EstadoEnvio>', 'EstadoEnvio')).toBe('Correcto');
    expect(aeatValue('<EstadoEnvio>Correcto</EstadoEnvio>', 'EstadoEnvio')).toBe('Correcto');
  });

  it('returns null when the element is absent', () => {
    expect(aeatValue('<env:Body/>', 'EstadoRegistro')).toBeNull();
    expect(aeatValue('', 'EstadoEnvio')).toBeNull();
  });
});

describe('chainStateFromResponse', () => {
  it('accepts a fully correct submission', () => {
    expect(chainStateFromResponse(response('Correcto', 'Correcto'))).toBe('ok');
  });

  it('treats AceptadoConErrores as accepted, not rejected', () => {
    // The exact response that was being mapped to `ko`: AEAT registered the
    // invoice and returned error 2007 as a remark.
    const remark =
      '<tikR:CodigoErrorRegistro>2007</tikR:CodigoErrorRegistro>' +
      '<tikR:DescripcionErrorRegistro>No debe informarse como primer registro' +
      '</tikR:DescripcionErrorRegistro>';
    const body = response('ParcialmenteCorrecto', 'AceptadoConErrores', remark);
    expect(chainStateFromResponse(body)).toBe('okwitherrors');
  });

  it('also accepts the feminine spelling, in case AEAT sends it', () => {
    expect(chainStateFromResponse(response('ParcialmenteCorrecto', 'AceptadaConErrores')))
      .toBe('okwitherrors');
  });

  it('rejects an incorrect record', () => {
    expect(chainStateFromResponse(response('Incorrecto', 'Incorrecto'))).toBe('ko');
  });

  it('rejects when the record status is missing or unrecognised', () => {
    expect(chainStateFromResponse('')).toBe('ko');
    expect(chainStateFromResponse('<env:Body/>')).toBe('ko');
    expect(chainStateFromResponse(response('ParcialmenteCorrecto', 'AlgoNuevo'))).toBe('ko');
  });

  it('does not confuse ParcialmenteCorrecto with Correcto', () => {
    // The naive `includes('EstadoEnvio>Correcto<')` check would be a substring
    // trap if the values were ever reordered; assert the distinction directly.
    expect(chainStateFromResponse(response('ParcialmenteCorrecto', 'Incorrecto'))).toBe('ko');
  });
});

describe('the accepted states drive the QR', () => {
  it('are exactly the two the lifecycle writes the invoice QR for', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'api', 'verifactu-chain', 'content-types', 'verifactu-chain', 'lifecycles.js'),
      'utf8',
    );
    // updateInvoiceQr must run for ok AND okwitherrors — an accepted invoice
    // has a valid QR whether or not AEAT attached remarks.
    expect(source).toContain("state === 'ok' || state === 'okwitherrors'");
    expect(source).toContain('await updateInvoiceQr(');
  });
});
