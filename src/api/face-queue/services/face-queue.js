'use strict';
/* global strapi */

/**
 * face-queue service (v5). Full port of v3 api/face-queue/services/face-queue.js
 * (FACe submission pipeline) plus the two cron handlers that lived in
 * v3 api/face-queue/cron/{check-status,retry-pending}.js.
 *
 * v5 data-access conversions:
 *  - strapi.query(...).findOne/find/update -> strapi.db.query(...) (lifecycle-free,
 *    so the v3 `_internal` flag is no longer needed on internal updates)
 *  - `me` single-type -> strapi.documents('api::me.me').findFirst()
 *  - strapi.config.paths.static -> strapi.dirs.static.public
 *  - created_at -> createdAt
 * The XML builders, JWT generation and XAdES signing are ported verbatim
 * (pure functions, no Strapi APIs). v3's fakeSendToFace helper was dead code
 * referencing undefined globals and is intentionally not ported.
 */

const fs = require('fs');
const axios = require('axios');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { signFacturaeXml } = require('../utils/sign-facturae');

const { createCoreService } = require('@strapi/strapi').factories;

const FACE_QUEUE_UID = 'api::face-queue.face-queue';
const EMITTED_INVOICE_UID = 'api::emitted-invoice.emitted-invoice';
const ME_UID = 'api::me.me';
const CONTACT_UID = 'api::contact.contact';

/**
 * Generate JWT token for FACe API authentication
 * According to FACe API manual: JWT signed with JWS (RS256), valid for 5 minutes
 * Manual: /home/jordi/Documents/work/webcoop/face/FACe - Manual de API de Proveedores.pdf (page 7)
 */
const generateFaceJWT = (certificatePath, certificatePassword) => {
  try {
    // Extract private key and certificate from PFX using OpenSSL commands
    // We need to convert PFX to PEM format to extract the public certificate
    const tmpCertPath = `/tmp/face_cert_${Date.now()}.pem`;
    const tmpKeyPath = `/tmp/face_key_${Date.now()}.pem`;

    try {
      // Extract certificate (public part) - only client cert, no chain
      execSync(`openssl pkcs12 -in "${certificatePath}" -clcerts -nokeys -out "${tmpCertPath}" -passin pass:"${certificatePassword || ''}"`);

      // Extract private key
      execSync(`openssl pkcs12 -in "${certificatePath}" -nocerts -nodes -out "${tmpKeyPath}" -passin pass:"${certificatePassword || ''}"`);

      // Read the extracted PEM certificate
      let certPem = fs.readFileSync(tmpCertPath, 'utf8');

      // Extract ONLY the certificate part (between BEGIN and END CERTIFICATE)
      // OpenSSL output may include Bag Attributes and other info we don't want
      const certMatch = certPem.match(/-----BEGIN CERTIFICATE-----\s*([\s\S]+?)\s*-----END CERTIFICATE-----/);
      if (!certMatch) {
        throw new Error('Could not extract certificate from PFX');
      }

      // Clean PEM: remove all whitespace and newlines
      const pemCleaned = certMatch[1]
        .replace(/\s/g, '')  // Remove ALL whitespace (spaces, tabs, newlines)
        .trim();

      // Calculate SHA1 hash of the cleaned PEM for username
      const username = crypto.createHash('sha1').update(pemCleaned).digest('hex');

      // Generate timestamps (Unix timestamp in seconds)
      const now = Math.floor(Date.now() / 1000);
      const iat = now;
      const exp = now + (5 * 60); // 5 minutes validity

      // Build JWT Header
      const header = {
        typ: "JWT",
        alg: "RS256",
        x5c: [pemCleaned]
      };

      // Build JWT Payload
      const payload = {
        username: username,
        iat: iat,
        exp: exp
      };

      // Encode header and payload in base64url
      const base64UrlEncode = (obj) => {
        const json = JSON.stringify(obj);
        return Buffer.from(json)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=/g, '');
      };

      const headerEncoded = base64UrlEncode(header);
      const payloadEncoded = base64UrlEncode(payload);

      // Create the signature input
      const signatureInput = `${headerEncoded}.${payloadEncoded}`;

      // Read private key
      let privateKeyPem = fs.readFileSync(tmpKeyPath, 'utf8');

      // Extract only the private key part (OpenSSL may include Bag Attributes)
      const keyMatch = privateKeyPem.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/);
      const rsaKeyMatch = privateKeyPem.match(/-----BEGIN RSA PRIVATE KEY-----[\s\S]+?-----END RSA PRIVATE KEY-----/);

      let privateKey;
      if (keyMatch) {
        privateKey = keyMatch[0];
      } else if (rsaKeyMatch) {
        privateKey = rsaKeyMatch[0];
      } else {
        throw new Error('Could not extract private key from PFX');
      }

      // Sign with RS256 (RSA with SHA-256)
      const signature = crypto.sign('RSA-SHA256', Buffer.from(signatureInput), {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PADDING
      });

      // Encode signature in base64url
      const signatureEncoded = signature
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      // Construct the final JWT
      const jwt = `${headerEncoded}.${payloadEncoded}.${signatureEncoded}`;

      // Clean up temporary files
      fs.unlinkSync(tmpCertPath);
      fs.unlinkSync(tmpKeyPath);

      return jwt;

    } catch (execError) {
      // Clean up temp files if they exist
      try { if (fs.existsSync(tmpCertPath)) fs.unlinkSync(tmpCertPath); } catch { /* noop */ }
      try { if (fs.existsSync(tmpKeyPath)) fs.unlinkSync(tmpKeyPath); } catch { /* noop */ }
      throw execError;
    }

  } catch (error) {
    strapi.log.error("[face-queue] Error generating JWT:", error.message);
    throw new Error(`Failed to generate FACe JWT: ${error.message}`, { cause: error });
  }
};

const toNumber = (value) => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (value) => Math.round(toNumber(value) * 100) / 100;

const formatAmount = (value) => round2(value).toFixed(2);

const escapeXml = (value) =>
  String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const formatDate = (value) => {
  if (!value) {
    return new Date().toISOString().substring(0, 10);
  }

  if (typeof value === "string") {
    return value.substring(0, 10);
  }

  return new Date(value).toISOString().substring(0, 10);
};

const getInvoiceLineAmounts = (line) => {
  const quantity = toNumber(line.quantity || 1);
  const base = toNumber(line.base);
  const discount = toNumber(line.discount);
  const vat = toNumber(line.vat);

  const extension = round2(base * quantity * (1 - discount / 100));
  const vatAmount = round2(extension * (vat / 100));

  return {
    quantity,
    base,
    vat,
    extension,
    vatAmount,
  };
};

/**
 * Build Facturae 3.2 XML invoice
 */
