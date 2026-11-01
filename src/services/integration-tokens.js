'use strict';

const UID = 'api::me.me';

// An integration's stored key goes only to the address it was given for
// (issues/404): an admin who pointed `dir3_api_url` to her own host got the
// write-only key (issues/159) in the next DIR3 search. A new address needs the
// key again, unless it comes in the same save.
const URL_TOKENS = [
  ['dir3_api_url', 'dir3_api_token'],
  ['invoice_parser_api_url', 'invoice_parser_api_token'],
];

const sameUrl = (a, b) => String(a || '').trim().replace(/\/+$/, '') === String(b || '').trim().replace(/\/+$/, '');

async function dropTokensOfMovedUrls(params) {
  const data = params && params.data;
  if (!data || typeof data !== 'object') return;
  const moved = URL_TOKENS.filter(([url, token]) => url in data && !data[token]);
  if (!moved.length) return;
  const stored = await strapi.db
    .query(UID)
    .findOne({ where: params.where || {}, select: ['id', ...moved.flat()] });
  if (!stored) return;
  for (const [url, token] of moved) {
    if (stored[token] && !sameUrl(stored[url], data[url])) data[token] = null;
  }
}

module.exports = { dropTokensOfMovedUrls, sameUrl };
