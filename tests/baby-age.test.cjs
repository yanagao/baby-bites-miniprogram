'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {todayString, isValidBirthDate, ageInMonths, ageLabel} = require('../utils/baby-age');

test('birthday calculation uses the same China calendar day around midnight', () => {
  assert.equal(todayString(Date.parse('2026-10-28T15:59:59Z')), '2026-10-28');
  assert.equal(todayString(Date.parse('2026-10-28T16:00:00Z')), '2026-10-29');
  assert.equal(todayString(Date.parse('2026-12-31T16:00:00Z')), '2027-01-01');
});

test('birthday validation rejects impossible dates, wrong types and future days', () => {
  for (const value of [null, undefined, '', 20260101, {}, [], '2026-1-01', ' 2026-01-01',
    '2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-13-01',
    '2026-01-00', '1899-12-31', '2026-10-30', '2026-10-29T00:00:00Z']) {
    assert.equal(isValidBirthDate(value, '2026-10-29'), false, String(value));
    assert.equal(ageInMonths(value, '2026-10-29'), null, String(value));
  }
  for (const value of ['1900-01-01', '2000-02-29', '2024-02-29', '2026-10-29']) {
    assert.equal(isValidBirthDate(value, '2026-10-29'), true, value);
  }
  assert.equal(isValidBirthDate('2026-01-01', '2026-02-30'), false);
});

test('month age advances on each calendar anniversary, including month ends and leap years', () => {
  for (const [birth, today, months] of [
    ['2026-10-29', '2026-10-29', 0], ['2026-09-30', '2026-10-29', 0],
    ['2026-09-29', '2026-10-29', 1], ['2025-10-30', '2026-10-29', 11],
    ['2025-10-29', '2026-10-29', 12], ['2025-12-31', '2026-01-01', 0],
    ['2026-01-31', '2026-02-27', 0], ['2026-01-31', '2026-02-28', 1],
    ['2026-01-31', '2026-03-30', 1], ['2026-01-31', '2026-03-31', 2],
    ['2024-01-31', '2024-02-28', 0], ['2024-01-31', '2024-02-29', 1],
    ['2024-02-29', '2025-02-27', 11], ['2024-02-29', '2025-02-28', 12],
    ['2024-02-29', '2028-02-28', 47], ['2024-02-29', '2028-02-29', 48],
    ['2016-09-29', '2026-10-29', 121]
  ]) assert.equal(ageInMonths(birth, today), months, `${birth} -> ${today}`);
});

test('public labels distinguish unset, newborn and completed months', () => {
  assert.equal(ageLabel(null), ''); assert.equal(ageLabel(-1), '');
  assert.equal(ageLabel('8'), ''); assert.equal(ageLabel(1.5), '');
  assert.equal(ageLabel(0), '宝宝未满1个月'); assert.equal(ageLabel(8), '宝宝8个月');
  assert.equal(ageLabel(121), '宝宝121个月');
});
