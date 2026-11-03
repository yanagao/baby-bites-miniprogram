'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {build} = require('../utils/profile-content');
const selectors = require('../utils/selectors');
const clone = value => JSON.parse(JSON.stringify(value));
const ids = rows => rows.map(row => row.id);

function state() {
  return {recipes: [
    {id: 'local-public', name: '南瓜粥', ingredients: [{name: '南瓜', amount: '20克'}],
      category: '粥饭主食', texture: '细腻泥糊', minutes: 15, steps: ['煮熟'], imageKey: 'pumpkin',
      photo: '', isExample: true, favorite: true, createdAt: 10, updatedAt: 15},
    {id: 'local-private', name: '西兰花泥', ingredients: [{name: '西兰花', amount: '20克'}],
      category: '蔬果泥糊', texture: '细腻泥糊', minutes: 10, steps: ['蒸熟'], imageKey: 'broccoli',
      photo: '/local/private.jpg', favorite: true, createdAt: 20, updatedAt: 25},
    {id: 'local-copy', name: '收藏来的做法', ingredients: [{name: '小米', amount: '10克'}],
      category: '粥饭主食', texture: '软烂颗粒', minutes: 20, steps: ['煮熟'], imageKey: '',
      source: {recipeId: 'public-one', profileId: 'friend'}, photo: '', favorite: false, createdAt: 30}
  ], logs: [
    {id: 'old-log', recipeId: 'local-public', date: '2026-10-20', rating: 1, createdAt: 100, note: '只给自己看'},
    {id: 'new-log', recipeId: 'local-public', date: '2026-10-28', rating: 3, createdAt: 200},
    {id: 'private-log', recipeId: 'local-private', date: '2026-10-28', rating: 2, createdAt: 300},
    {id: 'orphan-log', recipeId: 'removed-recipe', date: '2026-10-29', rating: 3, createdAt: 400}
  ]};
}
const published = [{id: 'public-one', sourceRecipeId: 'local-public', sourceUpdatedAt: 15}];
const confirmed = {published, publicationReady: true};

test('the own cookbook includes built-ins and uploaded recipes regardless of historical visibility', () => {
  const value = state(); const expected = selectors.listRecipes(value);
  for (const visibility of ['all', 'public', 'private']) {
    for (const published of [undefined, null, {}, [], [{id: 'invalid'}]]) {
      const result = build(value, {visibility, published, publicationReady: true});
      assert.deepEqual(result.recipes, expected);
      assert.ok(result.recipes.every(recipe => !Object.hasOwn(recipe, 'visibility')));
      assert.equal(Object.hasOwn(result, 'publicCount'), false);
    }
  }
});

test('favorites and records have independent content while totals remain stable across tabs', () => {
  const value = state();
  const all = build(value, confirmed);
  const totals = result => [result.recipeCount, result.favoriteCount, result.logCount];
  assert.deepEqual(totals(all), [3, 2, 3]);
  for (const visibility of ['all', 'public', 'private']) {
    const favorites = build(value, {...confirmed, tab: 'favorites', visibility});
    assert.deepEqual(ids(favorites.recipes), ['local-private', 'local-public']);
    assert.deepEqual(favorites.logs, []);
    assert.deepEqual(totals(favorites), totals(all));
    const records = build(value, {...confirmed, tab: 'records', visibility});
    assert.deepEqual(records.recipes, []);
    assert.deepEqual(records.logs, selectors.listLogs(value));
    assert.deepEqual(ids(records.logs), ['private-log', 'new-log', 'old-log']);
    assert.deepEqual(totals(records), totals(all));
  }
  assert.deepEqual(all.logs, []);
});

test('recipe rows retain selector ordering, latest ratings, photos and ingredient presentation', () => {
  const value = state();
  const rows = build(value, confirmed).recipes;
  const expected = selectors.listRecipes(value);
  for (let index = 0; index < rows.length; index++) {
    for (const key of Object.keys(expected[index])) assert.deepEqual(rows[index][key], expected[index][key]);
  }
  const publicRecipe = rows.find(recipe => recipe.id === 'local-public');
  assert.equal(publicRecipe.rating, 3);
  assert.equal(publicRecipe.ingredientText, '南瓜');
  assert.equal(publicRecipe.displayPhoto, '', 'a generic ingredient key must not assign a catalog dish to a custom recipe');
  assert.equal(rows.find(recipe => recipe.id === 'local-private').displayPhoto, '/local/private.jpg');
});

test('empty stores and invalid content tabs retain stable defaults', () => {
  const value = state();
  assert.deepEqual(build(value, {tab: 'invalid', visibility: 'invalid'}), build(value));
  for (const tab of ['recipes', 'favorites', 'records']) {
    assert.deepEqual(build({recipes: [], logs: []}, {tab}), {
      recipes: [], logs: [], recipeCount: 0, favoriteCount: 0, logCount: 0
    });
  }
});

test('projection never mutates input and keeps no publication state across calls', () => {
  const value = state(), options = clone(confirmed);
  const before = clone({value, options});
  function freeze(input) {
    if (input && typeof input === 'object') { Object.values(input).forEach(freeze); Object.freeze(input); }
    return input;
  }
  freeze(value); freeze(options);
  build(value, options);
  build(value, {...options, tab: 'records'});
  assert.deepEqual({value, options}, before);
  const next = build(value, {published, publicationReady: false});
  assert.deepEqual(next.recipes, selectors.listRecipes(value));
});
