'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const selectors = require('../utils/selectors');
const {shiftDate} = require('../utils/calendar');
const {planId} = require('../utils/meal-plans');
const {mergeSnapshots} = require('../utils/sync-merge');
const storeFile = path.resolve(__dirname, '../utils/store.js');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const DATE = '2024-04-02';

function setup(initial) {
  const saved = new Map(initial ? [['baby-bites-v1', copy(initial)]] : []);
  let writes = 0, failed = false;
  global.wx = {getStorageSync: key => copy(saved.get(key)), setStorageSync(key, value) {
    if (failed) throw Error('quota');
    writes++; saved.set(key, copy(value));
  }};
  delete require.cache[storeFile];
  const store = require(storeFile);
  const ids = store.getState().recipes.slice(0, 3).map(recipe => recipe.id);
  return {store, ids, writes: () => writes, fail(value = true) {failed = value;},
    persisted: () => copy(saved.get('baby-bites-v1'))};
}
const entry = (recipeId, meal = 'breakfast', date = DATE) => ({date, meal, recipeId});
const snapshot = (data, deleted = {}) => ({version: 1, data: copy(data), deleted: {recipes: [], logs: [], ...copy(deleted)}});

test('reading a legacy store does not invent plans or request a write', () => {
  const app = setup();
  assert.equal(app.store.getState().mealPlans, undefined);
  assert.equal(app.store.getSyncSnapshot().deleted.mealPlans, undefined);
  assert.equal(app.writes(), 0);
});

test('confirming a draft persists only its selected slots and preserves other dates and meals', () => {
  const app = setup(), [a, b] = app.ids;
  const first = app.store.saveMealPlans([entry(a), entry(b, 'dinner', shiftDate(DATE, 1))]);
  assert.equal(first.length, 2);
  assert.equal(app.store.getState().logs.length, 0);
  app.store.saveMealPlans([entry(b, 'lunch')], {expected: first});
  assert.equal(app.store.getState().mealPlans.length, 3);
  assert.deepEqual(app.store.getSyncSnapshot().deleted.mealPlans, []);
  const before = app.writes();
  app.store.saveMealPlans([entry(a)], {expected: first});
  assert.equal(app.writes(), before, 'confirming an unchanged slot needs no persistence or sync');
  const reloaded = setup(app.persisted());
  assert.equal(reloaded.store.getState().mealPlans.length, 3);
});

test('saving rejects stale slots including another person filling a previously empty slot', () => {
  const app = setup(), [a, b, c] = app.ids;
  const base = app.store.saveMealPlans([entry(a)]);
  app.store.saveMealPlans([entry(b)]);
  const before = app.store.getState(), persisted = app.persisted();
  assert.throws(() => app.store.saveMealPlans([entry(c)], {expected: base}), /已被更新/);
  assert.throws(() => app.store.saveMealPlans([entry(c)], {expected: []}), /已被更新/);
  assert.deepEqual(app.store.getState(), before); assert.deepEqual(app.persisted(), persisted);
  app.store.saveMealPlans([entry(c, 'lunch')], {expected: base});
  assert.equal(app.store.getState().mealPlans.length, 2, 'an independent slot remains editable');
});

test('failed plan persistence keeps data, tombstones and subscribers unchanged', () => {
  const app = setup(), [a, b] = app.ids;
  app.store.saveMealPlans([entry(a)]);
  const before = app.store.getState(), synced = app.store.getSyncSnapshot(), persisted = app.persisted();
  let notified = 0; app.store.subscribe(() => notified++); app.fail();
  assert.throws(() => app.store.saveMealPlans([entry(b), entry(b, 'lunch')]), /保存失败/);
  assert.throws(() => app.store.removeMealPlan(planId(DATE, 'breakfast')), /保存失败/);
  assert.deepEqual(app.store.getState(), before); assert.deepEqual(app.store.getSyncSnapshot(), synced);
  assert.deepEqual(app.persisted(), persisted); assert.equal(notified, 0);
});

