'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const selectors = require('../utils/selectors');
const calendar = require('../utils/calendar');
const mealPlans = require('../utils/meal-plans');
const root = path.resolve(__dirname, '..');
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const FAMILY = {kind: 'family', id: 'c'.repeat(64), membershipId: 'd'.repeat(32)};
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const tap = values => ({currentTarget: {dataset: values}});

function setup() {
  const storage = new Map(), calls = {writes: 0, navigation: [], toasts: [], plans: [], completion: [], cloud: 0};
  let failWrites = false, definition;
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync(key, value) {
      if (failWrites) throw Error('quota');
      calls.writes++; storage.set(key, clone(value));
    },
    navigateTo(options) {calls.navigation.push(options.url);},
    showToast(options) {calls.toasts.push(options.title);},
    cloud: {callFunction() {calls.cloud++; throw Error('No cloud reads while viewing local meals');}}
  };
  const storeFile = path.join(root, 'utils/store.js'), module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(storeFile, 'utf8'), {wx, module, require: createRequire(storeFile)});
  const store = module.exports;
  store.bindAccount(OWNER);
  const ids = store.getState().recipes.slice(0, 3).map(recipe => recipe.id);
  const nativeSavePlans = store.saveMealPlans, nativeComplete = store.completeMeal;
  store.saveMealPlans = (...args) => {calls.plans.push(clone(args)); return nativeSavePlans(...args);};
  store.completeMeal = input => {calls.completion.push(clone(input)); return nativeComplete(input);};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/records/index.js'), 'utf8'), {
    wx, Page(value) {definition = value;}, require(name) {
      if (name.endsWith('/store')) return store;
      if (name.endsWith('/selectors')) return selectors;
      if (name.endsWith('/calendar')) return calendar;
      if (name.endsWith('/meal-plans')) return mealPlans;
      if (name.endsWith('/tab-bar')) return {syncTabBar() {}};
      throw Error('Unexpected records dependency: ' + name);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(value) {Object.assign(this.data, clone(value));}};
  page.onLoad(); page.onShow();
  function selectDay(date) {page.chooseDay(tap({date, scope: page.data.scope}));}
  function setPlan(recipeId = ids[0], meal = 'breakfast', date = selectors.today()) {
    const [plan] = nativeSavePlans([{date, meal, recipeId}]); page.refresh(); return plan;
  }
  return {page, store, calls, ids, selectDay, setPlan, failWrites(value = true) {failWrites = value;}};
}

test('daily meal browsing stays local and shows three empty slots without inventing plans or logs', () => {
  const app = setup(), before = app.store.getState(), writes = app.calls.writes;
  app.page.onShow(); app.page.onShow();
  assert.deepEqual(app.page.data.rows.map(row => row.value), ['breakfast', 'lunch', 'dinner']);
  assert.ok(app.page.data.rows.every(row => row.cards.length === 0));
  assert.equal(app.page.data.plannedCount, 0); assert.equal(app.page.data.planStatus, '');
  assert.deepEqual(app.store.getState(), before); assert.equal(app.calls.writes, writes); assert.equal(app.calls.cloud, 0);
});

test('selecting a recipe is only a plan draft until confirmation and cancellation discards it', () => {
  const app = setup(), [a] = app.ids, scope = app.page.data.scope;
  const before = app.store.getState(), writes = app.calls.writes;
  app.page.choosePlan(tap({meal: 'lunch', scope}));
  app.page.selectRecipe(tap({id: a, scope}));
  assert.equal(app.page.data.pickerSelected, a); assert.equal(app.calls.plans.length, 0);
  assert.deepEqual(app.store.getState(), before); assert.equal(app.calls.writes, writes);
  app.page.closeRecordPicker(); app.page.savePickedPlan();
  assert.equal(app.calls.plans.length, 0); assert.equal(app.page.data.pickerSelected, '');
  app.page.choosePlan(tap({meal: 'lunch', scope})); app.page.selectRecipe(tap({id: a, scope}));
  app.page.savePickedPlan();
  assert.equal(app.calls.plans.length, 1); assert.equal(app.page.data.recordPickerVisible, false);
  assert.equal(app.store.getState().mealPlans[0].meal, 'lunch');
  assert.equal(app.store.getState().logs.length, 0); assert.equal(app.page.data.plannedCount, 1);
});

