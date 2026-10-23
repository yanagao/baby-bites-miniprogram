'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/recipes');
const {recipeCategories} = require('../utils/categories');
const {validateSnapshot: validateServerSnapshot} = require('../cloudfunctions/babyBitesSync/validate');
const storePath = require.resolve('../utils/store');
const owner = 'a'.repeat(64);
const accountKey = 'baby-bites-account-' + owner;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function setup(initial = {}) {
  const storage = new Map(Object.entries(clone(initial)));
  let writes = 0;
  global.wx = {
    getStorageSync: key => clone(storage.get(key)),
    getStorageInfoSync: () => ({keys: Array.from(storage.keys())}),
    setStorageSync(key, value) { storage.set(key, clone(value)); writes += 1; }
  };
  function reload() {
    delete require.cache[storePath];
    return require(storePath);
  }
  return {store: reload(), reload, writes: () => writes};
}

function example(recipe, index = 0) {
  return Object.assign(clone(recipe), {
    isExample: true, favorite: false, photo: '', createdAt: 1700000000000 - index, updatedAt: 0
  });
}

function existingAccount() {
  const recipes = seed.slice(0, 8).map(example);
  recipes.push(Object.assign(example(seed[0]), {
    id: 'my-own-recipe', name: '我的小米粥', isExample: false, updatedAt: 1700000000001
  }), Object.assign(example(seed[5]), {
    id: 'my-own-pancake', name: '我的鸡蛋饼', isExample: false, updatedAt: 1700000000002
  }));
  recipes[0].favorite = true;
  recipes[0].photo = 'cloud://catalog-test.bucket/users/' + owner + '/photos/kept.png';
  const data = {version: 1, nickname: '小豆', profileUpdatedAt: 1700000000003, recipes,
    logs: [{id: 'my-meal', recipeId: recipes[0].id, date: '2024-04-01', rating: 3,
      portion: '吃了一些', note: '保留这条用餐记录', createdAt: 1711929600000, updatedAt: 0}]};
  return {
    'baby-bites-active-owner': owner,
    [accountKey]: {version: 1, data,
      __sync: {sequence: 7, revision: 3, dirty: false, hasLocalData: true, migratedLegacy: true,
        deleted: {recipes: [{id: 'removed-personal-recipe', updatedAt: 1700000000004}],
          logs: [{id: 'removed-personal-log', updatedAt: 1700000000005}]}}}
  };
}

test('the starter catalog contains 21 distinct complete recipes across all seven categories', () => {
  assert.equal(seed.length, 21);
  assert.equal(new Set(seed.map(recipe => recipe.id)).size, 21);
  assert.equal(new Set(seed.map(recipe => recipe.name.trim())).size, 21);
  assert.deepEqual(new Set(seed.map(recipe => recipe.category)), new Set(recipeCategories));
  const {store} = setup();
  const data = store.validateData({version: 1, nickname: '宝宝', profileUpdatedAt: 0,
    recipes: seed.map(example), logs: []});
  assert.equal(data.recipes.length, 21);
  const snapshot = {version: 1, data, deleted: {recipes: [], logs: []}};
  assert.deepEqual(validateServerSnapshot(Buffer.from(JSON.stringify(snapshot)), {
    env: 'catalog-test', owner
  }), snapshot);
});

test('new-device examples do not fabricate feedback or enter an account upload implicitly', () => {
  const app = setup();
  const state = app.store.init();
  assert.equal(state.recipes.length, 21);
  assert.ok(state.recipes.every(recipe => recipe.isExample && !recipe.favorite && !recipe.photo));
  assert.deepEqual(state.logs, []);
  assert.deepEqual(app.store.getSyncSnapshot().data.recipes, []);
  assert.equal(app.writes(), 0);
});

test('a new WeChat account retains all 21 starter recipes after binding, restarting and its first edit', () => {
  const app = setup();
  const ids = seed.map(recipe => recipe.id);
  assert.deepEqual(app.store.init().recipes.map(recipe => recipe.id), ids);
  app.store.bindAccount(owner);
  const bound = app.store.getState();
  assert.deepEqual(bound.recipes.map(recipe => recipe.id), ids);
  const restarted = app.reload();
  assert.deepEqual(restarted.init(), bound);
  assert.equal(restarted.getSyncInfo().owner, owner);
  assert.equal(restarted.getSyncInfo().hasLocalData, false);
  assert.deepEqual(restarted.getSyncSnapshot().data.recipes, []);
  // First personal edit materializes the visible catalog in this account's sync snapshot.
  restarted.setNickname('小豆');
  const personal = restarted.getSyncSnapshot();
  assert.deepEqual(personal.data.recipes.map(recipe => recipe.id), ids);
  assert.deepEqual(personal.data.logs, []);
  assert.ok(personal.data.recipes.every(recipe => !recipe.favorite && !recipe.photo));
  assert.deepEqual(app.reload().getState(), personal.data);
});

