'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/recipes');
const storePath = require.resolve('../utils/store');
const owner = 'a'.repeat(64), other = 'b'.repeat(64);
const accountKey = 'baby-bites-account-' + owner;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const empty = recipes => ({version: 1, nickname: '小豆', profileUpdatedAt: 1, recipes, logs: []});
const snapshot = data => ({version: 1, data, deleted: {recipes: [], logs: []}});
const example = recipe => ({...clone(recipe), isExample: true, favorite: false, photo: '', createdAt: 1700000000000, updatedAt: 0});
const cache = data => ({version: 1, data, __sync: {sequence: 7, revision: 3, dirty: false,
  hasLocalData: true, migratedLegacy: true, snapshotSchemaVersion: 3, deleted: {recipes: [], logs: []}}});

function setup(initial = {}) {
  const storage = new Map(Object.entries(clone(initial)));
  let writes = 0;
  global.wx = {
    getStorageSync: key => clone(storage.get(key)),
    getStorageInfoSync: () => ({keys: Array.from(storage.keys())}),
    setStorageSync(key, value) { storage.set(key, clone(value)); writes++; }
  };
  function reload() { delete require.cache[storePath]; return require(storePath); }
  return {store: reload(), reload, storage, writes: () => writes};
}

function oldData() {
  const data = empty(seed.map(example));
  data.recipes.push({...example(seed[0]), id: 'my-own-recipe', isExample: false, updatedAt: 2},
    {...example(seed[1]), id: 'shared-saved-recipe', isExample: false, updatedAt: 3,
      source: {profileId: 'a'.repeat(32), recipeId: 'b'.repeat(64), authorName: '另一个厨房'}});
  return data;
}

test('fresh devices have no starter recipes and reading never writes or fabricates feedback', () => {
  const app = setup();
  assert.deepEqual(app.store.init().recipes, []);
  assert.deepEqual(app.store.getState().logs, []);
  assert.deepEqual(app.store.getSyncSnapshot().data.recipes, []);
  assert.equal(app.writes(), 0);
});

test('binding, restarting, editing a profile and switching accounts never seed recipes', () => {
  const app = setup();
  app.store.bindAccount(owner);
  assert.deepEqual(app.store.getState().recipes, []);
  const restarted = app.reload();
  assert.deepEqual(restarted.init().recipes, []);
  restarted.setNickname('小豆');
  assert.deepEqual(restarted.getSyncSnapshot().data.recipes, []);
  restarted.bindAccount(other);
  assert.deepEqual(restarted.getState().recipes, []);
  restarted.bindAccount(owner);
  assert.deepEqual(restarted.getState().recipes, []);
  assert.equal(restarted.getState().nickname, '小豆');
});

test('legacy local and account caches retire untouched defaults without user-deletion tombstones', () => {
  for (const account of [false, true]) {
    const data = oldData();
    const initial = account ? {'baby-bites-active-owner': owner, [accountKey]: cache(data)} : {'baby-bites-v1': data};
    const app = setup(initial);
    assert.deepEqual(app.store.init().recipes.map(r => r.id), ['my-own-recipe', 'shared-saved-recipe']);
    assert.equal(app.store.getSyncInfo().dirty, true);
    assert.deepEqual(app.store.getSyncSnapshot().deleted, {recipes: [], logs: []});
    assert.equal(app.writes(), 0, 'cleanup is persisted only by a successful save or sync');
    assert.deepEqual(app.storage.get(account ? accountKey : 'baby-bites-v1'), initial[account ? accountKey : 'baby-bites-v1']);
    app.store.setNickname('保留自建食谱');
    assert.deepEqual(app.reload().getState().recipes.map(r => r.id), ['my-own-recipe', 'shared-saved-recipe']);
  }
});

