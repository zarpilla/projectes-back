'use strict';

/**
 * Sign Facturae XML with XAdES-BES signature (ported verbatim from v3
 * api/face-queue/services/sign-facturae.js — pure Node, no Strapi APIs).
 * Uses xadesjs (built on xmldsigjs) which produces W3C-standard XAdES signatures
 * cryptographically verifiable by xmlsec1 and any compliant verifier (incl. FACe).
 */

const fs = require('fs');
const forge = require('node-forge');
const xadesjs = require('xadesjs');
const { Crypto } = require('@peculiar/webcrypto');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

// Initialize once at module load
xadesjs.Application.setEngine('NodeJS', new Crypto());
xadesjs.setNodeDependencies({ DOMParser, XMLSerializer });
const xmldsigXmlCore = require(require.resolve('xml-core', { paths: [require.resolve('xmldsigjs')] }));
xmldsigXmlCore.setNodeDependencies({ DOMParser, XMLSerializer });

// Monkey-patch XadesDateTime to serialize with `+HH:MM` timezone (no milliseconds, with colon)
// instead of toISOString() (milliseconds + Z) or `o` token (`+0200` without colon).
xadesjs.xml.XadesDateTime.prototype.OnGetXml = function (e) {
  const d = this.Value;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(offMin) / 60));
  const om = pad(Math.abs(offMin) % 60);
  e.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
};

const signFacturaeXml = async (xml, certificatePath, certificatePassword) => {
  try {
    // 1. Load certificate
    const p12Buffer = fs.readFileSync(certificatePath);
    const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, certificatePassword || '');

    const cert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag][0].cert;
    const privKey = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag][0].key;

    // 2. Extract cert and key for WebCrypto
    const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const certBase64 = forge.util.encode64(certDer);

    const pkcs8Der = forge.asn1.toDer(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(privKey))).getBytes();
    const pkcs8Buffer = Buffer.from(pkcs8Der, 'binary');

    const spkiDer = forge.asn1.toDer(forge.pki.publicKeyToAsn1(cert.publicKey)).getBytes();
    const spkiBuffer = Buffer.from(spkiDer, 'binary');

    const crypto = new Crypto();
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8', pkcs8Buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
      false, ['sign']
    );
    const pubKey = await crypto.subtle.importKey(
      'spki', spkiBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
      true, ['verify']
    );

    // 3. IDs
    const ts = Date.now();
    const sigId = `Signature-${ts}`;
    const keyInfoId = `${sigId}-KeyInfo`;
    const refDocId = `Reference-${ts}`;

    // 4. Parse and sign
    const doc = xadesjs.Parse(xml);

    // Subclass to:
    //  - set KeyInfo Id BEFORE DigestReferences runs
    //  - fix IssuerName to RFC 4514 MSB-first format (CN=...,OU=...,O=...,C=ES)
    //  - add SignedDataObjectProperties/DataObjectFormat as Facturae requires
    const reverseIssuer = (issuer) => {
      // xadesjs/pkijs outputs "C=ES, O=FNMT-RCM, OU=Ceres, CN=AC FNMT Usuarios"
      // FACe expects RFC 4514 MSB-first, no spaces around commas
      return issuer
        .split(/,\s*/)
        .reverse()
        .join(',');
    };
    class FacturaeSignedXml extends xadesjs.SignedXml {
      async ApplySignOptions(signature, algorithm, key, options) {
        await super.ApplySignOptions(signature, algorithm, key, options);
        if (signature.KeyInfo) signature.KeyInfo.Id = keyInfoId;
        const qp = this.Properties;
        // Fix Target / SignedProperties.Id to match Signature.Id (xadesjs constructor
        // assigns random ids before our options.id is applied)
        if (qp) {
          qp.Target = `#${signature.Id}`;
          if (qp.SignedProperties) {
            qp.SignedProperties.Id = `${signature.Id}-SignedProperties`;
          }
        }
        const ssp = qp && qp.SignedProperties && qp.SignedProperties.SignedSignatureProperties;
        if (ssp && ssp.SigningCertificate && ssp.SigningCertificate.Count) {
          const sc = ssp.SigningCertificate.Item(0);
          sc.IssuerSerial.X509IssuerName = reverseIssuer(sc.IssuerSerial.X509IssuerName);
        }
        const sp = qp && qp.SignedProperties;
        if (sp) {
          const sdop = new xadesjs.xml.SignedDataObjectProperties();
          const dof = new xadesjs.xml.DataObjectFormat();
          dof.ObjectReference = `#${refDocId}`;
          dof.MimeType = 'text/xml';
          dof.Encoding = 'UTF-8';
          const oid = new xadesjs.xml.ObjectIdentifier();
          oid.Identifier = new xadesjs.xml.Identifier();
          oid.Identifier.Qualifier = 'OIDAsURN';
          oid.Identifier.Value = 'urn:oid:1.2.840.10003.5.109.10';
          dof.ObjectIdentifier = oid;
          sdop.DataObjectFormats.Add(dof);
          sp.SignedDataObjectProperties = sdop;
        }
        // SignedProperties Reference URI was set during super using the OLD id; fix it
        if (qp && qp.SignedProperties) {
          const refs = signature.SignedInfo.References;
          for (let i = 0; i < refs.Count; i++) {
            const r = refs.Item(i);
            if (r && r.Type && /SignedProperties$/.test(r.Type)) {
              r.Uri = `#${qp.SignedProperties.Id}`;
            }
          }
        }
      }
    }

    const signedXml = new FacturaeSignedXml();
    await signedXml.Sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      cryptoKey,
      doc,
      {
        id: sigId,
        keyValue: pubKey,
        x509: [certBase64],
        references: [
          { id: refDocId, uri: '', hash: 'SHA-1', transforms: ['enveloped'] },
          { uri: `#${keyInfoId}`, hash: 'SHA-1' },
        ],
        signingCertificate: { certificate: certBase64, digestAlgorithm: 'SHA-1' },
        signingTime: { value: new Date() },
        policy: {
          identifier: {
            value: 'http://www.facturae.es/politica_de_firma_formato_facturae/politica_de_firma_formato_facturae_v3_1.pdf',
            description: 'Facturación electrónica con formato Facturae',
          },
          hash: 'SHA-1',
          digestValue: 'Ohixl6upD6av8N7pEvDABhEL6hM=',
          qualifiers: [
            'http://www.facturae.es/politica_de_firma_formato_facturae/politica_de_firma_formato_facturae_v3_1.pdf',
          ],
        },
        signerRole: {
          claimed: ['emisor'],
        },
      }
    );

    // 5. Append signature to the document root and serialize
    const sigEl = signedXml.GetXml();
    doc.documentElement.appendChild(sigEl);

    const serialized = new XMLSerializer().serializeToString(doc);
    // Ensure single XML declaration
    const clean = serialized.replace(/^<\?xml[^>]*\?>\s*/, '');
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + clean;
  } catch (error) {
    console.error('Signature error details:', error);
    throw new Error(`Failed to sign Facturae XML: ${error.message}`, { cause: error });
  }
};

module.exports = {
  signFacturaeXml
};
