'use strict';

/**
 * Reading AEAT's SOAP answer.
 *
 * Kept out of the lifecycles file because Strapi validates that a lifecycles
 * module exports lifecycle hooks and nothing else.
 */

/**
 * Reads an AEAT status element, ignoring whichever namespace prefix it carries
 * (the responses use tikR:, but that is not guaranteed).
 */
function aeatValue(body, element) {
  const match = new RegExp(`<[^>]*${element}>\\s*([^<]*?)\\s*<`, 'i').exec(body || '');
  return match ? match[1] : null;
}

/**
 * Maps an AEAT SOAP response onto a chain state.
 *
 * AEAT answers with two statuses, and the useful one is the per-record
 * EstadoRegistro:
 *
 *   EstadoEnvio     Correcto | ParcialmenteCorrecto | Incorrecto
 *   EstadoRegistro  Correcto | AceptadoConErrores   | Incorrecto
 *
 * "AceptadoConErrores" means the invoice IS registered — AEAT kept it and
 * returned remarks — so it is an acceptance, not a failure. The previous code
 * matched the string "AceptadaConErrores" with a feminine ending; AEAT sends
 * the masculine form, agreeing with "registro". That one letter sent every
 * accepted-with-remarks invoice down the rejection branch, which also skipped
 * writing the QR onto the invoice. Both spellings are accepted here.
 */
function chainStateFromResponse(body) {
  const envio = aeatValue(body, 'EstadoEnvio');
  const registro = aeatValue(body, 'EstadoRegistro');

  if (envio === 'Correcto') return 'ok';
  if (/^Aceptad[oa]ConErrores$/i.test(registro || '')) return 'okwitherrors';
  if (registro === 'Correcto') return 'ok';
  return 'ko';
}

module.exports = { aeatValue, chainStateFromResponse };