const buildFacturaeInvoiceXml = ({ invoice, me, contact, dir3, bankAccount }) => {
  const issueDate = formatDate(invoice.emitted || invoice.createdAt);
  const dueDate = invoice.paybefore ? formatDate(invoice.paybefore) : null;
  const invoiceId = invoice.code || `INV-${invoice.id}`;
  const lines = Array.isArray(invoice.lines) ? invoice.lines : [];

  const supplierName = me && me.name ? me.name : "";
  const supplierNif = me && me.nif ? me.nif : "";
  const supplierAddress = me && me.address ? me.address : "";
  const supplierCity = me && me.city ? me.city : "";
  const supplierPostcode = me && me.postcode ? me.postcode : "";
  const supplierProvince = me && me.state ? me.state : "";

  const customerName =
    (contact && contact.name) ||
    (invoice.contact_info && invoice.contact_info.name) ||
    "";
  const customerNif =
    (contact && contact.nif) ||
    (invoice.contact_info && invoice.contact_info.nif) ||
    "";
  const customerAddress =
    (contact && contact.address) ||
    (invoice.contact_info && invoice.contact_info.address) ||
    "";
  const customerCity =
    (contact && contact.city) ||
    (invoice.contact_info && invoice.contact_info.city) ||
    "";
  const customerPostcode =
    (contact && contact.postcode) ||
    (invoice.contact_info && invoice.contact_info.postcode) ||
    "";
  const customerProvince =
    (contact && contact.state) ||
    (invoice.contact_info && invoice.contact_info.state) ||
    "";
  const dir3Oc = dir3 && dir3.oc ? dir3.oc : "";
  const dir3Og = dir3 && dir3.og ? dir3.og : "";
  const dir3Ut = dir3 && dir3.ut ? dir3.ut : "";

  // Check if this is a rectificative invoice
  const isRectificative = invoice.serial && invoice.serial.rectificative === true;

  let totalBase = 0;
  let totalVat = 0;

  // Determine person type (F=física, J=jurídica)
  const supplierPersonType = supplierNif && supplierNif.match(/^[0-9]{8}[A-Z]$/) ? "F" : "J";
  const customerPersonType = customerNif && customerNif.match(/^[0-9]{8}[A-Z]$/) ? "F" : "J";

  // Split supplier name for physical person
  let supplierFirstName = "", supplierFirstSurname = "", supplierSecondSurname = "";
  if (supplierPersonType === "F") {
    const nameParts = supplierName.split(" ");
    if (nameParts.length >= 3) {
      supplierFirstName = nameParts[0];
      supplierFirstSurname = nameParts[1];
      supplierSecondSurname = nameParts.slice(2).join(" ");
    } else if (nameParts.length === 2) {
      supplierFirstName = nameParts[0];
      supplierFirstSurname = nameParts[1];
    } else {
      supplierFirstName = supplierName;
    }
  }

  const invoiceLinesXml = lines
    .map((line, index) => {
      const { quantity, base, vat, extension, vatAmount } = getInvoiceLineAmounts(line);

      totalBase += extension;
      totalVat += vatAmount;

      const itemName = line.concept || `Línia ${index + 1}`;

      return [
        "                <InvoiceLine>",
        `                    <ItemDescription>${escapeXml(itemName)}</ItemDescription>`,
        `                    <Quantity>${formatAmount(quantity)}</Quantity>`,
        "                    <UnitOfMeasure>01</UnitOfMeasure>",
        `                    <UnitPriceWithoutTax>${base.toFixed(6)}</UnitPriceWithoutTax>`,
        `                    <TotalCost>${extension.toFixed(6)}</TotalCost>`,
        `                    <GrossAmount>${extension.toFixed(6)}</GrossAmount>`,
        "                    <TaxesOutputs>",
        "                        <Tax>",
        "                            <TaxTypeCode>01</TaxTypeCode>",
        `                            <TaxRate>${formatAmount(vat)}</TaxRate>`,
        "                            <TaxableBase>",
        `                                <TotalAmount>${formatAmount(extension)}</TotalAmount>`,
        "                            </TaxableBase>",
        "                            <TaxAmount>",
        `                                <TotalAmount>${formatAmount(vatAmount)}</TotalAmount>`,
        "                            </TaxAmount>",
        "                        </Tax>",
        "                    </TaxesOutputs>",
        "                </InvoiceLine>",
      ].join("\n");
    })
    .join("\n");

  totalBase = round2(totalBase);
  totalVat = round2(totalVat);
  const totalInvoice = round2(totalBase + totalVat);

  // Generate batch ID from invoice id
  const batchId = `LOTE${invoiceId.replace(/[^A-Z0-9]/gi, "")}`;

  const xmlParts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<facturae:Facturae xmlns:facturae="http://www.facturae.es/Facturae/2009/v3.2/Facturae">',
    "    <FileHeader>",
    "        <SchemaVersion>3.2</SchemaVersion>",
    "        <Modality>I</Modality>",
    "        <InvoiceIssuerType>EM</InvoiceIssuerType>",
    "        <Batch>",
    `            <BatchIdentifier>${escapeXml(batchId)}</BatchIdentifier>`,
    "            <InvoicesCount>1</InvoicesCount>",
    "            <TotalInvoicesAmount>",
    `                <TotalAmount>${formatAmount(totalInvoice)}</TotalAmount>`,
    "            </TotalInvoicesAmount>",
    "            <TotalOutstandingAmount>",
    `                <TotalAmount>${formatAmount(totalInvoice)}</TotalAmount>`,
    "            </TotalOutstandingAmount>",
    "            <TotalExecutableAmount>",
    `                <TotalAmount>${formatAmount(totalInvoice)}</TotalAmount>`,
    "            </TotalExecutableAmount>",
    "            <InvoiceCurrencyCode>EUR</InvoiceCurrencyCode>",
    "        </Batch>",
    "    </FileHeader>",
    "    <Parties>",
    "        <SellerParty>",
    "            <TaxIdentification>",
    `                <PersonTypeCode>${supplierPersonType}</PersonTypeCode>`,
    `                <ResidenceTypeCode>R</ResidenceTypeCode>`,
    `                <TaxIdentificationNumber>${escapeXml(supplierNif)}</TaxIdentificationNumber>`,
    "            </TaxIdentification>",
  ];

  // Supplier: Individual or LegalEntity
  if (supplierPersonType === "F") {
    xmlParts.push(
      "            <Individual>",
      `                <Name>${escapeXml(supplierFirstName)}</Name>`,
      `                <FirstSurname>${escapeXml(supplierFirstSurname)}</FirstSurname>`,
      ...(supplierSecondSurname ? [`                <SecondSurname>${escapeXml(supplierSecondSurname)}</SecondSurname>`] : []),
      "                <AddressInSpain>",
      `                    <Address>${escapeXml(supplierAddress)}</Address>`,
      `                    <PostCode>${escapeXml(supplierPostcode)}</PostCode>`,
      `                    <Town>${escapeXml(supplierCity)}</Town>`,
      `                    <Province>${escapeXml(supplierProvince)}</Province>`,
      "                    <CountryCode>ESP</CountryCode>",
      "                </AddressInSpain>",
      "            </Individual>"
    );
  } else {
    xmlParts.push(
      "            <LegalEntity>",
      `                <CorporateName>${escapeXml(supplierName)}</CorporateName>`,
      "                <AddressInSpain>",
      `                <Address>${escapeXml(supplierAddress)}</Address>`,
      `                <PostCode>${escapeXml(supplierPostcode)}</PostCode>`,
      `                <Town>${escapeXml(supplierCity)}</Town>`,
      `                <Province>${escapeXml(supplierProvince)}</Province>`,
      "                <CountryCode>ESP</CountryCode>",
      "                </AddressInSpain>",
      "            </LegalEntity>"
    );
  }

  // Generate Corrective section for rectificative invoices
  let correctiveDetailsXml = [];
  if (isRectificative) {
    const rectified = invoice.rectified_invoice;
    if (rectified) {
      const reasonCode = invoice.rectification_reason_code || "80";
      // Map reason code to valid ReasonDescription from Facturae enum
      const reasonDescriptionMap = {
        "80": "Base imponible modificada cuotas repercutidas no satisfechas. Auto de declaración de concurso",
        "01": "Número de la factura",
        "02": "Serie de la factura",
        "03": "Fecha expedición",
        "04": "Nombre y apellidos/Razón Social-Emisor",
        "05": "Nombre y apellidos/Razón Social-Receptor",
        "06": "Identificación fiscal Emisor/obligado",
        "07": "Identificación fiscal Receptor",
        "08": "Domicilio Emisor/Obligado",
        "09": "Domicilio Receptor",
        "10": "Detalle Operación",
        "11": "Porcentaje impositivo a aplicar",
        "12": "Cuota tributaria a aplicar",
        "13": "Fecha/Periodo a aplicar",
        "14": "Clase de factura",
        "15": "Literales legales",
        "16": "Base imponible",
        "81": "Base imponible modificada por devolución de envases / embalajes",
        "82": "Base imponible modificada por descuentos y bonificaciones",
        "83": "Base imponible modificada por resolución firme, judicial o administrativa"
      };
      const reasonDescription = reasonDescriptionMap[reasonCode] || reasonDescriptionMap["80"];
      const correctionMethod = invoice.rectification_method_code || "01";
      const correctionMethodDescriptionMap = {
        "01": "Rectificación íntegra",
        "02": "Rectificación por diferencias",
        "03": "Rectificación por descuento por volumen de operaciones durante un periodo",
        "04": "Autorizadas por la Agencia Tributaria"
      };
      const correctionMethodDescription = correctionMethodDescriptionMap[correctionMethod] || correctionMethodDescriptionMap["01"];

      const rectifiedDate = formatDate(rectified.emitted || rectified.createdAt);
      const rectifiedYear = rectifiedDate.substring(0, 4);
      const rectifiedMonth = rectifiedDate.substring(5, 7);
      const rectifiedInvoiceNumber = rectified.code || `INV-${rectified.id}`;
      const rectifiedSeriesCode = rectified.serial && rectified.serial.name ? rectified.serial.name : "";

      correctiveDetailsXml = [
        "                <Corrective>",
        `                    <InvoiceNumber>${escapeXml(rectifiedInvoiceNumber)}</InvoiceNumber>`,
        ...(rectifiedSeriesCode ? [`                    <InvoiceSeriesCode>${escapeXml(rectifiedSeriesCode)}</InvoiceSeriesCode>`] : []),
        `                    <ReasonCode>${escapeXml(reasonCode)}</ReasonCode>`,
        `                    <ReasonDescription>${escapeXml(reasonDescription)}</ReasonDescription>`,
        "                    <TaxPeriod>",
        `                        <StartDate>${rectifiedYear}-${rectifiedMonth}-01</StartDate>`,
        `                        <EndDate>${rectifiedDate}</EndDate>`,
        "                    </TaxPeriod>",
        `                    <CorrectionMethod>${escapeXml(correctionMethod)}</CorrectionMethod>`,
        `                    <CorrectionMethodDescription>${escapeXml(correctionMethodDescription)}</CorrectionMethodDescription>`,
        "                </Corrective>"
      ];
    }
  }

  xmlParts.push(
    "        </SellerParty>",
    "        <BuyerParty>",
    "            <TaxIdentification>",
    `                <PersonTypeCode>${customerPersonType}</PersonTypeCode>`,
    `                <ResidenceTypeCode>R</ResidenceTypeCode>`,
    `                <TaxIdentificationNumber>${escapeXml(customerNif)}</TaxIdentificationNumber>`,
    "            </TaxIdentification>"
  );

  // DIR3 codes as AdministrativeCentres (only for public administration)
  const adminCentreAddress = [
    "                    <AddressInSpain>",
    `                        <Address>${escapeXml(customerAddress)}</Address>`,
    `                        <PostCode>${escapeXml(customerPostcode)}</PostCode>`,
    `                        <Town>${escapeXml(customerCity)}</Town>`,
    `                        <Province>${escapeXml(customerProvince)}</Province>`,
    "                        <CountryCode>ESP</CountryCode>",
    "                    </AddressInSpain>",
  ];
  if (dir3Oc || dir3Og || dir3Ut) {
    xmlParts.push("            <AdministrativeCentres>");
    if (dir3Oc) {
      xmlParts.push(
        "                <AdministrativeCentre>",
        `                    <CentreCode>${escapeXml(dir3Oc)}</CentreCode>`,
        "                    <RoleTypeCode>01</RoleTypeCode>",
        `                    <Name>${escapeXml(customerName)}</Name>`,
        ...adminCentreAddress,
        "                </AdministrativeCentre>"
      );
    }
    if (dir3Og) {
      xmlParts.push(
        "                <AdministrativeCentre>",
        `                    <CentreCode>${escapeXml(dir3Og)}</CentreCode>`,
        "                    <RoleTypeCode>02</RoleTypeCode>",
        `                    <Name>${escapeXml(customerName)}</Name>`,
        ...adminCentreAddress,
        "                </AdministrativeCentre>"
      );
    }
    if (dir3Ut) {
      xmlParts.push(
        "                <AdministrativeCentre>",
        `                    <CentreCode>${escapeXml(dir3Ut)}</CentreCode>`,
        "                    <RoleTypeCode>03</RoleTypeCode>",
        `                    <Name>${escapeXml(customerName)}</Name>`,
        ...adminCentreAddress,
        "                </AdministrativeCentre>"
      );
    }
    xmlParts.push("            </AdministrativeCentres>");
  }

  xmlParts.push(
    "            <LegalEntity>",
    `                <CorporateName>${escapeXml(customerName)}</CorporateName>`,
    "                <AddressInSpain>",
    `                <Address>${escapeXml(customerAddress)}</Address>`,
    `                <PostCode>${escapeXml(customerPostcode)}</PostCode>`,
    `                <Town>${escapeXml(customerCity)}</Town>`,
    `                <Province>${escapeXml(customerProvince)}</Province>`,
    "                <CountryCode>ESP</CountryCode>",
    "            </AddressInSpain>",
    "            </LegalEntity>",
    "        </BuyerParty>",
    "    </Parties>",
    "    <Invoices>",
    "        <Invoice>",
    "            <InvoiceHeader>",
    `                <InvoiceNumber>${escapeXml(invoiceId)}</InvoiceNumber>`,
    "                <InvoiceDocumentType>FC</InvoiceDocumentType>",
    `                <InvoiceClass>${isRectificative ? "OR" : "OO"}</InvoiceClass>`,
    ...correctiveDetailsXml,
    "            </InvoiceHeader>",
    "            <InvoiceIssueData>",
    `                <IssueDate>${issueDate}</IssueDate>`,
    "                <InvoiceCurrencyCode>EUR</InvoiceCurrencyCode>",
    "                <TaxCurrencyCode>EUR</TaxCurrencyCode>",
    "                <LanguageName>es</LanguageName>",
    "            </InvoiceIssueData>",
    "            <TaxesOutputs>",
    "                <Tax>",
    "                    <TaxTypeCode>01</TaxTypeCode>",
    `                    <TaxRate>${formatAmount(totalBase > 0 ? round2((totalVat / totalBase) * 100) : 21)}</TaxRate>`,
    "                    <TaxableBase>",
    `                        <TotalAmount>${formatAmount(totalBase)}</TotalAmount>`,
    "                    </TaxableBase>",
    "                    <TaxAmount>",
    `                        <TotalAmount>${formatAmount(totalVat)}</TotalAmount>`,
    "                    </TaxAmount>",
    "                </Tax>",
    "            </TaxesOutputs>",
    "            <TaxesWithheld>",
    "                <Tax>",
    "                    <TaxTypeCode>04</TaxTypeCode>",
    "                    <TaxRate>0.00</TaxRate>",
    "                    <TaxableBase>",
    "                        <TotalAmount>0.00</TotalAmount>",
    "                    </TaxableBase>",
    "                    <TaxAmount>",
    "                        <TotalAmount>0.00</TotalAmount>",
    "                    </TaxAmount>",
    "                </Tax>",
    "            </TaxesWithheld>",
    "            <InvoiceTotals>",
    `                <TotalGrossAmount>${formatAmount(totalBase)}</TotalGrossAmount>`,
    "                <TotalGeneralDiscounts>0.00</TotalGeneralDiscounts>",
    `                <TotalGrossAmountBeforeTaxes>${formatAmount(totalBase)}</TotalGrossAmountBeforeTaxes>`,
    `                <TotalTaxOutputs>${formatAmount(totalVat)}</TotalTaxOutputs>`,
    "                <TotalTaxesWithheld>0.00</TotalTaxesWithheld>",
    `                <InvoiceTotal>${formatAmount(totalInvoice)}</InvoiceTotal>`,
    "                <TotalFinancialExpenses>0.00</TotalFinancialExpenses>",
    `                <TotalOutstandingAmount>${formatAmount(totalInvoice)}</TotalOutstandingAmount>`,
    "                <TotalPaymentsOnAccount>0.00</TotalPaymentsOnAccount>",
    `                <TotalExecutableAmount>${formatAmount(totalInvoice)}</TotalExecutableAmount>`,
    "            </InvoiceTotals>",
    "            <Items>",
    invoiceLinesXml,
    "            </Items>",
    "            <PaymentDetails>",
    "                <Installment>",
    `                    <InstallmentDueDate>${dueDate || issueDate}</InstallmentDueDate>`,
    `                    <InstallmentAmount>${formatAmount(totalInvoice)}</InstallmentAmount>`,
    `                    <PaymentMeans>${bankAccount && bankAccount.iban ? "04" : "01"}</PaymentMeans>`,
    ...(bankAccount && bankAccount.iban ? [
      "                    <AccountToBeCredited>",
      `                        <IBAN>${escapeXml(bankAccount.iban.replace(/\s+/g, ""))}</IBAN>`,
      "                    </AccountToBeCredited>",
    ] : []),
    "                </Installment>",
    "            </PaymentDetails>",
    "        </Invoice>",
    "    </Invoices>",
    "</facturae:Facturae>"
  );

  return xmlParts.filter(Boolean).join("\n");
};