test('a failed plan save keeps the draft open and selected for a successful retry', () => {
  const app = setup(), [a] = app.ids;
  app.page.choosePlan(tap({meal: 'dinner'})); app.page.selectRecipe(tap({id: a}));
  const before = app.store.getState(); app.failWrites(); app.page.savePickedPlan();
  assert.equal(app.page.data.recordPickerVisible, true); assert.equal(app.page.data.savingPlan, false);
  assert.equal(app.page.data.pickerSelected, a); assert.match(app.page.data.error, /保存失败/);
  assert.deepEqual(app.store.getState(), before);
  app.failWrites(false); app.page.savePickedPlan();
  assert.equal(app.page.data.recordPickerVisible, false); assert.equal(app.store.getState().mealPlans.length, 1);
});

test('a same-scope concurrent plan change cannot be overwritten by an old daily draft', () => {
  const app = setup(), [a, b, c] = app.ids;
  app.setPlan(a); app.page.choosePlan(tap({meal: 'breakfast'})); app.page.selectRecipe(tap({id: b}));
  app.store.saveMealPlans([{date: selectors.today(), meal: 'breakfast', recipeId: c}]);
  app.page.savePickedPlan();
  assert.equal(app.page.data.recordPickerVisible, true); assert.match(app.page.data.error, /已被更新/);
  assert.equal(app.store.getState().mealPlans[0].recipeId, c);
});

test('a planned meal can be completed with neither rating nor portion and cannot be double-submitted', () => {
  const app = setup(), [a] = app.ids, plan = app.setPlan(a);
  app.page.openCompletion(tap({id: plan.id, scope: app.page.data.scope}));
  assert.equal(app.page.data.completeVisible, true); assert.equal(app.store.getState().logs.length, 0);
  assert.equal(app.page.data.completionRating, 0); assert.equal(app.page.data.completionPortion, '');
  app.page.completeMeal(); app.page.completeMeal();
  assert.equal(app.calls.completion.length, 1);
  assert.deepEqual(app.calls.completion[0], {planId: plan.id, recipeId: a, rating: 0, portion: '', note: ''});
  assert.equal(app.page.data.completeVisible, false); assert.equal(app.store.getState().logs.length, 1);
  assert.equal(app.page.data.rows[0].cards[0].log.rating, 0);
});

test('optional completion selections can be toggled off and a failed completion preserves the form', () => {
  const app = setup(), plan = app.setPlan();
  app.page.openCompletion(tap({id: plan.id}));
  app.page.rateCompletion(tap({value: 3})); app.page.rateCompletion(tap({value: 3}));
  app.page.portionCompletion(tap({value: '吃了一些'})); app.page.portionCompletion(tap({value: '吃了一些'}));
  assert.equal(app.page.data.completionRating, 0); assert.equal(app.page.data.completionPortion, '');
  app.page.rateCompletion(tap({value: 2})); app.page.portionCompletion(tap({value: '光盘啦'}));
  app.failWrites(); app.page.completeMeal();
  assert.equal(app.page.data.completeVisible, true); assert.equal(app.page.data.completing, false);
  assert.equal(app.page.data.completionRating, 2); assert.equal(app.page.data.completionPortion, '光盘啦');
  assert.match(app.page.data.error, /保存失败/); assert.equal(app.store.getState().logs.length, 0);
  app.failWrites(false); app.page.completeMeal();
  assert.equal(app.store.getState().logs[0].rating, 2); assert.equal(app.store.getState().logs[0].portion, '光盘啦');
});

test('a displayed completion cannot record a new dish after another family member changes the plan', () => {
  const app = setup(), [a, b] = app.ids, plan = app.setPlan(a);
  app.page.openCompletion(tap({id: plan.id}));
  app.store.saveMealPlans([{date: plan.date, meal: plan.meal, recipeId: b}]);
  app.page.completeMeal();
  assert.match(app.page.data.error, /已有变化/); assert.equal(app.page.data.completeVisible, true);
  assert.equal(app.store.getState().logs.length, 0); assert.equal(app.calls.completion[0].recipeId, a);
  app.page.closeCompletion(); app.page.refresh(); app.page.openCompletion(tap({id: plan.id})); app.page.completeMeal();
  assert.equal(app.store.getState().logs[0].recipeId, b);
});

test('stale meal cards cannot open a completion after their plan is replaced or removed', () => {
  for (const operation of ['replace', 'remove']) {
    const app = setup(), [a, b] = app.ids, plan = app.setPlan(a);
    if (operation === 'replace') app.store.saveMealPlans([{date: plan.date, meal: plan.meal, recipeId: b}]);
    else app.store.removeMealPlan(plan.id);
    app.page.openCompletion(tap({id: plan.id}));
    assert.equal(app.page.data.completeVisible, false); assert.equal(app.calls.completion.length, 0);
  }
});

