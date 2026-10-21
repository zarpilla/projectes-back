'use strict';

const moment = require('moment');

const { dayNumberOf } = require('../../project/services/projectFinancials');

// A real calendar day written as YYYYMMDD (what moment accepts as valid).
const isDay = (datef) =>
  typeof datef === 'string' &&
  /^\d{8}$/.test(datef) &&
  !Number.isNaN(dayNumberOf(+datef.substring(0, 4), +datef.substring(4, 6), +datef.substring(6, 8)));

/**
 * Date of a treasury row as the app shows it (dd/mm/aaaa), from its YYYYMMDD
 * `datef`. It was built with dashes («20-10-2026», issues/136). Without moment
 * for a plain YYYYMMDD: once per treasury row (issues/309).
 */
const treasuryDisplayDate = (datef) =>
  isDay(datef)
    ? `${datef.substring(6, 8)}/${datef.substring(4, 6)}/${datef.substring(0, 4)}`
    : moment(datef, 'YYYYMMDD').format('DD/MM/YYYY');

module.exports = { treasuryDisplayDate };
