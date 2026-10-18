'use strict';
/* global strapi */

/**
 * The entity's two certificates, managed from the app (ticket 159): the AEAT
 * one (VeriFactu, `verifactu.certificate`) and the FACe one
 * (`me.face_certificate`). Until now they could only be uploaded, and their
 * password set, from the Strapi admin.
 *
 * - Nothing here returns the password, the file's URL or its path on disk.
 * - The password is stored through the single type's lifecycle, which encrypts
 *   it (services/secret-crypto.js).
 * - A replaced or removed file is deleted from the media library and the disk,
 *   unless the other kind still uses it (the same keystore can serve both).
 */

const fs = require('fs');
const path = require('path');
const { decryptSecret } = require('./secret-crypto');
const { inspectPkcs12, MESSAGES } = require('./pkcs12-info');

const KINDS = {
  verifactu: { uid: 'api::verifactu.verifactu', file: 'certificate', password: 'certificate_password' },
  face: { uid: 'api::me.me', file: 'face_certificate', password: 'face_certificate_password' },
};

const MAX_BYTES = 1024 * 1024;
const EXTENSION = /\.(p12|pfx)$/i;

const STATUS_MESSAGES = {
  ...MESSAGES,
  file_missing: "El fitxer del certificat no es troba al servidor. Torna'l a pujar.",
  password_unreadable:
    'La contrasenya desada no es pot desxifrar (ha canviat la clau del servidor). Torna a pujar el certificat amb la contrasenya.',
};

class CertificateError extends Error {}

function kindOf(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
}

function loadSettings(kind) {
  const { uid, file } = KINDS[kind];
  return strapi.documents(uid).findFirst({ populate: { [file]: true } });
}

/** Absolute path of an uploaded file of the local provider, or null. */
function diskPath(file) {
  if (!file || !file.url || /^[a-z]+:\/\//i.test(file.url)) return null;
  return path.join(strapi.dirs.static.public, file.url.replace(/^\//, ''));
}

/**
 * What the app shows about one certificate. `certificate` (holder, NIF,
 * issuer, validity) is read from the keystore with the stored password.
 */
async function getStatus(kind) {
  const { file: fileField, password: passwordField } = KINDS[kind];
  const settings = await loadSettings(kind);
  const file = settings && settings[fileField];
  const status = {
    kind,
    configured: !!file,
    fileName: file ? file.name : null,
    uploadedAt: file ? file.createdAt || null : null,
    passwordSet: !!(settings && settings[passwordField]),
    valid: false,
    error: null,
    message: null,
    certificate: null,
  };
  if (!file) return status;

  const filePath = diskPath(file);
  if (!filePath || !fs.existsSync(filePath)) {
    return { ...status, error: 'file_missing', message: STATUS_MESSAGES.file_missing };
  }

  let password;
  try {
    password = decryptSecret(settings[passwordField]) || '';
  } catch {
    return { ...status, error: 'password_unreadable', message: STATUS_MESSAGES.password_unreadable };
  }

  return { ...status, ...inspectPkcs12(fs.readFileSync(filePath), password) };
}

/** Deletes an uploaded file unless another certificate field still points to it. */
async function removeFileIfUnused(file) {
  if (!file) return;
  for (const kind of Object.keys(KINDS)) {
    const settings = await loadSettings(kind);
    const used = settings && settings[KINDS[kind].file];
    if (used && used.id === file.id) return;
  }
  await strapi.plugin('upload').service('upload').remove(file);
}

async function saveSettings(kind, settings, data) {
  const { uid } = KINDS[kind];
  if (settings) {
    await strapi.documents(uid).update({ documentId: settings.documentId, data });
  } else {
    await strapi.documents(uid).create({ data });
  }
}

/**
 * Validates and stores a new keystore with its password, replacing the
 * previous one.
 *
 * @param {string} kind 'verifactu' | 'face'
 * @param {object} upload the multipart file (formidable: filepath, originalFilename, size)
 * @param {string} [password]
 * @throws {CertificateError} with a Catalan message when the file is refused
 */
async function replace(kind, upload, password) {
  if (!upload || !upload.filepath) {
    throw new CertificateError('Cal triar el fitxer del certificat (.p12 o .pfx).');
  }
  const fileName = upload.originalFilename || '';
  if (!EXTENSION.test(fileName)) {
    throw new CertificateError('El certificat ha de ser un fitxer .p12 o .pfx.');
  }
  if (upload.size > MAX_BYTES) {
    throw new CertificateError('El fitxer és massa gran per ser un certificat.');
  }

  const result = inspectPkcs12(fs.readFileSync(upload.filepath), password);
  if (!result.valid) throw new CertificateError(result.message);

  const [stored] = await strapi
    .plugin('upload')
    .service('upload')
    .upload({
      data: { fileInfo: { name: fileName } },
      // Browsers send .p12 as application/octet-stream or nothing at all.
      files: { ...upload, mimetype: 'application/x-pkcs12' },
    });

  const { file: fileField, password: passwordField } = KINDS[kind];
  const settings = await loadSettings(kind);
  const previous = settings && settings[fileField];
  await saveSettings(kind, settings, { [fileField]: stored.id, [passwordField]: password || '' });

  if (previous && previous.id !== stored.id) await removeFileIfUnused(previous);
  return getStatus(kind);
}

/** Unlinks the certificate and its password, and deletes the file. */
async function remove(kind) {
  const { file: fileField, password: passwordField } = KINDS[kind];
  const settings = await loadSettings(kind);
  const previous = settings && settings[fileField];
  if (settings) await saveSettings(kind, settings, { [fileField]: null, [passwordField]: null });
  if (previous) await removeFileIfUnused(previous);
  return getStatus(kind);
}

module.exports = { KINDS, kindOf, getStatus, replace, remove, CertificateError };
