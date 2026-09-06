'use strict';
/* global strapi */

/**
 * verifactu-chain lifecycles (v5). Ported from v3 api/verifactu-chain/models/verifactu-chain.js.
 * sendVerifactu: builds the signed VeriFactu invoice (verifactu-node-lib), chains to the
 * previous OK hash, posts to AEAT, updates chain state + QR on the invoice.
 */
const fs = require('fs');
const axios = require('axios');
const https = require('https');
const path = require('path');
const { createVerifactuInvoice } = require('verifactu-node-lib');
const _ = require('lodash');
// A plain Error from a lifecycle surfaces as a bare 500 'Internal Server Error',
// so the rule that rejected the write never reaches the user. ApplicationError
// answers 400 with the message, which the views already display.
const { errors: { ApplicationError } } = require('@strapi/utils');

const sendVerifactu = async () => {
  const me = await strapi.db.query('api::me.me').findOne();
  const verifactu = await strapi.documents('api::verifactu.verifactu').findFirst({
    populate: { certificate: true },
  });

  if (verifactu && (verifactu.mode === 'test' || verifactu.mode === 'real')) {
    const pendingInvoices = await strapi.db.query('api::verifactu-chain.verifactu-chain').findMany({
      where: { state: { $in: ['ko', 'pending', 'okwitherrors'] }, mode: verifactu.mode },
      orderBy: { id: 'asc' },
      populate: { emitted_invoice: { populate: { lines: true } } },
    });
    // const okInvoices = await strapi.db.query('api::verifactu-chain.verifactu-chain').findMany({ where: { //   state: "ok", //   _limit: 1, //   _sort: "id:desc", // } });

    const software = {
      developerName: verifactu.software_developerName,
      developerIrsId: verifactu.software_developerIrsId,
      name: verifactu.software_name,
      id: verifactu.software_id,
      version: verifactu.software_version,
      number: verifactu.software_number,
      useOnlyVerifactu: verifactu.software_useOnlyVerifactu,
      useMulti: verifactu.software_useMulti,
      useCurrentMulti: verifactu.software_useCurrentMulti,
    };

    for await (const invoice of pendingInvoices) {
      const okInvoices = await strapi.db
        .query('api::verifactu-chain.verifactu-chain')
        .findMany({
          where: { state: 'ok', mode: verifactu.mode },
          orderBy: { id: 'desc' },
          populate: { emitted_invoice: true },
        });
      const previousId = okInvoices.find((inv) => inv.id < invoice.id);
      const contact = await strapi.db
        .query('api::contact.contact')
        .findOne({ where: { id: invoice.emitted_invoice.contact } });
      let previousInvoice = previousId
        ? {
            issuerIrsId: me.nif,
            number: previousId.emitted_invoice.code,
            issuedTime: new Date(previousId.emitted_invoice.createdAt),
            hash: previousId.hash,
          }
        : null;

      const notSpain = contact.country && contact.country.length === 2 && contact.country !== 'ES';

      const serial = await strapi.db
        .query('api::serie.serie')
        .findOne({ where: { id: invoice.emitted_invoice.serial } });

      const recipient =
        contact.country && contact.country.length === 2
          ? {
              name: contact.name,
              country: contact.country,
              id: contact.nif,
              idType: '04',
            }
          : {
              irsId: contact.nif,
              name: contact.name,
              country: 'ES',
            };

      const invoiceForVerifactu = {
        issuer: {
          irsId: me.nif,
          name: me.name,
        },
        recipient: recipient,
        id: {
          number: invoice.emitted_invoice.code,
          issuedTime: new Date(invoice.emitted_invoice.createdAt),
          replacement: invoice.actions === 'replacement',
        },
        type: serial.rectificative ? 'R1' : 'F1',
        description: {
          text: 'Factura ' + invoice.emitted_invoice.code,
          operationDate: new Date(invoice.emitted_invoice.createdAt),
        },
        vatLines: (() => {
          // First, create all individual VAT lines with precise calculations
          const allVatLines = invoice.emitted_invoice.lines.map((line) => {
            const baseAmount = line.base * line.quantity * (1 - (line.discount || 0) / 100);
            // Use the original line's VAT calculation method to maintain consistency
            const vatAmount = line.vat_amount || baseAmount * (line.vat ? line.vat / 100 : 0);

            return {
              vatOperation: line.vat ? 'S1' : notSpain ? 'N2' : 'N1',
              base: baseAmount,
              rate: line.vat || 0,
              //rate2: 0,
              amount: vatAmount,
              //amount2: 0,
              vatKey: line.vat ? '01' : notSpain ? '02' : '01',
            };
          });

          // Group by vatOperation, vatKey, and rate using lodash
          const groupedLines = _.chain(allVatLines)
            .groupBy((line) => `${line.vatOperation}-${line.vatKey}-${line.rate}`)
            .mapValues((group) => ({
              vatOperation: group[0].vatOperation,
              vatKey: group[0].vatKey,
              rate: group[0].rate,
              //rate2: group[0].rate2,
              base: _.sumBy(group, 'base'),
              amount: _.sumBy(group, 'amount'),
              amount2: _.sumBy(group, 'amount2'),
            }))
            .values()
            .value();

          // Round the final grouped amounts to 2 decimal places
          const result = groupedLines.map((line) => ({
            ...line,
            base: Math.round(line.base * 100) / 100,
            amount: Math.round(line.amount * 100) / 100,
            //amount2: Math.round(line.amount2 * 100) / 100,
          }));

          // Verify that the sum matches the original total_vat
          const calculatedVatTotal = _.sumBy(result, 'amount');
          const originalVatTotal = invoice.emitted_invoice.total_vat;

          if (Math.abs(calculatedVatTotal - originalVatTotal) > 0.01) {
            console.warn(
              `VAT total mismatch: calculated ${calculatedVatTotal}, original ${originalVatTotal}`,
            );

            // Adjust the largest VAT line to match the original total
            if (result.length > 0) {
              const largestVatLine = _.maxBy(result, 'amount');
              const difference = originalVatTotal - calculatedVatTotal;
              largestVatLine.amount = Math.round((largestVatLine.amount + difference) * 100) / 100;
            }
          }

          // console.log("groupedLines", result);
          // console.log("Original total_vat:", originalVatTotal);
          // console.log("Calculated total_vat:", _.sumBy(result, "amount"));

          return result;
        })(),
        total: invoice.emitted_invoice.total_base + invoice.emitted_invoice.total_vat,
        amount: invoice.emitted_invoice.total_vat,
      };
      //

      const result = await createVerifactuInvoice(
        invoiceForVerifactu,
        software,
        previousInvoice,
        {},
        verifactu.mode === 'test',
      );

      const qr = result.qrcode;
      const hash = result.hash;
      const xml64 = result.verifactuXml;
      const xml = Buffer.from(xml64, 'base64').toString('utf8');
      const wsld = result.wsld;
      const endpoint = result.endpoint;

      // console.log("result", xml);

      // break; // For testing, remove this line to process all invoices

      await strapi.db.query('api::verifactu-chain.verifactu-chain').update({
        where: { id: invoice.id },
        data: {
          //state: "ok",
          qr,
          hash,
          xml,
          request_url: endpoint,
        },
      });

      const certificateRelativePath = verifactu.certificate ? verifactu.certificate.url : '';
      const certificatePassphrase = verifactu.certificate_password || '';

      try {
        const soapResponse = await sendToAEAT(xml, endpoint, certificateRelativePath, certificatePassphrase);

        if (
          soapResponse.statusCode === 200 &&
          soapResponse.body &&
          soapResponse.body.includes('EstadoEnvio>Correcto<')
        ) {
          await strapi.db.query('api::verifactu-chain.verifactu-chain').update({
            where: { id: invoice.id },
            data: {
              response_text: soapResponse.body,
              state: 'ok',
              actions: 'none',
            },
          });

          await updateInvoiceQr(invoice.emitted_invoice.id, qr);
        } else if (
          soapResponse.statusCode === 200 &&
          soapResponse.body &&
          soapResponse.body.includes('>AceptadaConErrores<')
        ) {
          await strapi.db.query('api::verifactu-chain.verifactu-chain').update({
            where: { id: invoice.id },
            data: {
              response_text: soapResponse.body,
              state: 'okwitherrors',
              actions: 'none',
            },
          });

          await updateInvoiceQr(invoice.emitted_invoice.id, qr);
        } else {
          await strapi.db.query('api::verifactu-chain.verifactu-chain').update({
            where: { id: invoice.id },
            data: {
              response_text: soapResponse.body,
              state: 'ko',
              actions: 'none',
            },
          });

          break;
        }
      } catch (error) {
        console.error('Error sending to AEAT:', error);
      }
    }
  }
};

