'use strict';

// Use the same calendar day on the phone and in the cloud, regardless of the
// device timezone. A date-only birthday must never be parsed as local midnight.
function todayString(now = Date.now()) {
  return new Date(Number(now) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dateParts(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return {year, month, day};
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidBirthDate(value, today = todayString()) {
  return !!dateParts(value) && !!dateParts(today) && value <= today;
}

function ageInMonths(value, today = todayString()) {
  if (!isValidBirthDate(value, today)) return null;
  const birth = dateParts(value), current = dateParts(today);
  let months = (current.year - birth.year) * 12 + current.month - birth.month;
  // A month-end birthday reaches its next month on that month's last day when
  // the corresponding day does not exist (e.g. January 31 -> February 28).
  const anniversary = Math.min(birth.day, daysInMonth(current.year, current.month));
  if (current.day < anniversary) months -= 1;
  return months;
}

function ageLabel(months) {
  if (!Number.isSafeInteger(months) || months < 0) return '';
  return months === 0 ? '宝宝未满1个月' : '宝宝' + months + '个月';
}

module.exports = {todayString, isValidBirthDate, ageInMonths, ageLabel};
