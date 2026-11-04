'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const calendar = require('../utils/calendar');
const clone = value => JSON.parse(JSON.stringify(value));
const TODAY = '2026-11-04';
const MEALS = [{value: 'breakfast', label: '早餐'}, {value: 'lunch', label: '午餐'}, {value: 'dinner', label: '晚餐'}];
const planId = (date, meal) => 'meal-' + date + '-' + meal;
const recipe = (id, name) => ({id, name, minutes: 20, texture: '软烂颗粒', ingredients: [{name: '南瓜', amount: ''}], steps: ['蒸熟']});
const plan = (date = '2026-11-05', meal = 'breakfast', recipeId = 'a') => ({id: planId(date, meal), date, meal, recipeId, createdAt: 1, updatedAt: 2});
const event = dataset => ({currentTarget: {dataset}});
function setup(options = {}) {
  let info = {owner: 'alice', scopeKey: 'personal:alice', scope: {kind: 'personal', id: 'alice'}};
  const state = {nickname: '宝宝', recipes: [recipe('a', '南瓜小米粥'), recipe('b', '菠菜鸡蛋饼')], logs: [], ...options.state};
  const calls = {save: [], toast: [], navigate: [], back: 0, switchTab: [], alert: [], disableAlert: 0};
  const listeners = new Set(), hooks = {};
  const store = {getSyncInfo: () => clone(info), getState: () => clone(state), getRecipe: id => state.recipes.find(item => item.id === id),
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    saveMealPlans(entries, settings) {calls.save.push(clone({entries, settings})); if (hooks.save) hooks.save(entries, settings);}};
  const selectors = {today: () => TODAY, listRecipes(data, options = {}) {
    const search = String(options.search || '');
    return data.recipes.filter(item => !search || item.name.includes(search) || item.ingredients.some(value => value.name.includes(search)))
      .map(item => ({...item, displayPhoto: '/test.png', ageLabel: '不限月龄', allergyWarning: data.allergies && data.allergies.length ? '含已记录的过敏食物：鸡蛋' : ''}));
  }};
  let definition;
  const wx = {showToast(value) {calls.toast.push(value.title);}, navigateBack() {calls.back++;},
    switchTab(value) {calls.switchTab.push(value.url);}, navigateTo(value) {calls.navigate.push(value.url);},
    enableAlertBeforeUnload(value) {calls.alert.push(value.message);}, disableAlertBeforeUnload() {calls.disableAlert++;}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/meal-plan/index.js'), 'utf8'), {
    Page(value) {definition = value;}, wx, getCurrentPages: () => options.pages || Array(options.depth == null ? 2 : options.depth).fill({}), require(name) {
      if (name.endsWith('/store')) return store;
      if (name.endsWith('/selectors')) return selectors;
      if (name.endsWith('/calendar')) return calendar;
      if (name.endsWith('/meal-plans')) return {MEALS, planId};
      throw Error(name);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(value) {Object.assign(this.data, clone(value));}};
  page.onLoad(options.query || {});
  return {page, calls, hooks, state, listeners, changeInfo(patch) {info = {...info, ...patch}; listeners.forEach(fn => fn(clone(info)));}};
}
function choose(app, date, meal, id = 'a') {
  app.page.openPicker(event({date, meal})); app.page.selectRecipe(event({id}));
}

test('a new week starts tomorrow with 21 empty slots and remains read-only until confirmation', () => {
  const app = setup(); app.page.onShow();
  assert.equal(app.page.data.start, '2026-11-05'); assert.equal(app.page.data.end, '2026-11-11');
  assert.equal(app.page.data.days.length, 7); assert.equal(app.page.data.days[0].weekday, '四');
  assert.equal(app.page.data.count, 0); assert.equal(app.page._draft.length, 21);
  assert.ok(app.page._draft.every(item => !item.recipeId)); assert.equal(app.calls.save.length, 0);
  app.page.save(); assert.match(app.page.data.error, /至少一餐/); assert.equal(app.calls.save.length, 0);
  app.page.back(); assert.equal(app.calls.back, 1); assert.equal(app.page.data.discardVisible, false);
});

test('manual selection, search and changing a dish modify only the local draft', () => {
  const app = setup({state: {allergies: ['鸡蛋']}});
  app.page.openPicker(event({date: '2026-11-05', meal: 'breakfast'}));
  app.page.searchRecipes({detail: {value: '菠菜'}});
  assert.equal(app.page.data.pickerRecipes.length, 1); assert.match(app.page.data.pickerRecipes[0].allergyWarning, /鸡蛋/);
  app.page.selectRecipe(event({id: 'b'}));
  assert.equal(app.page.data.count, 1); assert.equal(app.calls.save.length, 0); assert.equal(app.state.mealPlans, undefined);
  choose(app, '2026-11-05', 'breakfast', 'a');
  assert.equal(app.page.data.visibleDays[0].meals[0].recipe.id, 'a'); assert.equal(app.page.data.count, 1);
  assert.equal(app.calls.save.length, 0); assert.equal(app.page.dirty(), true);
});

test('confirmation persists only selected meals with the original baseline and cannot double submit', () => {
  const existing = plan();
  const app = setup({state: {mealPlans: [existing]}});
  assert.equal(app.page.data.count, 1);
  choose(app, '2026-11-06', 'lunch', 'b'); app.page.save(); app.page.save();
  assert.equal(app.calls.save.length, 1); assert.equal(app.calls.save[0].entries.length, 2);
  assert.deepEqual(app.calls.save[0].settings.expected, [existing]);
  assert.deepEqual(app.calls.save[0].entries[1], {date: '2026-11-06', meal: 'lunch', recipeId: 'b'});
  assert.equal(app.calls.back, 1); assert.equal(app.calls.toast[0], '餐单已确认');
});

test('failed persistence preserves choices and allows retry without losing the baseline', () => {
  const app = setup(); choose(app, '2026-11-05', 'dinner', 'b');
  app.hooks.save = () => {throw Error('餐单已被家人修改，请重新加载');}; app.page.save();
  assert.match(app.page.data.error, /家人修改/); assert.equal(app.page.data.saving, false);
  assert.equal(app.page.data.count, 1); assert.equal(app.calls.back, 0); assert.equal(app.page.dirty(), true);
  delete app.hooks.save; app.page.save();
  assert.deepEqual(app.calls.save[1], app.calls.save[0]); assert.equal(app.calls.back, 1);
});

test('completed dishes are retained and cannot be replaced or opened for selection', () => {
  const existing = plan(TODAY, 'breakfast');
  const app = setup({query: {start: TODAY}, state: {mealPlans: [existing], logs: [{date: TODAY, meal: 'breakfast', recipeId: 'a', rating: 0}]}});
  assert.equal(app.page.data.visibleDays[0].meals[0].completed, true);
  app.page.openPicker(event({date: TODAY, meal: 'breakfast'}));
  assert.equal(app.page.data.pickerVisible, false);
  choose(app, TODAY, 'lunch', 'b'); app.page.save();
  assert.equal(app.calls.save[0].entries.find(item => item.meal === 'breakfast').recipeId, 'a');
});

test('day and whole-week views preserve choices and do not persist or reload the draft', () => {
  const app = setup(); choose(app, '2026-11-07', 'lunch');
  app.page.chooseDay(event({date: '2026-11-07'}));
  assert.equal(app.page.data.visibleDays[0].date, '2026-11-07');
  app.page.toggleWeek(); assert.equal(app.page.data.visibleDays.length, 7);
  app.page.onShow(); app.page.toggleWeek();
  assert.equal(app.page.data.visibleDays[0].meals[1].recipe.id, 'a'); assert.equal(app.calls.save.length, 0);
});

test('changing the date range confirms before discarding unsaved choices and preserves confirmed entries', () => {
  const existing = plan('2026-11-12', 'dinner', 'b');
  const app = setup({state: {mealPlans: [existing]}}); choose(app, '2026-11-05', 'breakfast');
  app.page.changeStart({detail: {value: '2026-11-12'}});
  assert.equal(app.page.data.start, '2026-11-05'); assert.equal(app.page.data.discardVisible, true);
  app.page.cancelDiscard(); assert.equal(app.page.data.count, 1);
  app.page.changeStart({detail: {value: '2026-11-12'}}); app.page.confirmDiscard();
  assert.equal(app.page.data.start, '2026-11-12'); assert.equal(app.page.data.count, 1);
  assert.equal(app.page.data.visibleDays[0].meals[2].recipe.id, 'b'); assert.equal(app.page.dirty(), false);
  assert.equal(app.calls.save.length, 0); assert.deepEqual(app.state.mealPlans, [existing]);
});

test('discarding an edited draft leaves without saving while cancel keeps the draft', () => {
  const app = setup(); choose(app, '2026-11-05', 'breakfast'); app.page.back();
  assert.equal(app.page.data.discardVisible, true); assert.equal(app.calls.back, 0);
  app.page.cancelDiscard(); assert.equal(app.page.data.count, 1);
  app.page.back(); app.page.confirmDiscard();
  assert.equal(app.calls.back, 1); assert.equal(app.calls.save.length, 0);
});

test('account and family ABA switches immediately clear the draft and block stale events', () => {
  for (const mode of ['account', 'family']) {
    const app = setup(); choose(app, '2026-11-05', 'breakfast');
    if (mode === 'account') {app.changeInfo({owner: 'bob', scopeKey: 'personal:bob'}); app.changeInfo({owner: 'alice', scopeKey: 'personal:alice'});}
    else {app.changeInfo({scopeKey: 'family:other', scope: {kind: 'family', id: 'other'}}); app.changeInfo({scopeKey: 'personal:alice', scope: {kind: 'personal', id: 'alice'}});}
    assert.equal(app.page.data.locked, true); assert.deepEqual(app.page.data.visibleDays, []);
    assert.equal(app.page._draft.length, 0); assert.equal(app.page.data.pickerVisible, false);
    app.page.selectRecipe(event({id: 'a'})); app.page.save(); app.page.onShow();
    assert.equal(app.calls.save.length, 0); assert.equal(app.page.data.count, 0);
  }
});

test('unload unsubscribes and stale selections or saves do not mutate data', () => {
  const app = setup(); choose(app, '2026-11-05', 'breakfast'); app.page.onUnload();
  assert.equal(app.listeners.size, 0); app.page.save(); app.page.onShow();
  assert.equal(app.calls.save.length, 0);
});

test('direct opening supports a requested day and meal and returns to the records tab on save', () => {
  const app = setup({depth: 1, query: {start: TODAY, date: '2026-11-06', meal: 'lunch'}});
  app.page.onReady(); assert.equal(app.page.data.selectedDate, '2026-11-06');
  assert.equal(app.page.data.pickerVisible, true); assert.equal(app.page.data.pickerMeal, 'lunch');
  app.page.selectRecipe(event({id: 'a'})); app.page.save();
  assert.deepEqual(app.calls.switchTab, ['/pages/records/index']);
});

test('successful confirmation returns the selected draft date only to the same-scope records page', () => {
  for (const target of ['records', 'other-route', 'other-scope', 'missing-method']) {
    const dates = [];
    const previous = {route: target === 'other-route' ? 'pages/home/index' : 'pages/records/index',
      _scope: target === 'other-scope' ? 'family:other' : 'personal:alice'};
    if (target !== 'missing-method') previous.selectConfirmedDate = (date, scope) => dates.push({date, scope});
    const app = setup({pages: [previous, {}]});
    choose(app, '2026-11-07', 'dinner'); app.page.chooseDay(event({date: '2026-11-07'})); app.page.save();
    assert.deepEqual(dates, target === 'records' ? [{date: '2026-11-07', scope: 'personal:alice'}] : []);
    assert.equal(app.calls.back, 1);
  }
});

test('cancel, save failure and a scope change during persistence never change the opener date', () => {
  for (const mode of ['cancel', 'failure', 'scope-change']) {
    const dates = [];
    const app = setup({pages: [{route: 'pages/records/index', _scope: 'personal:alice', selectConfirmedDate: date => dates.push(date)}, {}]});
    choose(app, '2026-11-07', 'lunch'); app.page.chooseDay(event({date: '2026-11-07'}));
    if (mode === 'cancel') {app.page.back(); app.page.confirmDiscard();}
    else {
      app.hooks.save = mode === 'failure' ? () => {throw Error('存储空间不足');} : () => app.changeInfo({owner: 'bob', scopeKey: 'personal:bob'});
      app.page.save();
    }
    assert.deepEqual(dates, []);
    assert.equal(app.calls.back, mode === 'cancel' ? 1 : 0);
  }
});

test('confirming while viewing an empty day returns to the first day that actually has a meal', () => {
  const dates = [];
  const previous = {route: 'pages/records/index', _scope: 'personal:alice', selectConfirmedDate: date => dates.push(date)};
  const app = setup({pages: [previous, {}]});
  choose(app, '2026-11-05', 'dinner'); app.page.chooseDay(event({date: '2026-11-07'})); app.page.save();
  assert.deepEqual(dates, ['2026-11-05']); assert.equal(app.calls.back, 1);
});

test('deleted choices are visible as missing and invalid or out-of-range UI events are ignored', () => {
  const app = setup(); choose(app, '2026-11-05', 'breakfast');
  app.state.recipes = app.state.recipes.filter(item => item.id !== 'a'); app.page.onShow();
  assert.equal(app.page.data.visibleDays[0].meals[0].missing, true); assert.equal(app.page.data.count, 0);
  app.page.chooseDay(event({date: '2026-12-01'})); assert.equal(app.page.data.selectedDate, '2026-11-05');
  app.page.openPicker(event({date: '2026-12-01', meal: 'breakfast'})); assert.equal(app.page.data.pickerVisible, false);
  app.page.changeStart({detail: {value: '2026-02-30'}}); assert.equal(app.page.data.start, '2026-11-05');
});
