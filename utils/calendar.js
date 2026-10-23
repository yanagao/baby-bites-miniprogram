'use strict';

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parts = value.split('-').map(Number);
  // Local noon avoids UTC date shifts and midnight daylight-saving transitions.
  const date = new Date(parts[0], parts[1] - 1, parts[2], 12);
  return date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 &&
    date.getDate() === parts[2] ? date : null;
}

function formatDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
}

function shiftDate(value, amount) {
  const date = parseDate(value);
  if (!date || !Number.isInteger(amount)) return '';
  date.setDate(date.getDate() + amount);
  return formatDate(date);
}

function weekStart(value) {
  const date = parseDate(value);
  return date ? shiftDate(value, -((date.getDay() + 6) % 7)) : '';
}

function weekDays(start, selected, today, loggedDates) {
  const logged = new Set(loggedDates || []);
  return ['一', '二', '三', '四', '五', '六', '日'].map((weekday, index) => {
    const date = shiftDate(start, index);
    return {date, weekday, day: Number(date.slice(-2)), selected: date === selected,
      today: date === today, future: date > today, hasLog: logged.has(date)};
  });
}

function monthLabel(start) {
  const end = shiftDate(start, 6);
  const first = Number(start.slice(5, 7));
  const last = Number(end.slice(5, 7));
  return first === last ? first + ' 月' : first + ' 月 — ' + last + ' 月';
}

function dayLabel(value) {
  return Number(value.slice(5, 7)) + ' 月 ' + Number(value.slice(8, 10)) + ' 日';
}

function weeklyStats(logs, today) {
  const start = weekStart(today);
  const current = logs.filter(log => log.date >= start && log.date <= today);
  return {logCount: current.length, triedCount: new Set(current.map(log => log.recipeId)).size};
}

module.exports = {parseDate, formatDate, shiftDate, weekStart, weekDays, monthLabel, dayLabel, weeklyStats};
