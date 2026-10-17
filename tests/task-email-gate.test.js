'use strict';

/**
 * Daily task digest recipients: the entity's switch in Configuració general
 * ("Avisos de tasques per correu", some entities asked not to receive them) and
 * TASK_EMAIL_TO as the server limit ('*' in production, an address in development).
 */
const { taskEmailAllowed, taskEmailsEnabled } = require('../src/api/task/services/email-gate');

describe('task email gate', () => {
  it('sends to everyone with "*" while the entity has the notices on (empty counts as on)', () => {
    expect(taskEmailAllowed('anna@coop.cat', { me: { task_emails: true }, to: '*' })).toBe(true);
    expect(taskEmailAllowed('anna@coop.cat', { me: { task_emails: null }, to: '*' })).toBe(true);
    expect(taskEmailAllowed('anna@coop.cat', { me: {}, to: '*' })).toBe(true);
  });

  it('sends nothing when the entity turned them off', () => {
    expect(taskEmailsEnabled({ task_emails: false })).toBe(false);
    expect(taskEmailAllowed('anna@coop.cat', { me: { task_emails: false }, to: '*' })).toBe(false);
  });

  it('in development only the listed addresses, and nobody when unset', () => {
    const saved = process.env.TASK_EMAIL_TO;
    delete process.env.TASK_EMAIL_TO;
    expect(taskEmailAllowed('dev@coop.cat', { me: {}, to: 'dev@coop.cat' })).toBe(true);
    expect(taskEmailAllowed('Dev@Coop.cat', { me: {}, to: 'x@y.z, dev@coop.cat' })).toBe(true);
    expect(taskEmailAllowed('anna@coop.cat', { me: {}, to: 'dev@coop.cat' })).toBe(false);
    expect(taskEmailAllowed('anna@coop.cat', { me: {}, to: '' })).toBe(false);
    expect(taskEmailAllowed('anna@coop.cat', { me: {} })).toBe(false);
    if (saved !== undefined) process.env.TASK_EMAIL_TO = saved;
  });
});
