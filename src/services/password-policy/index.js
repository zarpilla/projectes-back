'use strict';

/**
 * The minimum a password must meet, the same for every tenant.
 *
 * Follows NIST 800-63B: a minimum length and a list of known passwords, no
 * composition rules (a capital, a digit, a symbol), which only lead to
 * «Projectes1!».
 *
 * - 10 characters at least; 72 bytes at most (bcrypt ignores the rest).
 * - Not a common password (common-passwords.txt: the 10,000 most common, from
 *   SecLists, plus Catalan/Spanish words), also with digits or symbols added at
 *   the end: «barcelona2026!» counts as «barcelona».
 * - Not just a few different characters («aaaaaaaaaa», «1212121212»).
 * - Not containing the person's e-mail, username or name, nor the entity's.
 *
 * Checked on every way to set a password (users-permissions extension): the
 * reset link, changing one's own, and an admin creating or editing a user.
 * On login it only flags a password that doesn't meet it (`passwordWeak`).
 */

const fs = require('fs');
const path = require('path');

const MIN_LENGTH = 10;
const MAX_BYTES = 72;
const MIN_DISTINCT = 5;
/** Shorter personal words («ana», «coop») would refuse too many passwords. */
const MIN_PERSONAL_WORD = 4;

let common;
function commonPasswords() {
  if (!common) {
    const text = fs.readFileSync(path.join(__dirname, 'common-passwords.txt'), 'utf8');
    common = new Set(text.split('\n').filter(Boolean));
  }
  return common;
}

/** Lower case, accents kept. */
const lower = (s) => String(s || '').toLowerCase();

/** «Barcelona2026!» → «barcelona». */
const withoutTrailingDigitsAndSymbols = (s) => lower(s).replace(/[\d\W_]+$/u, '');

/** The words of the person and the entity that a password must not contain. */
function personalWords({ email, username, names = [] } = {}) {
  const words = new Set();
  const add = (w) => {
    const word = lower(w).trim();
    if (word.length >= MIN_PERSONAL_WORD) words.add(word);
  };
  if (email) {
    const local = lower(email).split('@')[0];
    add(local);
    local.split(/[^\p{L}\p{N}]+/u).forEach(add);
  }
  if (username) {
    add(username);
    lower(username).split(/[^\p{L}\p{N}]+/u).forEach(add);
  }
  for (const name of names) {
    if (!name) continue;
    lower(name).split(/[^\p{L}\p{N}]+/u).forEach(add);
  }
  return [...words];
}

/**
 * Null if the password meets the minimum, or the message (in Catalan) of the
 * first rule it fails.
 *
 * @param {string} password
 * @param {{ email?: string, username?: string, names?: string[] }} [context]
 *   names: the person's full and display name, the entity's name
 */
function passwordProblem(password, context = {}) {
  if (typeof password !== 'string' || !password) return 'Cal una clau de pas.';
  if ([...password].length < MIN_LENGTH) {
    return `La clau ha de tenir ${MIN_LENGTH} caràcters com a mínim.`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) {
    return `La clau és massa llarga: ${MAX_BYTES} caràcters com a màxim (menys si porta accents).`;
  }
  if (new Set(lower(password)).size < MIN_DISTINCT) {
    return 'La clau repeteix massa els mateixos caràcters.';
  }
  const list = commonPasswords();
  if (list.has(lower(password)) || list.has(withoutTrailingDigitsAndSymbols(password))) {
    return 'Aquesta clau és massa comuna: tria-la menys previsible (per exemple, tres o quatre paraules juntes).';
  }
  const plain = lower(password);
  const found = personalWords(context).find((word) => plain.includes(word));
  if (found) {
    return 'La clau no pot contenir el teu correu, el teu nom ni el de l\'entitat.';
  }
  return null;
}

/** The names the password is checked against, read for a user row. */
async function contextFor(user, app = global.strapi) {
  const names = [];
  if (user) names.push(user.fullname, user.display_name);
  try {
    const me = await app.db.query('api::me.me').findOne({ select: ['name'] });
    if (me && me.name) names.push(me.name);
  } catch {
    // without the entity's name
  }
  return {
    email: user && user.email,
    username: user && user.username,
    names: names.filter(Boolean),
  };
}

module.exports = {
  MIN_LENGTH,
  MAX_BYTES,
  passwordProblem,
  personalWords,
  contextFor,
};
