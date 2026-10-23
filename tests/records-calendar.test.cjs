'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const calendar = require('../utils/calendar');
const selectors = require('../utils/selectors');
const seed = require('../data/recipes');
const copy = value => JSON.parse(JSON.stringify(value));
const tap = dataset => ({currentTarget: {dataset}});

function harness(logs = [], recipes = [seed[0], seed[1]]) {
  const state = {recipes: copy(recipes), logs: copy(logs)};
  const navigation = [];
  let now = '2026-10-23';
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/records/index.js'), 'utf8'), {
    Page(value) { definition = value; },
    require(name) {
      if (name.endsWith('/selectors')) return {...selectors, today: () => now};
      if (name.endsWith('/calendar')) return calendar;
      if (name.endsWith('/store')) return {getState: () => state, getWarning: () => ''};
      if (name.endsWith('/tab-bar')) return {syncTabBar() {}};
      throw new Error('Unexpected module ' + name);
    },
    wx: {
      navigateTo(options) { navigation.push(options.url); },
      switchTab(options) { navigation.push(options.url); },
      showToast(options) { throw new Error(options.title); }
    }
  });
  const page = {...definition, data: copy(definition.data),
    setData(update) { Object.assign(this.data, update); }};
  return {page, state, navigation, setToday(value) { now = value; }};
}

const logs = [
  {id: 'today-1', recipeId: seed[0].id, date: '2026-10-23', rating: 3, portion: '吃了一点', note: '喜欢南瓜', createdAt: 5},
  {id: 'today-2', recipeId: seed[0].id, date: '2026-10-23', rating: 2, createdAt: 4},
  {id: 'week-1', recipeId: seed[1].id, date: '2026-10-19', rating: 1, createdAt: 3},
  {id: 'old-1', recipeId: seed[1].id, date: '2026-10-18', rating: 3, createdAt: 2}
];