test('expanding the starter catalog does not append recipes or restore deletions in an existing account', () => {
  const initial = existingAccount();
  // A removed catalog recipe must remain removed when the application restarts.
  const removed = initial[accountKey].data.recipes.splice(2, 1)[0];
  initial[accountKey].__sync.deleted.recipes.push({id: removed.id, updatedAt: 1700000000006});
  const app = setup(initial);
  const expected = app.store.validateData(initial[accountKey].data);
  assert.deepEqual(app.store.init(), expected);
  assert.equal(app.store.getRecipe(removed.id), null);
  assert.deepEqual(app.store.getSyncSnapshot().deleted, initial[accountKey].__sync.deleted);
  assert.equal(app.store.getSyncInfo().dirty, false);
  assert.equal(app.writes(), 0);
});

test('an explicit catalog merge keeps 21 starter recipes plus 2 personal recipes and preserves data on repeat', () => {
  const app = setup(existingAccount());
  const before = app.store.getState();
  const deleted = app.store.getSyncSnapshot().deleted;
  assert.equal(before.recipes.length, 10);
  const incoming = {version: 1, nickname: before.nickname, profileUpdatedAt: before.profileUpdatedAt,
    recipes: seed.slice(8).map(example), logs: []};
  const text = JSON.stringify(incoming);
  assert.deepEqual(app.store.importBackup(text), {addedRecipes: 13, updatedRecipes: 0, addedLogs: 0});
  const after = app.store.getState();
  assert.equal(after.recipes.length, 23);
  assert.deepEqual(new Set(after.recipes.filter(recipe => recipe.isExample).map(recipe => recipe.id)),
    new Set(seed.map(recipe => recipe.id)));
  assert.equal(after.recipes.filter(recipe => !recipe.isExample).length, 2);
  assert.deepEqual(after.recipes.slice(0, before.recipes.length), before.recipes);
  assert.deepEqual(after.logs, before.logs);
  assert.equal(after.nickname, before.nickname);
  assert.equal(after.profileUpdatedAt, before.profileUpdatedAt);
  assert.deepEqual(app.store.getSyncSnapshot().deleted, deleted);
  assert.equal(app.store.getSyncInfo().owner, owner);
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.deepEqual(app.store.importBackup(text), {addedRecipes: 0, updatedRecipes: 0, addedLogs: 0});
  assert.deepEqual(app.store.getState(), after);
  assert.deepEqual(app.store.getSyncSnapshot().deleted, deleted);
});

test('adding the two omitted starter recipes to a partially expanded account preserves all existing 21 entries', () => {
  const initial = existingAccount();
  const omittedIds = new Set(['cabbage-pork-soft-meatball', 'winter-melon-chicken-stew']);
  initial[accountKey].data.recipes.push(...seed.slice(8)
    .filter(recipe => !omittedIds.has(recipe.id)).map(example));
  const app = setup(initial);
  const before = app.store.getState();
  const deleted = app.store.getSyncSnapshot().deleted;
  assert.equal(before.recipes.length, 21);
  const incoming = {version: 1, nickname: before.nickname, profileUpdatedAt: before.profileUpdatedAt,
    recipes: seed.filter(recipe => omittedIds.has(recipe.id)).map(example), logs: []};
  assert.equal(incoming.recipes.length, 2);
  const text = JSON.stringify(incoming);
  assert.deepEqual(app.store.importBackup(text), {addedRecipes: 2, updatedRecipes: 0, addedLogs: 0});
  const after = app.store.getState();
  assert.equal(after.recipes.length, 23);
  assert.deepEqual(after.recipes.slice(0, before.recipes.length), before.recipes);
  assert.deepEqual(new Set(after.recipes.map(recipe => recipe.id)),
    new Set([...seed.map(recipe => recipe.id), 'my-own-recipe', 'my-own-pancake']));
  assert.deepEqual(after.logs, before.logs);
  assert.equal(after.nickname, before.nickname);
  assert.equal(after.profileUpdatedAt, before.profileUpdatedAt);
  assert.deepEqual(app.store.getSyncSnapshot().deleted, deleted);
  assert.deepEqual(app.store.importBackup(text), {addedRecipes: 0, updatedRecipes: 0, addedLogs: 0});
  assert.deepEqual(app.store.getState(), after);
});
