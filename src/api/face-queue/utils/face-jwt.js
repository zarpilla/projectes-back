'use strict';
/* global strapi */

const fs = require('fs');
const crypto = require('crypto');
const forge = require('node-forge');

const base64Url = (buffer) =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

/**
 * Read the client certificate and its private key from a PKCS#12 file.
 *
 * In-process, with node-forge: this used to run `openssl pkcs12`, and the
 * Docker image has no openssl binary (issues/037).
 *
 * The file may also hold the CA chain, in any order. The client certificate is
 * the one whose public key matches the private key (what `-clcerts` selected).
 */
const readClientCertificate = (certificatePath, certificatePassword) => {
  const p12Asn1 = forge.asn1.fromDer(fs.readFileSync(certificatePath).toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, certificatePassword || '');

  const bags = (bagType) => p12.getBags({ bagType })[bagType] || [];
  const keyBag = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag), ...bags(forge.pki.oids.keyBag)].find((b) => b.key);
  if (!keyBag) {
    throw new Error('Could not extract private key from PFX');
  }
  const privateKey = keyBag.key;

  const certBag = bags(forge.pki.oids.certBag).find(
    (b) => b.cert && b.cert.publicKey.n && b.cert.publicKey.n.equals(privateKey.n),
  );
  if (!certBag) {
    throw new Error('Could not extract certificate from PFX');
  }

  return {
    // Base64 of the DER certificate: the PEM body without line breaks.
    certBase64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(certBag.cert)).getBytes()),
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
  };
};

/**
 * Generate JWT token for FACe API authentication
 * According to FACe API manual: JWT signed with JWS (RS256), valid for 5 minutes
 * Manual: /home/jordi/Documents/work/webcoop/face/FACe - Manual de API de Proveedores.pdf (page 7)
 */
const generateFaceJWT = (certificatePath, certificatePassword) => {
  try {
    const { certBase64, privateKeyPem } = readClientCertificate(certificatePath, certificatePassword);

    // Calculate SHA1 hash of the cleaned PEM for username
    const username = crypto.createHash('sha1').update(certBase64).digest('hex');

    // Generate timestamps (Unix timestamp in seconds)
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 5 * 60; // 5 minutes validity

    const header = { typ: 'JWT', alg: 'RS256', x5c: [certBase64] };
    const payload = { username, iat, exp };

    const headerEncoded = base64Url(Buffer.from(JSON.stringify(header)));
    const payloadEncoded = base64Url(Buffer.from(JSON.stringify(payload)));
    const signatureInput = `${headerEncoded}.${payloadEncoded}`;

    // Sign with RS256 (RSA with SHA-256)
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signatureInput), {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    });

    return `${signatureInput}.${base64Url(signature)}`;
  } catch (error) {
    strapi.log.error('[face-queue] Error generating JWT:', error.message);
    throw new Error(`Failed to generate FACe JWT: ${error.message}`, { cause: error });
  }
};

module.exports = { generateFaceJWT };