test('local calendar handles weeks, leap dates and month/year boundaries', () => {
  assert.equal(calendar.weekStart('2026-10-23'), '2026-10-19');
  assert.equal(calendar.weekStart('2026-10-25'), '2026-10-19');
  assert.equal(calendar.weekStart('2026-10-26'), '2026-10-26');
  assert.equal(calendar.shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(calendar.shiftDate('2024-02-28', 1), '2024-02-29');
  assert.equal(calendar.parseDate('2026-02-29'), null);
  assert.equal(calendar.parseDate('2026-13-01'), null);
  assert.equal(calendar.parseDate('not-a-date'), null);
  assert.equal(calendar.monthLabel('2026-10-26'), '10 月 — 11 月');
  const days = calendar.weekDays('2026-10-19', '2026-10-23', '2026-10-23', ['2026-10-22']);
  assert.equal(days.length, 7);
  assert.equal(days[4].today, true);
  assert.equal(days[4].selected, true);
  assert.equal(days[3].hasLog, true);
  assert.equal(days[5].future, true);
});

test('date stepping preserves local date across time zones and daylight-saving changes', () => {
  const source = `const c=require(${JSON.stringify(path.join(__dirname, '../utils/calendar'))});process.stdout.write(JSON.stringify([c.shiftDate('2026-03-08',1),c.shiftDate('2026-11-01',-1),c.weekStart('2026-10-23')]));`;
  ['Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Auckland'].forEach(TZ => {
    const result = execFileSync(process.execPath, ['-e', source], {encoding: 'utf8', env: {...process.env, TZ}});
    assert.deepEqual(JSON.parse(result), ['2026-03-09', '2026-10-31', '2026-10-19']);
  });
});

test('records default to today and count actual entries separately from distinct recipes this week', () => {
  const {page, state} = harness(logs);
  const before = copy(state);
  page.onShow();
  assert.equal(page.data.selectedDate, '2026-10-23');
  assert.equal(page.data.logs.length, 2);
  assert.deepEqual(copy(page.data.stats), {logCount: 3, triedCount: 2});
  assert.equal(page.data.logs[0].note, '喜欢南瓜');
  assert.equal(page.data.logs[0].portion, '吃了一点');
  assert.equal(page.data.canNextWeek, false);
  page.chooseFilter(tap({value: '3'}));
  assert.equal(page.data.logs.length, 1);
  assert.deepEqual(copy(page.data.stats), {logCount: 3, triedCount: 2}, 'summary is not reduced by a display filter');
  page.chooseFilter(tap({value: 'unknown'}));
  assert.equal(page.data.filter, '3');
  assert.deepEqual(state, before);
});

test('week controls preserve weekday, clamp future dates and expose selected-day records', () => {
  const {page} = harness(logs);
  page.onShow();
  page.moveWeek(tap({direction: -1}));
  assert.equal(page.data.weekStart, '2026-10-12');
  assert.equal(page.data.selectedDate, '2026-10-16');
  assert.equal(page.data.canNextWeek, true);
  page.chooseDay(tap({date: '2026-10-18'}));
  assert.equal(page.data.logs[0].id, 'old-1');
  page.moveWeek(tap({direction: 1}));
  assert.equal(page.data.selectedDate, '2026-10-23', 'Sunday in the current week clamps to today');
  page.moveWeek(tap({direction: 1}));
  assert.equal(page.data.weekStart, '2026-10-19');
  page.chooseDay(tap({date: '2026-10-24'}));
  page.chooseDay(tap({date: '2026-02-30'}));
  assert.equal(page.data.selectedDate, '2026-10-23');
  page.chooseDay(tap({date: '2026-10-19'}));
  assert.equal(page.data.logs[0].id, 'week-1');
  page.goToday();
  assert.equal(page.data.logs.length, 2);
});

test('empty days stay empty and recent-record navigation uses real saved dates', () => {
  const {page, state} = harness([logs[3]]);
  const before = copy(state);
  page.onShow();
  assert.equal(page.data.logs.length, 0);
  assert.equal(page.data.stats.logCount, 0);
  assert.equal(page.data.stats.triedCount, 0);
  page.viewLatest();
  assert.equal(page.data.selectedDate, '2026-10-18');
  assert.equal(page.data.logs.length, 1);
  page.previousDay();
  assert.equal(page.data.selectedDate, '2026-10-17');
  assert.equal(page.data.logs.length, 0);
  assert.deepEqual(state, before, 'browsing never fabricates records');
  const empty = harness([], []);
  empty.page.onShow();
  empty.page.viewLatest();
  assert.equal(empty.page.data.latestDate, '');
  assert.equal(empty.page.data.logs.length, 0);
  assert.equal(empty.page.data.recipes.length, 0);
});

test('record picker uses actual recipes and selected date; existing cards open the existing log', () => {
  const {page, navigation, state} = harness(logs);
  const before = copy(state);
  page.onShow();
  page.openRecordPicker();
  assert.equal(page.data.recordPickerVisible, true);
  page.selectRecipe(tap({id: 'missing'}));
  assert.equal(navigation.length, 0);
  page.chooseDay(tap({date: '2026-10-19'}));
  page.selectRecipe(tap({id: seed[0].id}));
  assert.equal(page.data.recordPickerVisible, false);
  assert.equal(navigation[0], '/pages/record-editor/index?id=' + encodeURIComponent(seed[0].id) + '&date=2026-10-19');
  page.editLog(tap({id: 'week-1'}));
  assert.equal(navigation[1], '/pages/record-editor/index?logId=week-1');
  page.editLog(tap({id: 'not-visible'}));
  assert.equal(navigation.length, 2);
  assert.deepEqual(state, before);
});

test('returning after midnight follows today only when today was selected', () => {
  const current = harness();
  current.page.onShow();
  current.setToday('2026-10-24');
  current.page.onShow();
  assert.equal(current.page.data.selectedDate, '2026-10-24');
  const historical = harness();
  historical.page.onShow();
  historical.page.chooseDay(tap({date: '2026-10-19'}));
  historical.setToday('2026-10-24');
  historical.page.onShow();
  assert.equal(historical.page.data.selectedDate, '2026-10-19');
});
