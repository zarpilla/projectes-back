'use strict';

const moment = require('moment');

/**
 * Date of a treasury row as the app shows it (dd/mm/aaaa), from its YYYYMMDD
 * `datef`. It was built with dashes («20-10-2026», issues/136).
 */
const treasuryDisplayDate = (datef) => moment(datef, 'YYYYMMDD').format('DD/MM/YYYY');

module.exports = { treasuryDisplayDate };
