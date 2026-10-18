'use strict';

/**
 * Reads what the app needs to know about a PKCS#12 keystore (the AEAT and FACe
 * certificates, ticket 159): whether the password opens it, whether it holds a
 * private key with its certificate, and who the certificate is for and until
 * when.
 *
 * Both consumers have to be able to open it: node-forge (FACe signing and JWT,
 * utils/face-jwt.js and sign-facturae.js) and OpenSSL through https.Agent({ pfx })
 * (AEAT and FACe requests). OpenSSL 3 refuses the legacy RC2-40 encryption of
 * old exports that forge still reads, so a keystore only counts as valid when
 * both open it.
 */

const tls = require('tls');
const forge = require('node-forge');

// Catalan texts shown by the app; `error` codes are stable for the front end.
const MESSAGES = {
  not_pkcs12: "El fitxer no és un certificat PKCS#12 (.p12 o .pfx) vàlid.",
  wrong_password: 'La contrasenya no obre el certificat.',
  no_key: "El fitxer no conté la clau privada: exporta el certificat amb la clau privada.",
  no_certificate: 'El fitxer no conté el certificat de la clau privada.',
  unsupported:
    "El certificat fa servir un xifratge antic que el servidor no admet. Torna'l a exportar amb xifratge AES.",
};

const OID_SERIAL_NUMBER = '2.5.4.5';
const OID_ORGANIZATION_IDENTIFIER = '2.5.4.97';

/** `VATES-B12345678` → `B12345678`, `IDCES-12345678Z` → `12345678Z` (ETSI EN 319 412-1). */
function stripIdentifierPrefix(value) {
  return String(value).replace(/^(VAT|IDC|PNO|NTR)[A-Z]{2}[-:]/, '');
}

function attribute(name, oid) {
  const attr = name.attributes.find((a) => a.type === oid);
  return attr ? attr.value : null;
}

function describeName(name) {
  const commonName = name.getField('CN');
  const organization = name.getField('O');
  return {
    commonName: commonName ? commonName.value : null,
    organization: organization ? organization.value : null,
  };
}

/** Holder, NIF, issuer and validity of a forge certificate. */
function describeCertificate(cert) {
  const organizationIdentifier = attribute(cert.subject, OID_ORGANIZATION_IDENTIFIER);
  const serialNumber = attribute(cert.subject, OID_SERIAL_NUMBER);
  const identifier = organizationIdentifier || serialNumber;
  return {
    subject: describeName(cert.subject),
    // An entity representative's certificate carries the entity's NIF as
    // organizationIdentifier and the person's as serialNumber.
    nif: identifier ? stripIdentifierPrefix(identifier) : null,
    issuer: describeName(cert.issuer),
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
  };
}

function failure(error) {
  return { valid: false, error, message: MESSAGES[error], certificate: null };
}

/**
 * @param {Buffer} buffer the .p12/.pfx contents
 * @param {string} [password]
 * @returns {{ valid: boolean, error: string|null, message: string|null, certificate: object|null }}
 */
function inspectPkcs12(buffer, password) {
  const passphrase = password || '';

  let asn1;
  try {
    asn1 = forge.asn1.fromDer(buffer.toString('binary'));
  } catch {
    return failure('not_pkcs12');
  }

  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, passphrase);
  } catch (error) {
    // forge says "PKCS#12 MAC could not be verified. Invalid password?", or
    // fails decrypting the bags when there is no MAC
    if (/password|MAC|decrypt/i.test(error.message || '')) return failure('wrong_password');
    return failure('not_pkcs12');
  }

  const bags = (bagType) => p12.getBags({ bagType })[bagType] || [];
  const keyBag = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag), ...bags(forge.pki.oids.keyBag)].find((b) => b.key);
  if (!keyBag) return failure('no_key');
  // The client certificate: the one of the private key, not one of the CA chain.
  const certBag = bags(forge.pki.oids.certBag).find(
    (b) => b.cert && b.cert.publicKey.n && b.cert.publicKey.n.equals(keyBag.key.n),
  );
  if (!certBag) return failure('no_certificate');

  try {
    tls.createSecureContext({ pfx: buffer, passphrase });
  } catch (error) {
    if (/mac verify|password/i.test(error.message || '')) return failure('wrong_password');
    return { ...failure('unsupported'), certificate: describeCertificate(certBag.cert) };
  }

  return { valid: true, error: null, message: null, certificate: describeCertificate(certBag.cert) };
}

module.exports = { inspectPkcs12, stripIdentifierPrefix, MESSAGES };
