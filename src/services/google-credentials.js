'use strict';
/* global strapi */

/**
 * The Google service-account key (`me.google_credentials`) that imports the
 * people's Google Calendar events as hours (activity controller,
 * Resilience.Earth), managed from the app (issues/159). Until now it could only
 * be uploaded from the Strapi admin.
 *
 * Like the certificates (services/certificates.js): nothing here returns the
 * private key, the file's URL or its path; the file is never served over HTTP
 * (middlewares/block-key-material.js blocks /uploads/*.json); a replaced or
 * removed file is deleted.
 */

const fs = require('fs');
const path = require('path');
const { CertificateError } = require('./certificates');

const UID = 'api::me.me';
const FIELD = 'google_credentials';
const MAX_BYTES = 64 * 1024;

function loadSettings() {
  return strapi.documents(UID).findFirst({ populate: { [FIELD]: true } });
}

function diskPath(file) {
  if (!file || !file.url || /^[a-z]+:\/\//i.test(file.url)) return null;
  return path.join(strapi.dirs.static.public, file.url.replace(/^\//, ''));
}

/**
 * What the app shows of a service-account key, or why it can't be used.
 * @returns {{ valid: boolean, message: string|null, account: object|null }}
 */
function inspectServiceAccount(buffer) {
  let json;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch {
    return { valid: false, message: 'El fitxer no és un JSON vàlid.', account: null };
  }
  if (!json || json.type !== 'service_account' || !json.client_email || !json.private_key) {
    return {
      valid: false,
      message: "No és la clau d'un compte de servei de Google (cal «type»: «service_account», «client_email» i «private_key»).",
      account: null,
    };
  }
  return {
    valid: true,
    message: null,
    account: { clientEmail: json.client_email, projectId: json.project_id || null, keyId: json.private_key_id || null },
  };
}

async function getStatus() {
  const settings = await loadSettings();
  const file = settings && settings[FIELD];
  const status = {
    kind: 'google',
    configured: !!file,
    fileName: file ? file.name : null,
    uploadedAt: file ? file.createdAt || null : null,
    valid: false,
    message: null,
    account: null,
  };
  if (!file) return status;
  const filePath = diskPath(file);
  if (!filePath || !fs.existsSync(filePath)) {
    return { ...status, message: "El fitxer de la clau no es troba al servidor. Torna'l a pujar." };
  }
  return { ...status, ...inspectServiceAccount(fs.readFileSync(filePath)) };
}

async function replace(upload) {
  if (!upload || !upload.filepath) throw new CertificateError('Cal triar el fitxer de la clau (.json).');
  const fileName = upload.originalFilename || '';
  if (!/\.json$/i.test(fileName)) throw new CertificateError('La clau ha de ser un fitxer .json.');
  if (upload.size > MAX_BYTES) throw new CertificateError('El fitxer és massa gran per ser una clau de Google.');

  const result = inspectServiceAccount(fs.readFileSync(upload.filepath));
  if (!result.valid) throw new CertificateError(result.message);

  const [stored] = await strapi
    .plugin('upload')
    .service('upload')
    .upload({ data: { fileInfo: { name: fileName } }, files: { ...upload, mimetype: 'application/json' } });

  const settings = await loadSettings();
  const previous = settings && settings[FIELD];
  if (settings) {
    await strapi.documents(UID).update({ documentId: settings.documentId, data: { [FIELD]: stored.id } });
  } else {
    await strapi.documents(UID).create({ data: { [FIELD]: stored.id } });
  }
  if (previous && previous.id !== stored.id) await strapi.plugin('upload').service('upload').remove(previous);
  return getStatus();
}

async function remove() {
  const settings = await loadSettings();
  const previous = settings && settings[FIELD];
  if (settings) await strapi.documents(UID).update({ documentId: settings.documentId, data: { [FIELD]: null } });
  if (previous) await strapi.plugin('upload').service('upload').remove(previous);
  return getStatus();
}

module.exports = { inspectServiceAccount, getStatus, replace, remove };
