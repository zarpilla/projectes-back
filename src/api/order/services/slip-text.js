'use strict';

/**
 * Texts of the order slip (albarà PDF). The time slots are stored as decimal
 * hours and the kilos as a decimal: the slip read «De 9.5h a 13.5h» and
 * «13.8 kg» instead of «De 9:30 a 13:30» and «13,8 kg» (issues/298).
 */

/** 9.5 → «9:30», 18 → «18:00». */
function hourText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  let hours = Math.floor(n);
  let minutes = Math.round((n - hours) * 60);
  if (minutes === 60) {
    hours += 1;
    minutes = 0;
  }
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

/** «De 9:30 a 13:30», or null when the slot is not set. */
function timeSlotText(start, end) {
  if (start === null || start === undefined || start === '' || end === null || end === undefined || end === '') {
    return null;
  }
  return `De ${hourText(start)} a ${hourText(end)}`;
}

/** Kilos with a decimal comma and at most two decimals: «13,8». */
function kilogramsText(value) {
  const n = Number(value) || 0;
  return String(Math.round(n * 100) / 100).replace('.', ',');
}

/** «3 caixes - 13,8 kg». */
function loadText(order) {
  const units = Number(order.units) || 0;
  return `${units} ${units === 1 ? 'caixa' : 'caixes'} - ${kilogramsText(order.kilograms)} kg`;
}

module.exports = { hourText, timeSlotText, kilogramsText, loadText };
