'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const selectors = require('../utils/selectors');
const seed = require('../data/recipes');
const copy = value => JSON.parse(JSON.stringify(value));
const input = value => ({detail: {value}});

function harness(recipes = [seed[0], seed[2], seed[5]], logs = []) {
  const state = {nickname: '宝宝', recipes: copy(recipes), logs: copy(logs)};
  const navigation = [];
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/home/index.js'), 'utf8'), {
    Page(value) { definition = value; },
    require(name) {
      if (name.endsWith('/selectors')) return selectors;
      if (name.endsWith('/store')) return {getState: () => state, getWarning: () => ''};
      if (name.endsWith('/tab-bar')) return {syncTabBar() {}};
      return {error(error) { throw error; }};
    },
    wx: {
      navigateTo(options) { navigation.push(options.url); },
      switchTab(options) { navigation.push(options.url); }
    }
  });
  const page = {...definition, data: copy(definition.data),
    setData(update) { Object.assign(this.data, update); }};
  return {page, state, navigation};
}

test('opening the homepage automatically draws once and includes every preference by default', () => {
  const {page} = harness(undefined, [{id: 'meal-1', recipeId: seed[0].id,
    rating: 1, date: '2026-10-21', createdAt: 1}]);
  page.onShow();
  assert.ok(page.data.result);
  const initialId = page.data.result.id;
  assert.equal(page.data.recipeCount, 3);
  assert.equal(page.data.candidateCount, 3);
  assert.equal(page.data.skipDisliked, false);
  page.onShow();
  assert.equal(page.data.result.id, initialId, 'returning keeps the initial choice');
});

test('returning from a selected recipe keeps the same choice and refreshes its current details', () => {
  const {page, state, navigation} = harness();
  page.onShow();
  page.draw();
  const id = page.data.result.id;
  page.detail();
  assert.deepEqual(navigation, ['/pages/detail/index?id=' + encodeURIComponent(id)]);
  state.recipes.find(recipe => recipe.id === id).name = '修改后的菜名';
  page.onShow();
  assert.equal(page.data.result.id, id);
  assert.equal(page.data.result.name, '修改后的菜名');
  page.draw();
  assert.notEqual(page.data.result.id, id, 'drawing again chooses a different recipe when possible');
});

test('changing the category updates the visible count and clears a choice outside the new scope', () => {
  const {page} = harness();
  page.onShow();
  page.changeCategory(input('早餐饼'));
  page.changeCategory(input('粥饭主食'));
  assert.equal(page.data.result, null);
  assert.equal(page.data.candidateCount, 1);
  assert.equal(page.data.recipeCount, 3);
  page.draw();
  assert.equal(page.data.result.id, seed[0].id);
  page.changeCategory(input('全部'));
  assert.equal(page.data.candidateCount, 3);
  assert.equal(page.data.result.id, seed[0].id, 'widening the scope keeps a still-valid choice');
  page.changeCategory(input('蔬菜手抓'));
  assert.equal(page.data.candidateCount, 1);
  assert.equal(page.data.result, null, 'filter changes do not silently choose a replacement');
  page.changeCategory(input('不存在的分类'));
  assert.equal(page.data.category, '蔬菜手抓');
});

test('excluding disliked recipes uses the latest meal and clears a now-excluded result', () => {
  const logs = [{id: 'meal-old', recipeId: seed[0].id, rating: 3,
    date: '2026-10-20', createdAt: 1},
  {id: 'meal-latest', recipeId: seed[0].id, rating: 1,
    date: '2026-10-21', createdAt: 2}];
  const {page, state} = harness(undefined, logs);
  page.onShow();
  page.changeCategory(input('粥饭主食'));
  page.draw();
  assert.equal(page.data.result.id, seed[0].id);
  page.skip(input(true));
  assert.equal(page.data.candidateCount, 0);
  assert.equal(page.data.result, null);
  page.changeCategory(input('全部'));
  assert.equal(page.data.candidateCount, 2);
  state.logs.push({id: 'meal-new', recipeId: seed[0].id, rating: 2,
    date: '2026-10-22', createdAt: 3});
  page.onShow();
  assert.equal(page.data.candidateCount, 3, 'a newer positive meal makes the recipe eligible again');
  assert.equal(page.data.result, null);
  page.resetFilters();
  assert.equal(page.data.skipDisliked, false);
  assert.equal(page.data.candidateCount, 3);
});

test('returning after deleting the selected recipe clears it without automatically drawing another', () => {
  const {page, state, navigation} = harness();
  page.onShow();
  page.draw();
  const removedId = page.data.result.id;
  state.recipes = state.recipes.filter(recipe => recipe.id !== removedId);
  page.onShow();
  assert.equal(page.data.result, null);
  assert.equal(page.data.candidateCount, 2);
  assert.equal(page.data.recipeCount, 2);
  page.detail();
  assert.deepEqual(navigation, []);
});

test('a single eligible recipe is stable and an empty collection remains actionable without a result', () => {
  const single = harness([seed[0]]);
  single.page.onShow();
  assert.equal(single.page.data.result.id, seed[0].id);
  single.page.draw();
  assert.equal(single.page.data.result.id, seed[0].id);
  assert.equal(single.page.data.candidateCount, 1);
  single.page.draw();
  assert.equal(single.page.data.result.id, seed[0].id);
  single.page.changeCategory(input('蔬菜手抓'));
  assert.equal(single.page.data.candidateCount, 0);
  single.page.draw();
  assert.equal(single.page.data.result, null);
  single.page.resetFilters();
  assert.equal(single.page.data.candidateCount, 1);
  assert.equal(single.page.data.result, null);

  const empty = harness([]);
  empty.page.onShow();
  empty.page.draw();
  assert.equal(empty.page.data.recipeCount, 0);
  assert.equal(empty.page.data.candidateCount, 0);
  assert.equal(empty.page.data.result, null);
  empty.page.addRecipe();
  assert.deepEqual(empty.navigation, ['/pages/editor/index']);
});

test('returning after adding the first recipe automatically provides the initial choice', () => {
  const {page, state} = harness([]);
  page.onShow();
  assert.equal(page.data.result, null);
  state.recipes.push(copy(seed[0]));
  page.onShow();
  assert.equal(page.data.result.id, seed[0].id);
  assert.equal(page.data.candidateCount, 1);
});

test('selection, scope changes and detail navigation do not create meals or mutate saved data', () => {
  const {page, state} = harness(undefined, [{id: 'existing-meal', recipeId: seed[0].id,
    rating: 2, date: '2026-10-21', createdAt: 1}]);
  const before = copy(state);
  page.onShow();
  page.draw();
  page.detail();
  page.onShow();
  page.draw();
  page.skip(input(true));
  page.changeCategory(input('蔬菜手抓'));
  page.draw();
  page.resetFilters();
  assert.deepEqual(state, before);
});