const sendToAEAT = async (xml, endpoint, certificateRelativePath, certificatePassphrase) => {
  try {
    // Read certificate file
    if (!certificateRelativePath) {
      throw new ApplicationError('Certificate relative path is required.');
    }
    const certificatePath = path.join(strapi.dirs.static.public, certificateRelativePath);

    if (!certificatePath || !fs.existsSync(certificatePath)) {
      throw new ApplicationError(`Certificate file not found: ${certificatePath}`);
    }

    const pfx = fs.readFileSync(certificatePath);

    // Create HTTPS agent with PFX certificate
    const httpsAgent = new https.Agent({
      pfx: pfx,
      passphrase: certificatePassphrase || undefined,
      rejectUnauthorized: false,
      requestCert: true,
      agent: false,
    });

    const config = {
      method: 'POST',
      url: endpoint,
      data: xml.trim(),
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '""',
        'User-Agent': 'VeriFacTu-Client/1.0',
      },
      httpsAgent: httpsAgent,
      timeout: 30000, // 30 seconds timeout
    };

    const response = await axios(config);

    // console.log("Response status:", response.status);
    // console.log("Response data:", response.data);

    return { statusCode: response.status, body: response.data };
  } catch (error) {
    console.error('sendToAEAT error:', error.response || error);
    throw error;
  }
};

const updateInvoiceQr = async (invoiceId, qrCode) => {
  try {
    await strapi.db
      .query('api::emitted-invoice.emitted-invoice')
      .update({ where: { id: invoiceId }, data: { qr: qrCode } });
  } catch (error) {
    console.error('Error updating invoice QR code:', error);
  }
};

module.exports = {
  // },
  async beforeCreate(event) {},
  async afterCreate(event) {
    await sendVerifactu();
  },
  async beforeUpdate(event) {},
  async afterUpdate(event) {
    const data = event.params.data || {};
    if (data && data._internal && data._internal === true) {
      return;
    }
    await sendVerifactu();
  },
  async beforeDelete(event) {},
};