/**
 * Build UBL 2.1 XML invoice (EN16931)
 */
const buildUblInvoiceXml = ({ invoice, me, contact, dir3, bankAccount }) => {
  const issueDate = formatDate(invoice.emitted || invoice.createdAt);
  const dueDate = invoice.paybefore ? formatDate(invoice.paybefore) : null;
  const invoiceId = invoice.code || `INV-${invoice.id}`;
  const currency = "EUR";
  const lines = Array.isArray(invoice.lines) ? invoice.lines : [];

  const supplierName = me && me.name ? me.name : "";
  const supplierNif = me && me.nif ? me.nif : "";
  const supplierAddress = me && me.address ? me.address : "";
  const supplierCity = me && me.city ? me.city : "";
  const supplierPostcode = me && me.postcode ? me.postcode : "";
  const supplierCountry = me && me.country ? me.country : "ES";

  const customerName =
    (contact && contact.name) ||
    (invoice.contact_info && invoice.contact_info.name) ||
    "";
  const customerNif =
    (contact && contact.nif) ||
    (invoice.contact_info && invoice.contact_info.nif) ||
    "";
  const customerAddress =
    (contact && contact.address) ||
    (invoice.contact_info && invoice.contact_info.address) ||
    "";
  const customerCity =
    (contact && contact.city) ||
    (invoice.contact_info && invoice.contact_info.city) ||
    "";
  const customerPostcode =
    (contact && contact.postcode) ||
    (invoice.contact_info && invoice.contact_info.postcode) ||
    "";
  const customerCountry =
    (contact && contact.country) ||
    (invoice.contact_info && invoice.contact_info.country) ||
    "ES";
  const dir3Oc = dir3 && dir3.oc ? dir3.oc : "";
  const dir3Og = dir3 && dir3.og ? dir3.og : "";
  const dir3Ut = dir3 && dir3.ut ? dir3.ut : "";

  let totalBase = 0;
  let totalVat = 0;

  const invoiceLinesXml = lines
    .map((line, index) => {
      const { quantity, base, extension, vatAmount } = getInvoiceLineAmounts(
        line
      );

      totalBase += extension;
      totalVat += vatAmount;

      const itemName = line.concept || `Línia ${index + 1}`;

      return [
        "  <cac:InvoiceLine>",
        `    <cbc:ID>${index + 1}</cbc:ID>`,
        `    <cbc:InvoicedQuantity unitCode="EA">${formatAmount(quantity)}</cbc:InvoicedQuantity>`,
        `    <cbc:LineExtensionAmount currencyID="${currency}">${formatAmount(extension)}</cbc:LineExtensionAmount>`,
        "    <cac:Item>",
        `      <cbc:Name>${escapeXml(itemName)}</cbc:Name>`,
        "    </cac:Item>",
        "    <cac:Price>",
        `      <cbc:PriceAmount currencyID="${currency}">${formatAmount(base)}</cbc:PriceAmount>`,
        "    </cac:Price>",
        "  </cac:InvoiceLine>",
      ].join("\n");
    })
    .join("\n");

  // EN16931 validation: totals MUST match sum of lines exactly
  totalBase = round2(totalBase);
  totalVat = round2(totalVat);
  const taxInclusive = round2(totalBase + totalVat); // TotalGross = TotalNet + TotalVat
  const payable = taxInclusive;

  // Calculate VAT percentage (default 21% if can't calculate)
  const vatPercent = totalBase > 0 ? round2((totalVat / totalBase) * 100) : 21;

  const xmlParts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
    '  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    '  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    "  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>",
    "  <cbc:ProfileID>urn:www.cenbii.eu:profile:bii04:ver2.0</cbc:ProfileID>",
    `  <cbc:ID>${escapeXml(invoiceId)}</cbc:ID>`,
    `  <cbc:IssueDate>${issueDate}</cbc:IssueDate>`,
    ...(dueDate ? [`  <cbc:DueDate>${dueDate}</cbc:DueDate>`] : []),
    "  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>",
    `  <cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>`,
    "  <cac:AccountingSupplierParty>",
    "    <cac:Party>",

    "      <cac:PartyIdentification>",
    `        <cbc:ID schemeID="VAT">ES${escapeXml(supplierNif)}</cbc:ID>`,
    "      </cac:PartyIdentification>",
    "      <cac:PartyName>",
    `        <cbc:Name>${escapeXml(supplierName)}</cbc:Name>`,
    "      </cac:PartyName>",
    "      <cac:PostalAddress>",
    `        <cbc:StreetName>${escapeXml(supplierAddress)}</cbc:StreetName>`,
    `        <cbc:CityName>${escapeXml(supplierCity)}</cbc:CityName>`,
    `        <cbc:PostalZone>${escapeXml(supplierPostcode)}</cbc:PostalZone>`,
    "        <cac:Country>",
    `          <cbc:IdentificationCode>${escapeXml(supplierCountry || "ES")}</cbc:IdentificationCode>`,
    "        </cac:Country>",
    "      </cac:PostalAddress>",
    "      <cac:PartyTaxScheme>",
    `        <cbc:CompanyID>ES${escapeXml(supplierNif)}</cbc:CompanyID>`,
    "        <cac:TaxScheme>",
    "          <cbc:ID>VAT</cbc:ID>",
    "        </cac:TaxScheme>",
    "      </cac:PartyTaxScheme>",
    "      <cac:PartyLegalEntity>",
    `        <cbc:RegistrationName>${escapeXml(supplierName)}</cbc:RegistrationName>`,
    "      </cac:PartyLegalEntity>",
    "    </cac:Party>",
    "  </cac:AccountingSupplierParty>",
    "  <cac:AccountingCustomerParty>",
    "    <cac:Party>",
    "      <cac:PartyIdentification>",
    `        <cbc:ID>${escapeXml(customerNif)}</cbc:ID>`,
    "      </cac:PartyIdentification>",
    "      <cac:PartyName>",
    `        <cbc:Name>${escapeXml(customerName)}</cbc:Name>`,
    "      </cac:PartyName>",
    "      <cac:PostalAddress>",
    `        <cbc:StreetName>${escapeXml(customerAddress)}</cbc:StreetName>`,
    `        <cbc:CityName>${escapeXml(customerCity)}</cbc:CityName>`,
    `        <cbc:PostalZone>${escapeXml(customerPostcode)}</cbc:PostalZone>`,
    "        <cac:Country>",
    `          <cbc:IdentificationCode>${escapeXml(customerCountry || "ES")}</cbc:IdentificationCode>`,
    "        </cac:Country>",
    "      </cac:PostalAddress>",

    "    </cac:Party>",
    "  </cac:AccountingCustomerParty>",
    "  <cac:AdditionalDocumentReference>",
    "    <cbc:ID>DIR3-OFICINA-CONTABLE</cbc:ID>",
    `    <cbc:DocumentDescription>${escapeXml(dir3Oc)}</cbc:DocumentDescription>`,
    "  </cac:AdditionalDocumentReference>",
    "  <cac:AdditionalDocumentReference>",
    "    <cbc:ID>DIR3-ORGANO-GESTOR</cbc:ID>",
    `    <cbc:DocumentDescription>${escapeXml(dir3Og)}</cbc:DocumentDescription>`,
    "  </cac:AdditionalDocumentReference>",
    "  <cac:AdditionalDocumentReference>",
    "    <cbc:ID>DIR3-UNIDAD-TRAMITADORA</cbc:ID>",
    `    <cbc:DocumentDescription>${escapeXml(dir3Ut)}</cbc:DocumentDescription>`,
    "  </cac:AdditionalDocumentReference>",
    "  <cac:PaymentMeans>",
    `    <cbc:PaymentMeansCode>${bankAccount && bankAccount.iban ? "30" : "31"}</cbc:PaymentMeansCode>`,
    ...(bankAccount && bankAccount.iban ? [
      "    <cac:PayeeFinancialAccount>",
      `      <cbc:ID>${escapeXml(bankAccount.iban)}</cbc:ID>`,
      "    </cac:PayeeFinancialAccount>"
    ] : []),
    "  </cac:PaymentMeans>",
    "  <cac:TaxTotal>",
    `    <cbc:TaxAmount currencyID="${currency}">${formatAmount(totalVat)}</cbc:TaxAmount>`,
    "    <cac:TaxSubtotal>",
    `      <cbc:TaxableAmount currencyID="${currency}">${formatAmount(totalBase)}</cbc:TaxableAmount>`,
    `      <cbc:TaxAmount currencyID="${currency}">${formatAmount(totalVat)}</cbc:TaxAmount>`,
    "      <cac:TaxCategory>",
    "        <cbc:ID>S</cbc:ID>",
    `        <cbc:Percent>${formatAmount(vatPercent)}</cbc:Percent>`,
    "        <cac:TaxScheme>",
    "          <cbc:ID>VAT</cbc:ID>",
    "        </cac:TaxScheme>",
    "      </cac:TaxCategory>",
    "    </cac:TaxSubtotal>",
    "  </cac:TaxTotal>",
    "  <cac:LegalMonetaryTotal>",
    `    <cbc:LineExtensionAmount currencyID="${currency}">${formatAmount(totalBase)}</cbc:LineExtensionAmount>`,
    `    <cbc:TaxExclusiveAmount currencyID="${currency}">${formatAmount(totalBase)}</cbc:TaxExclusiveAmount>`,
    `    <cbc:TaxInclusiveAmount currencyID="${currency}">${formatAmount(taxInclusive)}</cbc:TaxInclusiveAmount>`,
    `    <cbc:PayableAmount currencyID="${currency}">${formatAmount(payable)}</cbc:PayableAmount>`,
    "  </cac:LegalMonetaryTotal>",
    invoiceLinesXml,
    "</Invoice>",
  ];

  return xmlParts.filter(Boolean).join("\n");
};

