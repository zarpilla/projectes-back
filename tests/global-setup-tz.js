'use strict';

// The containers run in UTC: so do the tests, wherever they run, or a bug that
// reads a day or an hour in the server's zone passes on a Madrid laptop and
// shows only in production (issues/346). Set before the workers start, as
// Node fixes a process's zone on first use.
module.exports = async () => {
  process.env.TZ = 'UTC';
};
