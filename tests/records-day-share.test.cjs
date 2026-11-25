'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const selectors = require('../utils/selectors');
const calendar = require('../utils/calendar');
const plans = require('../utils/meal-plans');
const publicPlans = require('../utils/public-meal-plans');
const copy = value => JSON.parse(JSON.stringify(value));
const OWNER = 'a'.repeat(64), PROFILE = 'b'.repeat(32), PUBLIC = 'c'.repeat(64);
function setup() {
  const today = selectors.today();
  const recipe = {...copy(require('../data/recipes')[0]), id: 'my-recipe', isExample: false, updatedAt: 1, note: '私人心得'};
  const state = {nickname: '私人宝宝称呼', recipes: [recipe], logs: [], mealPlans: [{id: plans.planId(today, 'breakfast'), date: today, meal: 'breakfast', recipeId: recipe.id}]};
  const info = {owner: OWNER, scopeKey: OWNER, scope: {kind: 'personal', id: OWNER}, dirty: false};
  const listeners = new Set(), calls = [], hooks = {};
  const store = {getState: () => copy(state), getSyncInfo: () => ({...info}), getWarning: () => '',
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}};
  const social = {async getMealPlanShareLink(date) {
    calls.push(date);
    if (hooks.share) return hooks.share(date);
    return {date, author: {id: PROFILE, name: '公开的小厨房'}, meals: [{meal: 'breakfast', label: '早餐', recipe: {id: PUBLIC, name: '南瓜粥', kind: 'public'}}], localVersion: publicPlans.dayVersion(state, date)};
  }};
  let definition;
  vm.runInNewContext(fs.readFileSync(require.resolve('../pages/records/index.js'), 'utf8'), {Page(value) {definition = value;},
    wx: {showToast(value) {calls.push(value.title);}}, require(name) {
      if (name.endsWith('/store')) return store;
      if (name.endsWith('/social')) return social;
      if (name.endsWith('/selectors')) return selectors;
      if (name.endsWith('/calendar')) return calendar;
      if (name.endsWith('/meal-plans')) return plans;
      if (name.endsWith('/public-meal-plans')) return publicPlans;
      if (name.endsWith('/tab-bar')) return {syncTabBar() {}};
      throw Error(name);
    }});
  const page = {...definition, data: copy(definition.data), setData(update) {Object.assign(this.data, copy(update));}};
  page.onLoad(); page.onShow();
  return {page, state, info, hooks, calls, listeners, today,
    notify() {listeners.forEach(fn => fn(info));},
    select(date) {page.chooseDay({currentTarget: {dataset: {date}}});}};
}

test('day share prepares the selected confirmed day and shares a public path without private fields', async () => {
  const app = setup();
  assert.equal(app.calls.length, 0, 'viewing the calendar stays local');
  await app.page.openDayShare();
  assert.deepEqual(app.calls, [app.today]);
  assert.equal(app.page.data.dayShareVisible, true);
  assert.equal(app.page.data.dayShareLoading, false);
  assert.equal(app.page.data.dayShareMeals[0].name, '南瓜粥');
  const share = app.page.onShareAppMessage();
  assert.equal(share.path, '/pages/public-meal-plan/index?profileId=' + PROFILE + '&date=' + app.today);
  assert.doesNotMatch(JSON.stringify(share), /私人|my-recipe|owner|scope|allerg/);
});

test('empty days cannot prepare a share and changing dates discards a previously prepared share', async () => {
  const app = setup();
  await app.page.openDayShare();
  app.select(calendar.shiftDate(app.today, 1));
  assert.equal(app.page.data.dayShareVisible, false);
  assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
  await app.page.openDayShare();
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1], '先安排这一天的餐单');
});

test('changes to a prepared day invalidate the card and permit retrying', async () => {
  const app = setup(); await app.page.openDayShare();
  app.state.recipes[0].name = '换了一道菜'; app.info.dirty = true; app.notify();
  assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
  assert.match(app.page.data.dayShareError, /已有更新/);
  app.info.dirty = false;
  await app.page.openDayShare();
  assert.equal(app.page.data.dayShareError, '');
  assert.match(app.page.onShareAppMessage().path, /public-meal-plan/);
});

test('date changes, closing, unloading and scope ABA discard a late sharing response', async () => {
  for (const action of ['date', 'close', 'unload', 'scope']) {
    const app = setup(); let resolve;
    app.hooks.share = () => new Promise(done => {resolve = done;});
    const pending = app.page.openDayShare();
    if (action === 'date') app.select(calendar.shiftDate(app.today, 1));
    if (action === 'close') app.page.closeDayShare();
    if (action === 'unload') app.page.onUnload();
    if (action === 'scope') {app.info.scopeKey = 'other-family'; app.notify(); app.info.scopeKey = OWNER; app.notify();}
    resolve({date: app.today, author: {id: PROFILE, name: '公开的小厨房'}, meals: [{meal: 'breakfast', label: '早餐', recipe: null}], localVersion: publicPlans.dayVersion(app.state, app.today)});
    await pending;
    assert.equal(app.page._dayShare, null, action);
    assert.equal(app.page.onShareAppMessage().path, '/pages/home/index', action);
  }
});

test('preparation errors show retry without exposing a stale native share', async () => {
  const app = setup(); app.hooks.share = async () => {throw Error('网络暂不可用');};
  await app.page.openDayShare();
  assert.equal(app.page.data.dayShareLoading, false);
  assert.equal(app.page.data.dayShareError, '网络暂不可用');
  assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
  delete app.hooks.share;
  await app.page.openDayShare();
  assert.equal(app.page.data.dayShareError, '');
});

test('a confirmed date change during preparation closes the pending share without leaving a spinner', async () => {
  const app = setup(); let resolve;
  app.hooks.share = () => new Promise(done => {resolve = done;});
  const pending = app.page.openDayShare();
  app.page.selectConfirmedDate(calendar.shiftDate(app.today, 1), OWNER);
  resolve({date: app.today, author: {id: PROFILE, name: '公开的小厨房'}, meals: [], localVersion: ''});
  await pending;
  assert.equal(app.page.data.dayShareVisible, false);
  assert.equal(app.page.data.dayShareLoading, false);
  assert.equal(app.page._dayShare, null);
});
