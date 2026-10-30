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

test('unconfirmed status keeps local recipes and favorites unknown and cannot imply privacy', () => {
  const value = state();
  for (const publicationReady of [undefined, false, 1, 'true']) {
    const all = build(value, {published, publicationReady});
    assert.equal(all.recipes.length, 3);
    assert.ok(all.recipes.every(recipe => recipe.visibility === 'unknown' && recipe.publicChanged === false));
    assert.ok(all.recipes.every(recipe => recipe.visibilityLabel === '公开状态待确认'));
    assert.equal(all.publicCount, 0); assert.equal(all.privateCount, 0);
    for (const visibility of ['public', 'private']) {
      assert.deepEqual(build(value, {visibility, published, publicationReady}).recipes, []);
    }
    const favorites = build(value, {tab: 'favorites', published, publicationReady});
    assert.equal(favorites.recipes.length, 2);
    assert.ok(favorites.recipes.every(recipe => recipe.visibility === 'unknown'));
  }
});

test('confirmed publication maps only sourceRecipeId, never public IDs or imported attribution', () => {
  const value = state();
  const result = build(value, {...confirmed, published: published.concat([
    {id: 'local-private', sourceRecipeId: 'no-longer-local', sourceUpdatedAt: 25}
  ])});
  assert.deepEqual(ids(result.recipes), ['local-copy', 'local-private', 'local-public']);
  assert.equal(result.recipes.find(recipe => recipe.id === 'local-public').visibility, 'public');
  assert.equal(result.recipes.find(recipe => recipe.id === 'local-private').visibility, 'private');
  assert.equal(result.recipes.find(recipe => recipe.id === 'local-copy').visibility, 'private');
  assert.equal(result.publicCount, 1); assert.equal(result.privateCount, 2);
  assert.deepEqual(ids(build(value, {...confirmed, visibility: 'public'}).recipes), ['local-public']);
  assert.deepEqual(ids(build(value, {...confirmed, visibility: 'private'}).recipes), ['local-copy', 'local-private']);
});

test('publication changes compare the local version with updatedAt, createdAt and zero fallbacks', () => {
  const value = state();
  const local = value.recipes[0];
  const projected = () => build(value, confirmed).recipes.find(recipe => recipe.id === local.id);
  assert.equal(projected().publicChanged, false);
  local.updatedAt = 16;
  assert.equal(projected().publicChanged, true);
  local.updatedAt = 0; local.createdAt = 15;
  assert.equal(projected().publicChanged, false);
  delete local.updatedAt; delete local.createdAt;
  assert.equal(build(value, {publicationReady: true, published: [{sourceRecipeId: local.id, sourceUpdatedAt: 0}]})
    .recipes.find(recipe => recipe.id === local.id).publicChanged, false);
  assert.ok(build(value, {publicationReady: true, published: []}).recipes.every(recipe => !recipe.publicChanged));
});

test('favorites and records have independent content while totals remain stable across tabs', () => {
  const value = state();
  const all = build(value, confirmed);
  const totals = result => [result.recipeCount, result.favoriteCount, result.logCount, result.publicCount, result.privateCount];
  assert.deepEqual(totals(all), [3, 2, 3, 1, 2]);
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

test('a missing or malformed publication list cannot mark recipes private even when ready is true', () => {
  for (const invalid of [undefined, null, {}, [null], [{id: 'local-public'}], [{sourceRecipeId: ''}], [{sourceRecipeId: 1}]]) {
    const result = build(state(), {publicationReady: true, published: invalid});
    assert.ok(result.recipes.every(recipe => recipe.visibility === 'unknown'));
    assert.equal(result.publicCount, 0); assert.equal(result.privateCount, 0);
    assert.deepEqual(build(state(), {publicationReady: true, published: invalid, visibility: 'private'}).recipes, []);
  }
});

test('empty confirmed lists mean private, while empty stores and invalid view choices have stable defaults', () => {
  const value = state();
  const emptyPublic = build(value, {publicationReady: true, published: []});
  assert.ok(emptyPublic.recipes.every(recipe => recipe.visibility === 'private'));
  assert.equal(emptyPublic.privateCount, 3);
  assert.deepEqual(build(value, {tab: 'invalid', visibility: 'invalid'}), build(value));
  for (const tab of ['recipes', 'favorites', 'records']) {
    assert.deepEqual(build({recipes: [], logs: []}, {...confirmed, tab}), {
      recipes: [], logs: [], recipeCount: 0, favoriteCount: 0, logCount: 0, publicCount: 0, privateCount: 0
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
  assert.ok(next.recipes.every(recipe => recipe.visibility === 'unknown'));
  assert.equal(next.publicCount, 0); assert.equal(next.privateCount, 0);
});