test('account and family ABA changes clear pending completion and draft even after returning to the same scope', () => {
  for (const change of ['account', 'family']) {
    for (const modal of ['complete', 'picker']) {
      const app = setup(), [a, b] = app.ids, plan = app.setPlan(a);
      if (modal === 'complete') app.page.openCompletion(tap({id: plan.id}));
      else {app.page.choosePlan(tap({meal: 'breakfast'})); app.page.selectRecipe(tap({id: b}));}
      if (change === 'account') {app.store.bindAccount(OTHER); app.store.bindAccount(OWNER);}
      else {app.store.bindScope(OWNER, FAMILY); app.store.bindScope(OWNER, {kind: 'personal', id: OWNER});}
      assert.equal(app.page.data.completeVisible, false); assert.equal(app.page.data.recordPickerVisible, false);
      assert.equal(app.page.data.completion, null); assert.equal(app.page.data.pickerSelected, '');
      app.page.completeMeal(); app.page.savePickedPlan();
      assert.equal(app.calls.completion.length, 0); assert.equal(app.calls.plans.length, 0);
      assert.equal(app.store.getState().logs.length, 0); assert.equal(app.store.getState().mealPlans[0].recipeId, a);
    }
  }
});

test('an event from another displayed account cannot open or submit a meal action', () => {
  const app = setup(), plan = app.setPlan(), oldScope = app.page.data.scope;
  app.store.bindAccount(OTHER); app.page.refresh();
  app.page.choosePlan(tap({meal: 'lunch', scope: oldScope}));
  app.page.openRecordPicker(tap({scope: oldScope}));
  app.page.openCompletion(tap({id: plan.id, scope: oldScope}));
  assert.equal(app.page.data.recordPickerVisible, false); assert.equal(app.page.data.completeVisible, false);
  assert.equal(app.calls.navigation.length, 0); assert.equal(app.calls.completion.length, 0);
});

test('unplanned recording carries the chosen date and meal and leaves planning untouched', () => {
  const app = setup(), [a] = app.ids;
  const date = calendar.shiftDate(selectors.today(), -2); app.selectDay(date);
  app.page.openRecordPicker(); app.page.choosePickerMeal(tap({meal: 'dinner'}));
  app.page.selectRecipe(tap({id: a}));
  assert.equal(app.calls.navigation[0], '/pages/record-editor/index?id=' + encodeURIComponent(a) + '&date=' + date + '&meal=dinner');
  assert.equal(app.store.getState().mealPlans, undefined); assert.equal(app.store.getState().logs.length, 0);
});

test('future dates support choosing a plan but do not offer meal completion or an eaten record', () => {
  const app = setup(), [a] = app.ids, date = calendar.shiftDate(selectors.today(), 1);
  const plan = app.setPlan(a, 'breakfast', date); app.selectDay(date);
  app.page.openRecordPicker(); app.page.openCompletion(tap({id: plan.id}));
  assert.equal(app.page.data.future, true); assert.equal(app.page.data.recordPickerVisible, false);
  assert.equal(app.page.data.completeVisible, false); assert.equal(app.calls.navigation.length, 0);
  app.page.choosePlan(tap({meal: 'lunch'}));
  assert.equal(app.page.data.recordPickerVisible, true); assert.equal(app.page.data.pickerDate, date);
});

test('historical records with no meal remain visible without being assigned a guessed breakfast lunch or dinner', () => {
  const app = setup(), [a, b] = app.ids, date = selectors.today();
  const legacy = app.store.addLog({recipeId: a, date, rating: 3});
  const lunch = app.store.addLog({recipeId: b, date, meal: 'lunch', rating: 0});
  app.page.refresh();
  assert.deepEqual(app.page.data.legacyLogs.map(log => log.id), [legacy]);
  assert.equal(app.page.data.rows[0].cards.length, 0); assert.equal(app.page.data.rows[2].cards.length, 0);
  assert.equal(app.page.data.rows[1].cards[0].log.id, lunch); assert.equal(app.page.data.plannedCount, 0);
  app.page.editLog(tap({id: legacy}));
  assert.equal(app.calls.navigation[0], '/pages/record-editor/index?logId=' + encodeURIComponent(legacy));
});

test('changing date cancels the old meal context and unloading blocks leftover action handlers', () => {
  const app = setup(), [a] = app.ids, plan = app.setPlan(a);
  app.page.openCompletion(tap({id: plan.id})); app.selectDay(calendar.shiftDate(selectors.today(), -1));
  assert.equal(app.page.data.completeVisible, false); app.page.completeMeal(); assert.equal(app.calls.completion.length, 0);
  app.page.choosePlan(tap({meal: 'dinner'})); app.page.selectRecipe(tap({id: a}));
  app.page.onUnload(); app.page.savePickedPlan();
  assert.equal(app.calls.plans.length, 0); assert.equal(app.store.getState().mealPlans.length, 1);
});