/**
 * Create HTTPS agent with certificate authentication
 */
const createFaceHttpsAgent = (certificatePath, certificatePassword) => {
  try {
    if (!certificatePath || !fs.existsSync(certificatePath)) {
      throw new Error(`Certificate file not found: ${certificatePath}`);
    }

    const pfx = fs.readFileSync(certificatePath);

    return new https.Agent({
      pfx: pfx,
      passphrase: certificatePassword || undefined,
      rejectUnauthorized: false,
      requestCert: true,
      agent: false,
    });
  } catch (error) {
    strapi.log.error("[face-queue] Error creating HTTPS agent:", error);
    throw error;
  }
};

/**
 * Resolve the absolute path of the FACe certificate file on disk.
 * v5 equivalent of v3's path.join(process.cwd(), strapi.config.paths.static, rel).
 */
const resolveCertificatePath = (me) => {
  const certificateRelativePath = me.face_certificate.url.replace(/^\//, "");
  return path.join(strapi.dirs.static.public, certificateRelativePath);
};

/**
 * Submit invoice to FACe REST API
 */
const submitInvoiceToFace = async ({ xml, nif: _nif, dir3: _dir3, mode, me }) => {
  try {
    const endpoint = mode === "test"
      ? (me.face_test_endpoint || "https://se-api.face.gob.es/providers")
      : (me.face_real_endpoint || "https://api.face.gob.es/providers");

    if (!endpoint) {
      throw new Error("Test endpoint not configured. Please configure face_test_endpoint in settings or contact FACe support for test environment URL.");
    }

    const submitUrl = `${endpoint}/v1/invoices`;

    // Get certificate configuration
    if (!me.face_certificate || !me.face_certificate.url) {
      throw new Error("FACe certificate not configured in settings");
    }

    const certificatePath = resolveCertificatePath(me);

    const httpsAgent = createFaceHttpsAgent(certificatePath, me.face_certificate_password);

    // Generate JWT token for authentication (valid for 5 minutes)
    const jwtToken = generateFaceJWT(certificatePath, me.face_certificate_password);

    // FACe API expects JSON with base64-encoded XML, not multipart/form-data
    const xmlBase64 = Buffer.from(xml, "utf-8").toString("base64");

    // Email is required by FACe API manual (page 9)
    const emailAddress = me.email || "";

    const requestBody = {
      filename: "invoice.xml",
      content: xmlBase64,
      email: emailAddress,
      attachments: []
    };

    const config = {
      method: "POST",
      url: submitUrl,
      data: requestBody,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${jwtToken}`,
        "User-Agent": "FACe-Client/1.0",
      },
      httpsAgent: httpsAgent,
      timeout: 30000, // 30 seconds timeout
    };

    const response = await axios(config);

    return {
      success: true,
      statusCode: response.status,
      registrationNumber: response.data.numero_registro || response.data.registration_number,
      estado: response.data.estado,
      data: response.data,
    };
  } catch (error) {
    strapi.log.error("[face-queue] submitInvoiceToFace error:", error.response?.data || error.message);
    strapi.log.error("[face-queue] Status code:", error.response?.status);
    strapi.log.error("[face-queue] Headers:", error.response?.headers);
    return {
      success: false,
      statusCode: error.response?.status || 0,
      error: error.response?.data || error.message,
      data: error.response?.data,
    };
  }
};

/**
 * Check invoice status from FACe REST API
 */
const checkInvoiceStatus = async ({ registrationNumber, mode, me }) => {
  try {
    const endpoint = mode === "test"
      ? (me.face_test_endpoint || "https://se-api.face.gob.es/providers")
      : (me.face_real_endpoint || "https://api.face.gob.es/providers");

    if (!endpoint) {
      throw new Error("Test endpoint not configured. Please configure face_test_endpoint in settings or contact FACe support for test environment URL.");
    }

    const statusUrl = `${endpoint}/v1/invoices/${registrationNumber}`;

    // Get certificate configuration
    if (!me.face_certificate || !me.face_certificate.url) {
      throw new Error("FACe certificate not configured in settings");
    }

    const certificatePath = resolveCertificatePath(me);

    const httpsAgent = createFaceHttpsAgent(certificatePath, me.face_certificate_password);

    // Generate JWT token for authentication (valid for 5 minutes)
    const jwtToken = generateFaceJWT(certificatePath, me.face_certificate_password);

    const config = {
      method: "GET",
      url: statusUrl,
      headers: {
        "Authorization": `Bearer ${jwtToken}`,
        "User-Agent": "FACe-Client/1.0",
      },
      httpsAgent: httpsAgent,
      timeout: 30000, // 30 seconds timeout
    };

    const response = await axios(config);

    return {
      success: true,
      statusCode: response.status,
      estado: response.data.estado,
      codigoEstado: response.data.codigo_estado,
      motivoRechazo: response.data.motivo_rechazo,
      data: response.data,
    };
  } catch (error) {
    strapi.log.error("[face-queue] checkInvoiceStatus error:", error.response?.data || error.message);
    return {
      success: false,
      statusCode: error.response?.status || 0,
      error: error.response?.data || error.message,
      data: error.response?.data,
    };
  }
};

const startFaceProcess = async (faceQueueInput) => {
  if (!faceQueueInput) {
    return;
  }

  const faceQueueId =
    typeof faceQueueInput === "object"
      ? faceQueueInput.id
      : faceQueueInput;

  if (!faceQueueId) {
    return;
  }

  const faceQueue = await strapi.db.query(FACE_QUEUE_UID).findOne({ where: { id: faceQueueId } });

  if (!faceQueue) {
    strapi.log.warn(`[face-queue] startFaceProcess queue not found id=${faceQueueId}`);
    return;
  }

  strapi.log.info(`[face-queue] startFaceProcess id=${faceQueue.id}`);

  const emittedInvoiceId = faceQueue.emitted_invoice;

  if (!emittedInvoiceId) {
    strapi.log.warn(`[face-queue] missing emitted_invoice id=${faceQueue.id}`);
    await strapi.db.query(FACE_QUEUE_UID).update({
      where: { id: faceQueue.id },
      data: {
        status: "error",
        response_body: "No emitted invoice linked to face-queue record",
      },
    });
    return;
  }

  const invoice = await strapi.db.query(EMITTED_INVOICE_UID).findOne({
    where: { id: emittedInvoiceId },
    populate: {
      lines: true,
      contact: true,
      contact_info: true,
      bank_account: true,
      serial: true,
      rectified_invoice: { populate: { serial: true } },
    },
  });

  if (!invoice) {
    strapi.log.warn(`[face-queue] emitted invoice not found queue=${faceQueue.id} invoice=${emittedInvoiceId}`);
    await strapi.db.query(FACE_QUEUE_UID).update({
      where: { id: faceQueue.id },
      data: {
        status: "error",
        response_body: `Emitted invoice not found: ${emittedInvoiceId}`,
      },
    });
    return;
  }

  const invoiceSnapshot = JSON.parse(JSON.stringify(invoice));

  const me = await strapi.documents(ME_UID).findFirst({
    populate: { bank_account_default: true, face_certificate: true },
  });
  const contactId = invoice.contact;
  const contact = contactId
    ? await strapi.db.query(CONTACT_UID).findOne({ where: { id: contactId } })
    : null;

  if (!contact) {
    strapi.log.warn(`[face-queue] contact not found queue=${faceQueue.id} invoice=${emittedInvoiceId}`);
    await strapi.db.query(FACE_QUEUE_UID).update({
      where: { id: faceQueue.id },
      data: {
        invoice: invoiceSnapshot,
        status: "error",
        response_body: "FACe pre-validation error: contact not found",
      },
    });
    return;
  }

  const dir3 = {
    oc: contact.face_dir3_oc,
    og: contact.face_dir3_og,
    ut: contact.face_dir3_ut,
  };

  const missingDir3 = [];
  if (!dir3.oc) {
    missingDir3.push("OC");
  }
  if (!dir3.og) {
    missingDir3.push("OG");
  }
  if (!dir3.ut) {
    missingDir3.push("UT");
  }

  if (missingDir3.length > 0) {
    strapi.log.warn(
      `[face-queue] missing DIR3 queue=${faceQueue.id} missing=${missingDir3.join(",")}`
    );
    await strapi.db.query(FACE_QUEUE_UID).update({
      where: { id: faceQueue.id },
      data: {
        invoice: invoiceSnapshot,
        status: "error",
        response_body: `FACe pre-validation error: missing DIR3 values (${missingDir3.join(", ")})`,
      },
    });
    return;
  }

  // Validate rectificative invoices
  if (invoice.serial && invoice.serial.rectificative === true) {
    if (!invoice.rectified_invoice) {
      strapi.log.warn(
        `[face-queue] rectificative invoice without reference queue=${faceQueue.id} invoice=${emittedInvoiceId}`
      );
      await strapi.db.query(FACE_QUEUE_UID).update({
        where: { id: faceQueue.id },
        data: {
          invoice: invoiceSnapshot,
          status: "error",
          response_body: "FACe pre-validation error: rectificative invoice must reference an original invoice (rectified_invoice field is required)",
        },
      });
      return;
    }
  }

  // Resolve bank account: invoice override, else me default
  const bankAccount = invoice.bank_account || me.bank_account_default || null;

  // Choose invoice format: UBL or Facturae
  const invoiceFormat = me.face_invoice_format || "facturae";
  const xml = invoiceFormat === "facturae"
    ? buildFacturaeInvoiceXml({ invoice, me, contact, dir3, bankAccount })
    : buildUblInvoiceXml({ invoice, me, contact, dir3, bankAccount });

  const xmlRootTag = invoiceFormat === "facturae" ? "<facturae:Facturae" : "<Invoice";
  const xmlEndTag = invoiceFormat === "facturae" ? "</facturae:Facturae>" : "</Invoice>";
  const xmlFormatName = invoiceFormat === "facturae" ? "Facturae 3.2" : "UBL 2.1";

  if (!xml || !xml.includes(xmlRootTag) || !xml.includes(xmlEndTag)) {
    strapi.log.warn(`[face-queue] invalid generated xml queue=${faceQueue.id} format=${invoiceFormat}`);
    await strapi.db.query(FACE_QUEUE_UID).update({
      where: { id: faceQueue.id },
      data: {
        invoice: invoiceSnapshot,
        status: "error",
        response_body: `Invalid generated ${xmlFormatName} XML`,
      },
    });
    return;
  }

  strapi.log.info(`[face-queue] ${xmlFormatName} xml generated queue=${faceQueue.id}`);

  // Sign Facturae XML with XAdES-BES (FACe requires signed Facturae)
  let signedXml = xml;
  if (invoiceFormat === "facturae") {
    if (!me.face_certificate || !me.face_certificate.url) {
      strapi.log.error(`[face-queue] cannot sign: face_certificate missing queue=${faceQueue.id}`);
      await strapi.db.query(FACE_QUEUE_UID).update({
        where: { id: faceQueue.id },
        data: {
          invoice: invoiceSnapshot,
          request_body: xml,
          status: "error",
          response_body: "FACe certificate not configured in settings",
        },
      });
      return;
    }
    try {
      const certificatePath = resolveCertificatePath(me);
      signedXml = await signFacturaeXml(xml, certificatePath, me.face_certificate_password);
      strapi.log.info(`[face-queue] Facturae XAdES-BES signed queue=${faceQueue.id} bytes=${signedXml.length}`);
    } catch (signError) {
      strapi.log.error(`[face-queue] sign error queue=${faceQueue.id}:`, signError);
      await strapi.db.query(FACE_QUEUE_UID).update({
        where: { id: faceQueue.id },
        data: {
          invoice: invoiceSnapshot,
          request_body: xml,
          status: "error",
          response_body: `XAdES sign error: ${signError.message}`,
        },
      });
      return;
    }
  }

  const requestUrl = faceQueue.mode === "test"
    ? (me.face_test_endpoint || "https://se-api.face.gob.es/providers")
    : (me.face_real_endpoint || "https://api.face.gob.es/providers");

  if (!requestUrl) {
    strapi.log.error(`[face-queue] Test endpoint not configured queue=${faceQueue.id}`);
    await strapi.db.query(FACE_QUEUE_UID).update({
      where: { id: faceQueue.id },
      data: {
        invoice: invoiceSnapshot,
        request_body: xml,
        status: "error",
        response_body: "Test endpoint not configured. Please set face_test_endpoint in settings or contact FACe support.",
      },
    });
    return;
  }

  await strapi.db.query(FACE_QUEUE_UID).update({
    where: { id: faceQueue.id },
    data: {
      invoice: invoiceSnapshot,
      request_body: signedXml,
      request_url: requestUrl,
      status: "pending",
    }
  });

  strapi.log.info(`[face-queue] xml persisted queue=${faceQueue.id}`);

  // DRY-RUN mode: Generate XML but don't submit (for testing)
  // Set FACE_DRY_RUN=true in .env to enable
  const dryRunMode = process.env.FACE_DRY_RUN === "true";

  if (dryRunMode) {
    strapi.log.warn(`[face-queue] DRY-RUN MODE: XML generated but not submitted queue=${faceQueue.id}`);
    strapi.log.info(`[face-queue] Generated XML:\n${xml}`);

    await strapi.db.query(FACE_QUEUE_UID).update({
      where: { id: faceQueue.id },
      data: {
        invoice: invoiceSnapshot,
        response_body: JSON.stringify({
          dryRun: true,
          message: "DRY-RUN: XML generated successfully but not submitted to FACe",
          xmlLength: xml.length,
          timestamp: new Date().toISOString()
        }, null, 2),
        status: "pending",
      }
    });

    strapi.log.info(`[face-queue] DRY-RUN completed for queue ${faceQueue.id}`);
    return;
  }

  // Submit to FACe REST API
  try {
    const submitResult = await submitInvoiceToFace({
      xml: signedXml,
      nif: me.nif,
      dir3,
      mode: faceQueue.mode,
      me,
    });

    if (submitResult.success) {
      await strapi.db.query(FACE_QUEUE_UID).update({
        where: { id: faceQueue.id },
        data: {
          invoice: invoiceSnapshot,
          registration_number: submitResult.registrationNumber,
          response_body: JSON.stringify(submitResult.data, null, 2),
          response_code: submitResult.statusCode,
          status: "registered",
          last_status_check: new Date(),
          attempts: 0,
        }
      });

      strapi.log.info(
        `[face-queue] invoice submitted queue=${faceQueue.id} registration=${submitResult.registrationNumber}`
      );
    } else {
      const attempts = (faceQueue.attempts || 0) + 1;
      const maxAttempts = 10;

      await strapi.db.query(FACE_QUEUE_UID).update({
        where: { id: faceQueue.id },
        data: {
          invoice: invoiceSnapshot,
          response_body: JSON.stringify(submitResult.error || submitResult.data, null, 2),
          response_code: submitResult.statusCode,
          status: attempts >= maxAttempts ? "error" : "pending",
          attempts,
        }
      });

      strapi.log.warn(
        `[face-queue] submission failed queue=${faceQueue.id} attempts=${attempts}/${maxAttempts}`
      );
    }
  } catch (error) {
    strapi.log.error(`[face-queue] unexpected error queue=${faceQueue.id}:`, error);
    await strapi.db.query(FACE_QUEUE_UID).update({
      where: { id: faceQueue.id },
      data: {
        invoice: invoiceSnapshot,
        response_body: JSON.stringify({ error: error.message }, null, 2),
        status: "error",
      }
    });
  }

  strapi.log.info(
    `[face-queue] FACe process completed for queue ${faceQueue.id} (invoice ${emittedInvoiceId || "-"})`
  );
};

/**
 * Map a FACe estado code to our internal queue status.
 */
const mapFaceEstado = (estado) => {
  if (estado === "REC01" || estado === "delivered" || estado === "entregada") {
    return "delivered";
  }
  if (estado === "REC02" || estado === "rejected" || estado === "rechazada") {
    return "rejected";
  }
  return "registered";
};

module.exports = createCoreService(FACE_QUEUE_UID, ({ strapi }) => ({
  startFaceProcess,
  checkInvoiceStatus,
  submitInvoiceToFace,

  /**
   * Cron: check FACe invoice status (every 30 minutes).
   * Ported from v3 api/face-queue/cron/check-status.js.
   */
  async cronCheckStatus() {
    try {
      const me = await strapi.documents(ME_UID).findFirst();

      if (!me || !me.face || me.face === "no") {
        return; // FACe not enabled
      }

      // Find invoices that need status checking
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

      const pendingQueues = await strapi.db.query(FACE_QUEUE_UID).findMany({
        where: {
          status: "registered",
          $or: [
            { last_status_check: { $null: true } },
            { last_status_check: { $lt: thirtyMinutesAgo } },
          ],
        },
      });

      if (pendingQueues.length === 0) {
        return;
      }

      strapi.log.info(`[CRON] Checking FACe status for ${pendingQueues.length} invoices`);

      for (const queue of pendingQueues) {
        if (!queue.registration_number) {
          continue;
        }

        try {
          const statusResult = await checkInvoiceStatus({
            registrationNumber: queue.registration_number,
            mode: queue.mode,
            me,
          });

          if (statusResult.success) {
            const newStatus = mapFaceEstado(statusResult.estado || statusResult.codigoEstado);

            await strapi.db.query(FACE_QUEUE_UID).update({
              where: { id: queue.id },
              data: {
                status: newStatus,
                response_body: JSON.stringify(statusResult.data, null, 2),
                last_status_check: new Date(),
              },
            });

            strapi.log.info(`[CRON] Updated FACe queue ${queue.id} to status: ${newStatus}`);
          } else {
            strapi.log.warn(`[CRON] Failed to check FACe status for queue ${queue.id}:`, statusResult.error);
          }
        } catch (error) {
          strapi.log.error(`[CRON] Error checking FACe status for queue ${queue.id}:`, error);
        }
      }
    } catch (error) {
      console.error('[CRON] Error in FACe status polling:', error);
    }
  },

  /**
   * Cron: retry pending FACe submissions (every 5 minutes, max 10 attempts).
   * Ported from v3 api/face-queue/cron/retry-pending.js.
   * Reuses the already-signed XML stored in request_body.
   */
  async cronRetryPending() {
    try {
      const me = await strapi.documents(ME_UID).findFirst({
        populate: { face_certificate: true },
      });

      if (!me || !me.face || me.face === "no") {
        return; // FACe not enabled
      }

      const maxAttempts = 10;
      const minBackoffMs = 2 * 60 * 1000; // wait at least 2 minutes between retries
      const backoffCutoff = new Date(Date.now() - minBackoffMs);

      const pendingQueues = await strapi.db.query(FACE_QUEUE_UID).findMany({
        where: {
          status: "pending",
          attempts: { $gt: 0, $lt: maxAttempts },
          request_body: { $notNull: true },
          updatedAt: { $lt: backoffCutoff },
        },
        limit: 50,
      });

      if (!pendingQueues || pendingQueues.length === 0) {
        return;
      }

      strapi.log.info(`[CRON] Retrying ${pendingQueues.length} pending FACe submissions`);

      for (const queue of pendingQueues) {
        if (!queue.request_body) {
          continue;
        }

        try {
          const submitResult = await submitInvoiceToFace({
            xml: queue.request_body,
            nif: me.nif,
            mode: queue.mode,
            me,
          });

          if (submitResult.success) {
            await strapi.db.query(FACE_QUEUE_UID).update({
              where: { id: queue.id },
              data: {
                registration_number: submitResult.registrationNumber,
                response_body: JSON.stringify(submitResult.data, null, 2),
                response_code: submitResult.statusCode,
                status: "registered",
                last_status_check: new Date(),
                attempts: 0,
              },
            });
            strapi.log.info(
              `[CRON] Retry succeeded queue=${queue.id} registration=${submitResult.registrationNumber}`
            );
          } else {
            const attempts = (queue.attempts || 0) + 1;
            await strapi.db.query(FACE_QUEUE_UID).update({
              where: { id: queue.id },
              data: {
                response_body: JSON.stringify(submitResult.error || submitResult.data, null, 2),
                response_code: submitResult.statusCode,
                status: attempts >= maxAttempts ? "error" : "pending",
                attempts,
              },
            });
            strapi.log.warn(
              `[CRON] Retry failed queue=${queue.id} attempts=${attempts}/${maxAttempts} statusCode=${submitResult.statusCode}`
            );
          }
        } catch (error) {
          strapi.log.error(`[CRON] Unexpected error retrying queue=${queue.id}:`, error);
        }
      }
    } catch (error) {
      console.error('[CRON] Error in FACe retry-pending job:', error);
    }
  },
}));