test('invalid dates, duplicate slots, missing recipes and excessive plans are rejected atomically', () => {
  const app = setup(), [a] = app.ids, before = app.store.getState();
  for (const entries of [[entry(a, 'snack')], [entry(a, 'lunch', '2024-02-30')], [entry('missing')],
    [entry(a), entry(a)], Array(3001).fill(entry(a))]) assert.throws(() => app.store.saveMealPlans(entries));
  assert.deepEqual(app.store.getState(), before); assert.equal(app.writes(), 0);
});

test('completion without feedback is real history without fabricating a preference and is idempotent', () => {
  const app = setup(), [a] = app.ids;
  app.store.saveMealPlans([entry(a)]);
  const id = app.store.completeMeal({planId: planId(DATE, 'breakfast')});
  const before = app.writes();
  assert.equal(app.store.completeMeal({planId: planId(DATE, 'breakfast'), rating: 3}), id);
  assert.equal(app.writes(), before); assert.equal(app.store.getState().logs.length, 1);
  assert.equal(app.store.getLog(id).rating, 0); assert.equal(app.store.getLog(id).meal, 'breakfast');
  assert.equal(selectors.ratingOf(app.store.getState(), a), 0);
  assert.equal(selectors.listLogs(app.store.getState())[0].ratingName, '已做，待补充');
  assert.equal(selectors.stats(app.store.getState()).triedCount, 1);
});

test('an existing unplanned record is reused when its same dish is later planned', () => {
  const app = setup(), [a] = app.ids;
  const id = app.store.addLog({...entry(a), rating: 3, portion: '吃了大部分'});
  app.store.saveMealPlans([entry(a)]);
  assert.equal(app.store.completeMeal({planId: planId(DATE, 'breakfast')}), id);
  assert.equal(app.store.getState().logs.length, 1); assert.equal(app.store.getLog(id).rating, 3);
});

test('completed meals cannot be replaced or removed until their record is removed', () => {
  const app = setup(), [a, b] = app.ids;
  const [plan] = app.store.saveMealPlans([entry(a)]);
  const id = app.store.completeMeal({planId: plan.id});
  assert.throws(() => app.store.saveMealPlans([entry(b)]), /用餐记录/);
  assert.throws(() => app.store.removeMealPlan(plan.id), /用餐记录/);
  app.store.deleteLog(id); app.store.saveMealPlans([entry(b)]);
  const replacement = app.store.completeMeal({planId: plan.id, rating: 2});
  assert.equal(replacement, id); assert.equal(app.store.getLog(id).recipeId, b);
  assert.ok(app.store.getLog(id).updatedAt > app.store.getSyncSnapshot().deleted.logs.find(log => log.id === id).updatedAt);
});

test('a completion moved to another date retains its history and cannot allocate a second completion identity', () => {
  const app = setup(), [a] = app.ids;
  const [plan] = app.store.saveMealPlans([entry(a)]);
  const id = app.store.completeMeal({planId: plan.id});
  app.store.updateLog(id, {rating: 1, date: shiftDate(DATE, -1)});
  const moved = app.persisted(), before = app.store.getState(), writes = app.writes();
  assert.throws(() => app.store.completeMeal({planId: plan.id}), /原来的记录已被调整/);
  assert.deepEqual(app.store.getState(), before); assert.equal(app.writes(), writes);
  const other = setup(moved);
  other.store.updateLog(id, {rating: 3, date: shiftDate(DATE, -2)});
  assert.throws(() => other.store.completeMeal({planId: plan.id}), /原来的记录已被调整/);
  const merged = mergeSnapshots(app.store.getSyncSnapshot(), other.store.getSyncSnapshot());
  assert.equal(merged.data.logs.length, 1); assert.equal(merged.data.logs[0].id, id);
  const manualId = other.store.addLog({...entry(a), rating: 0});
  assert.equal(other.store.completeMeal({planId: plan.id}), manualId, 'an explicit new meal can still satisfy this plan');
});

