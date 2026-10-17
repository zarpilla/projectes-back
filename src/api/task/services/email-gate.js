'use strict';

/**
 * Who gets the daily task digest.
 *
 * - Each entity turns the notices on or off in Configuració general (`me.task_emails`;
 *   empty counts as on, as before the setting existed). Some entities asked not to
 *   receive them.
 * - TASK_EMAIL_TO is a server-wide limit for development: '*' (production) lets
 *   every address through, an address (or a comma-separated list) only those, and
 *   unset none, so a local copy of a tenant never mails its people.
 */
function taskEmailsEnabled(me) {
  return !me || me.task_emails !== false;
}

function taskEmailAllowed(email, { me, to = process.env.TASK_EMAIL_TO } = {}) {
  if (!email || !taskEmailsEnabled(me)) return false;
  const limit = String(to || '').trim();
  if (!limit) return false;
  if (limit === '*') return true;
  return limit
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .includes(String(email).trim().toLowerCase());
}

module.exports = { taskEmailsEnabled, taskEmailAllowed };