test('migration preserves favorites, edits, photos, planned meals and meal history', () => {
  const data = oldData();
  data.recipes[0].favorite = true;
  data.recipes[1].name = '我改过的软面';
  data.recipes[2].photo = 'wxfile://usr/my-photo.jpg';
  data.recipes[3].updatedAt = 2;
  data.mealPlans = [{id: 'meal-2024-04-02-lunch', date: '2024-04-02', meal: 'lunch', recipeId: seed[4].id, createdAt: 1, updatedAt: 1}];
  data.logs = [{id: 'my-meal', recipeId: seed[5].id, date: '2024-04-01', rating: 3, createdAt: 1}];
  const app = setup({'baby-bites-v1': data});
  const expected = app.store.validateData(data);
  expected.recipes = expected.recipes.filter(r => seed.slice(0, 6).some(s => s.id === r.id) || r.id.startsWith('my-') || r.id.startsWith('shared-'));
  assert.deepEqual(app.store.init(), expected);
  assert.deepEqual(app.store.getSyncSnapshot().deleted, {recipes: [], logs: [], mealPlans: []});
});

test('family caches retire defaults while personal data remains isolated', () => {
  const family = {kind: 'family', id: 'f'.repeat(64), membershipId: 'c'.repeat(32)};
  const key = 'baby-bites-family-cache-' + owner + ':family:' + family.id + ':' + family.membershipId;
  const app = setup({'baby-bites-active-owner': owner, [accountKey]: cache(empty([])), [key]: cache(oldData())});
  app.store.bindScope(owner, family);
  assert.deepEqual(app.store.getState().recipes.map(r => r.id), ['my-own-recipe', 'shared-saved-recipe']);
  app.store.bindScope(owner, {kind: 'personal', id: owner});
  assert.deepEqual(app.store.getState().recipes, []);
});

test('old backups do not restore unused defaults; user content still imports idempotently', () => {
  const app = setup();
  const text = JSON.stringify(oldData());
  assert.deepEqual(app.store.importBackup(text), {addedRecipes: 2, updatedRecipes: 0, addedLogs: 0});
  assert.deepEqual(app.store.getState().recipes.map(r => r.id), ['my-own-recipe', 'shared-saved-recipe']);
  assert.deepEqual(app.store.importBackup(text), {addedRecipes: 0, updatedRecipes: 0, addedLogs: 0});
  assert.deepEqual(app.reload().getState().recipes.map(r => r.id), ['my-own-recipe', 'shared-saved-recipe']);
});

test('applying an old cloud snapshot retires unused defaults and schedules a cleaned upload', () => {
  const app = setup(); app.store.bindAccount(owner);
  app.store.applySyncedSnapshot(snapshot(oldData()), {owner, sequence: app.store.getSyncInfo().sequence, revision: 1});
  assert.deepEqual(app.store.getState().recipes.map(r => r.id), ['my-own-recipe', 'shared-saved-recipe']);
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.deepEqual(app.store.getSyncSnapshot().deleted, {recipes: [], logs: []});
});

test('a retired local default does not delete a remotely edited or recorded copy', () => {
  for (const used of ['edit', 'log', 'plan']) {
    const app = setup({'baby-bites-active-owner': owner, [accountKey]: cache(empty(seed.map(example)))});
    assert.deepEqual(app.store.init().recipes, []);
    const remote = empty([example(seed[0])]);
    if (used === 'edit') Object.assign(remote.recipes[0], {name: '另一台设备的修改', updatedAt: 10});
    if (used === 'log') remote.logs.push({id: 'remote-log', recipeId: seed[0].id, date: '2024-04-01', rating: 3});
    if (used === 'plan') remote.mealPlans = [{id: 'meal-2024-04-02-lunch', date: '2024-04-02', meal: 'lunch', recipeId: seed[0].id}];
    app.store.setNickname('同步时的本地修改');
    app.store.applySyncedSnapshot(snapshot(remote), {owner, sequence: 0, revision: 4});
    assert.equal(app.store.getRecipe(seed[0].id).name, remote.recipes[0].name);
    assert.equal(app.store.getState().logs.length, remote.logs.length);
    assert.equal((app.store.getState().mealPlans || []).length, (remote.mealPlans || []).length);
    assert.deepEqual(app.store.getSyncSnapshot().deleted.recipes, []);
  }
});