test('future meals, stale displayed recipes and failed writes cannot create a completion', () => {
  const app = setup(), [a, b] = app.ids;
  const tomorrow = shiftDate(selectors.today(), 1);
  app.store.saveMealPlans([entry(a), entry(a, 'dinner', tomorrow)]);
  assert.throws(() => app.store.completeMeal({planId: planId(tomorrow, 'dinner')}), /今天或之前/);
  assert.throws(() => app.store.completeMeal({planId: planId(DATE, 'breakfast'), recipeId: b}), /已有变化/);
  app.fail(); assert.throws(() => app.store.completeMeal({planId: planId(DATE, 'breakfast')}), /保存失败/);
  assert.equal(app.store.getState().logs.length, 0);
});

test('unplanned meals permit omitted feedback and preserve their meal when editing later', () => {
  const app = setup(), [a] = app.ids;
  const id = app.store.addLog({...entry(a, 'lunch'), rating: 0});
  assert.deepEqual(app.store.getState().mealPlans, []);
  app.store.updateLog(id, {rating: 3, date: DATE, portion: '全部吃完'});
  assert.equal(app.store.getLog(id).meal, 'lunch'); assert.equal(app.store.getLog(id).rating, 3);
  app.store.updateLog(id, {rating: 0, date: DATE});
  assert.equal(app.store.getLog(id).rating, 0);
});

test('a later completion with no rating does not erase an earlier known preference', () => {
  const app = setup(), [a] = app.ids;
  app.store.addLog({recipeId: a, date: shiftDate(DATE, -1), rating: 3});
  app.store.addLog({...entry(a), rating: 0});
  const state = app.store.getState();
  assert.equal(selectors.ratingOf(state, a), 3);
  assert.equal(selectors.enrichRecipe(state, app.store.getRecipe(a)).rating, 3);
  assert.equal(selectors.listRecipes(state).find(recipe => recipe.id === a).rating, 3);
  assert.equal(selectors.listLogs(state, '3').length, 1);
});

test('backup restore preserves meal plans, optional feedback and older backups without plans', async () => {
  const app = setup(), [a] = app.ids;
  const legacy = app.store.exportBackup();
  app.store.saveMealPlans([entry(a)]); app.store.completeMeal({planId: planId(DATE, 'breakfast')});
  delete require.cache[require.resolve('../utils/backup')];
  const portable = await require('../utils/backup').exportText();
  const restored = setup();
  delete require.cache[require.resolve('../utils/backup')];
  await require('../utils/backup').importText(portable);
  assert.equal(restored.store.getState().mealPlans.length, 1); assert.equal(restored.store.getState().logs[0].rating, 0);
  restored.store.importBackup(legacy);
  assert.equal(restored.store.getState().mealPlans.length, 1); assert.equal(restored.store.getState().logs.length, 1);
});

test('explicit restoration advances a known plan deletion and retains its tombstone', () => {
  const app = setup(), [a] = app.ids;
  const [plan] = app.store.saveMealPlans([entry(a)]), backup = app.store.exportBackup();
  app.store.removeMealPlan(plan.id);
  const removed = app.store.getSyncSnapshot();
  app.store.importBackup(backup);
  const restored = app.store.getSyncSnapshot();
  assert.equal(restored.deleted.mealPlans.length, 1);
  assert.ok(restored.data.mealPlans[0].updatedAt > removed.deleted.mealPlans[0].updatedAt);
  assert.equal(mergeSnapshots(restored, removed).data.mealPlans.length, 1);
});

test('deleting a recipe removes its plans and logs atomically and remembers all deletions', () => {
  const app = setup(), [a] = app.ids;
  const [plan] = app.store.saveMealPlans([entry(a)]);
  const logId = app.store.completeMeal({planId: plan.id});
  app.store.deleteRecipe(a);
  const result = app.store.getSyncSnapshot();
  assert.equal(result.data.mealPlans.length, 0); assert.equal(result.data.logs.length, 0);
  assert.equal(result.deleted.mealPlans[0].id, plan.id); assert.equal(result.deleted.logs[0].id, logId);
});

test('different offline slots merge, same-slot conflicts resolve deterministically, and deletion wins ties', () => {
  const app = setup(), [a, b] = app.ids;
  const data = app.store.getState();
  const plan = (recipeId, meal, updatedAt) => ({...entry(recipeId, meal), id: planId(DATE, meal), createdAt: 1, updatedAt});
  const left = snapshot({...data, mealPlans: [plan(a, 'breakfast', 10), plan(a, 'lunch', 10)]}, {mealPlans: []});
  const right = snapshot({...data, mealPlans: [plan(b, 'breakfast', 20), plan(b, 'dinner', 10)]}, {mealPlans: []});
  assert.deepEqual(mergeSnapshots(left, right), mergeSnapshots(right, left));
  const merged = mergeSnapshots(left, right);
  assert.equal(merged.data.mealPlans.length, 3);
  assert.equal(merged.data.mealPlans.find(item => item.meal === 'breakfast').recipeId, b);
  right.deleted.mealPlans = [{id: planId(DATE, 'breakfast'), updatedAt: 20}];
  right.data.mealPlans = [];
  assert.equal(mergeSnapshots(merged, right).data.mealPlans.some(item => item.meal === 'breakfast'), false);
});

test('a remote recipe deletion also removes newer offline plans and creates plan tombstones', () => {
  const app = setup(), [a] = app.ids;
  const [plan] = app.store.saveMealPlans([entry(a)]);
  const local = app.store.getSyncSnapshot();
  const remote = snapshot({...local.data, recipes: local.data.recipes.filter(recipe => recipe.id !== a), mealPlans: []},
    {recipes: [{id: a, updatedAt: 1}], mealPlans: []});
  const merged = mergeSnapshots(local, remote);
  assert.equal(merged.data.mealPlans.length, 0);
  assert.equal(merged.deleted.mealPlans[0].id, plan.id);
});

test('concurrent completion of the same planned meal merges into one log', () => {
  const first = setup(), [a] = first.ids;
  const [plan] = first.store.saveMealPlans([entry(a)]), base = first.persisted();
  const id = first.store.completeMeal({planId: plan.id});
  const left = first.store.getSyncSnapshot();
  const second = setup(base);
  assert.equal(second.store.completeMeal({planId: plan.id}), id);
  assert.equal(mergeSnapshots(left, second.store.getSyncSnapshot()).data.logs.length, 1);
});

test('optional fields survive a same-revision snapshot acknowledgement and reloading its schema marker', () => {
  const app = setup(), [a] = app.ids;
  app.store.bindAccount('a'.repeat(64)); app.store.saveMealPlans([entry(a)]);
  app.store.completeMeal({planId: planId(DATE, 'breakfast')});
  const snapshot = app.store.getSyncSnapshot(), info = app.store.getSyncInfo();
  app.store.applySyncedSnapshot(snapshot, {owner: info.owner, sequence: info.sequence, revision: 1});
  assert.equal(app.store.getSyncInfo().snapshotCurrent, true);
  assert.equal(app.store.getState().mealPlans.length, 1); assert.equal(app.store.getState().logs[0].meal, 'breakfast');
});

test('invalid schema combinations and plan identities cannot enter local storage', () => {
  const app = setup(), [a] = app.ids, data = app.store.getState();
  const zero = {id: 'log', recipeId: a, date: DATE, rating: 0};
  assert.throws(() => app.store.validateData({...data, logs: [zero]}));
  const plan = {...entry(a), id: planId(DATE, 'breakfast'), createdAt: 1, updatedAt: 1};
  for (const broken of [{...plan, id: 'unrelated'}, {...plan, updatedAt: 0.5}, {...plan, recipeId: 'missing'}]) {
    assert.throws(() => app.store.validateData({...data, mealPlans: [broken]}));
  }
  assert.throws(() => app.store.validateData({...data, mealPlans: [], logs: [{...zero, meal: 'snack'}]}));
  assert.throws(() => app.store.validateSnapshot(snapshot(data, {mealPlans: []})));
  assert.deepEqual(app.store.validateSnapshot(snapshot({...data, mealPlans: []})).deleted.mealPlans, []);
});
