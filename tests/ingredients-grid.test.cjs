'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const selectors = require('../utils/selectors');
const recipes = require('../data/recipes');
const copy = value => JSON.parse(JSON.stringify(value));
const input = value => ({detail: {value}});

function harness(pantry = []) {
  const app = {globalData: {pantry: pantry.slice()}};
  const state = {recipes: copy(recipes), logs: []};
  const navigation = [];
  let currentPages = [];
  function open(name = 'ingredients') {
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages', name, 'index.js'), 'utf8'), {
      Page: value => { definition = value; }, getApp: () => app, getCurrentPages: () => currentPages,
      require: name => name.endsWith('/selectors') ? selectors : name.endsWith('/store') ?
        {getState: () => state, getWarning: () => ''} : {error: error => {throw error;}, back() {navigation.push({type: 'back'});}},
      wx: {hideKeyboard() {}, showToast() {},
        navigateTo(options) {navigation.push({type: 'navigateTo', url: options.url});},
        navigateBack() {navigation.push({type: 'navigateBack'});},
        redirectTo(options) {navigation.push({type: 'redirectTo', url: options.url});}}
    });
    const page = {...definition, route: 'pages/' + name + '/index', data: copy(definition.data), setData(value) {Object.assign(this.data, value);}};
    currentPages.push(page);
    page.onShow();
    return page;
  }
  return {page: open(), app, state, navigation, open, setStack(pages) {currentPages = pages;}};
}

function toggle(page, name) { page.toggleIngredient({currentTarget: {dataset: {name}}}); }
function remove(page, name) { page.removeIngredient({currentTarget: {dataset: {name}}}); }

test('ingredient tile toggles preserve hidden choices and expose the selected state', () => {
  const {page, app} = harness(['冬瓜']);
  assert.deepEqual(Array.from(page.data.options, item => item.value), ['南瓜', '鸡蛋', '西兰花', '小米', '土豆', '豆腐', '胡萝卜', '番茄']);
  toggle(page, '南瓜');
  assert.deepEqual(Array.from(app.globalData.pantry), ['冬瓜', '南瓜']);
  assert.equal(page.data.options.find(item => item.value === '南瓜').selected, true);
  page.searchIngredient(input('鸡蛋'));
  toggle(page, '鸡蛋');
  assert.deepEqual(Array.from(app.globalData.pantry), ['冬瓜', '南瓜', '鸡蛋']);
  toggle(page, '南瓜');
  assert.deepEqual(Array.from(app.globalData.pantry), ['冬瓜', '南瓜', '鸡蛋'], 'a hidden tile cannot toggle a different selection');
  toggle(page, '鸡蛋');
  assert.deepEqual(Array.from(app.globalData.pantry), ['冬瓜', '南瓜']);
});

test('more ingredients and search keep protein choices accessible without changing the compact grid or hidden selections', () => {
  const h = harness(['冬瓜']);
  const compact = Array.from(h.page.data.options, item => item.value);
  h.page.toggleAllIngredients();
  for (const name of ['鸡肉', '牛肉', '三文鱼', '菠菜', '山药', '冬瓜']) {
    assert.ok(h.page.data.options.some(item => item.value === name), name);
  }
  toggle(h.page, '鸡肉');
  h.page.toggleAllIngredients();
  assert.deepEqual(Array.from(h.page.data.options, item => item.value), compact);
  assert.deepEqual(Array.from(h.page.data.pantry), ['冬瓜', '鸡肉']);
  h.page.searchIngredient(input('牛肉'));
  assert.deepEqual(Array.from(h.page.data.options, item => item.value), ['牛肉']);
  toggle(h.page, '牛肉');
  h.page.searchIngredient(input(''));
  assert.deepEqual(Array.from(h.page.data.options, item => item.value), compact);
  assert.deepEqual(Array.from(h.page.data.pantry), ['冬瓜', '鸡肉', '牛肉']);
  remove(h.page, '鸡肉');
  remove(h.page, '冬瓜');
  assert.deepEqual(Array.from(h.page.data.pantry), ['牛肉']);
  assert.deepEqual(h.navigation, []);
});

test('selected chips can remove hidden ingredients without changing other selections', () => {
  const {page, app} = harness(['冬瓜', '南瓜', '鸡蛋']);
  page.searchIngredient(input('鸡蛋'));
  remove(page, '冬瓜');
  assert.deepEqual(Array.from(app.globalData.pantry), ['南瓜', '鸡蛋']);
  remove(page, '鸡蛋');
  assert.equal(page.data.options[0].selected, false);
  assert.deepEqual(Array.from(page.data.pantry), ['南瓜']);
  page.clearPantry();
  assert.equal(page.data.pantry.length, 0);
  assert.equal(page.data.matchCount, 0);
});

test('custom ingredients are normalized, deduplicated and searchable after selection', () => {
  const {page, app} = harness();
  page.inputIngredient(input(' 冬瓜 '));
  page.addIngredient();
  page.inputIngredient(input('冬瓜'));
  page.addIngredient();
  assert.deepEqual(Array.from(app.globalData.pantry), ['冬瓜']);
  page.searchIngredient(input('冬瓜'));
  assert.equal(page.data.options.length, 1);
  assert.equal(page.data.options[0].selected, true);
  page.inputIngredient(input('西红柿'));
  page.addIngredient();
  assert.deepEqual(Array.from(app.globalData.pantry), ['冬瓜', '番茄']);
});

test('view-all result navigation requires a selection and matches the inline recommendations', () => {
  const h = harness();
  h.page.showMatches();
  assert.equal(h.navigation.length, 0);
  toggle(h.page, '南瓜');
  toggle(h.page, '小米');
  h.page.showMatches();
  assert.deepEqual(h.navigation, [{type: 'navigateTo', url: '/pages/ingredient-results/index'}]);
  const result = h.open('ingredient-results');
  assert.ok(h.page.data.matchCount > 0);
  assert.equal(h.page.data.matchCount, result.data.matches.length);
  assert.deepEqual(Array.from(result.data.pantry), ['南瓜', '小米']);
});

test('inline preview shows the first four real matches while counts and view-all include the complete result set', () => {
  const pantry = ['南瓜', '鸡蛋', '西兰花', '小米', '土豆', '豆腐', '胡萝卜', '番茄'];
  const h = harness(pantry);
  const before = copy(h.state);
  const matches = selectors.matchRecipes(h.state, pantry, false);
  assert.ok(matches.length > 4);
  assert.equal(h.page.data.matchCount, matches.length);
  assert.equal(h.page.data.previewMatches.length, 4);
  assert.deepEqual(copy(h.page.data.previewMatches), copy(matches.slice(0, 4)));
  assert.equal(h.page.data.completeMatches.length + h.page.data.partialMatches.length, matches.length);
  h.page.data.partialMatches.forEach(recipe => {
    assert.ok(recipe.missingCount > 0);
    assert.ok(recipe.missingText);
    assert.equal(recipe.complete, false);
  });
  h.page.showMatches();
  const result = h.open('ingredient-results');
  assert.deepEqual(Array.from(result.data.matches, item => item.id), matches.map(item => item.id));
  assert.deepEqual(h.state, before);
  h.page.clearPantry();
  assert.equal(h.page.data.previewMatches.length, 0);
  assert.equal(h.page.data.matchCount, 0);
});

test('ingredient recommendations appear immediately, regroup on selection and clear with the last chip', () => {
  const h = harness();
  const before = copy(h.state);
  assert.equal(h.page.data.matches.length, 0);
  toggle(h.page, '南瓜');
  assert.ok(h.page.data.matches.length > 0);
  assert.equal(h.page.data.completeMatches.length, 0);
  assert.equal(h.page.data.partialMatches.length, h.page.data.matchCount);
  toggle(h.page, '小米');
  assert.ok(h.page.data.completeMatches.some(recipe => recipe.id === 'pumpkin-millet'));
  assert.equal(h.page.data.completeMatches.length + h.page.data.partialMatches.length, h.page.data.matchCount);
  assert.deepEqual(copy(h.page.data.matches), copy(selectors.matchRecipes(h.state, ['南瓜', '小米'], false)));
  remove(h.page, '小米');
  assert.equal(h.page.data.completeMatches.length, 0);
  remove(h.page, '南瓜');
  assert.equal(h.page.data.matchCount, 0);
  assert.equal(h.page.data.matches.length, 0);
  assert.equal(h.page.data.completeMatches.length, 0);
  assert.equal(h.page.data.partialMatches.length, 0);
  assert.equal(h.page.data.previewMatches.length, 0);
  assert.deepEqual(h.navigation, []);
  assert.deepEqual(h.state, before);
});

test('ingredient search keeps hidden selections and recommendations while unmatched custom choices show an empty result', () => {
  const h = harness(['南瓜', '小米']);
  const ids = Array.from(h.page.data.matches, recipe => recipe.id);
  h.page.searchIngredient(input('鸡蛋'));
  assert.deepEqual(Array.from(h.page.data.matches, recipe => recipe.id), ids);
  assert.deepEqual(Array.from(h.page.data.pantry), ['南瓜', '小米']);
  h.page.clearPantry();
  h.page.inputIngredient(input('测试食材'));
  h.page.addIngredient();
  assert.deepEqual(Array.from(h.page.data.pantry), ['测试食材']);
  assert.equal(h.page.data.matches.length, 0);
  assert.equal(h.page.data.matchCount, 0);
  assert.equal(h.page.data.completeMatches.length, 0);
  assert.equal(h.page.data.partialMatches.length, 0);
  assert.equal(h.page.data.previewMatches.length, 0);
});

test('inline matches open only current recipe results and refresh after recipes change', () => {
  const h = harness(['南瓜', '小米']);
  const id = h.page.data.matches[0].id;
  h.page.openRecipe({currentTarget: {dataset: {id}}});
  h.page.openRecipe({detail: {id: 'not-a-result'}});
  assert.deepEqual(h.navigation, [{type: 'navigateTo', url: '/pages/detail/index?id=' + encodeURIComponent(id)}]);
  h.state.recipes = [];
  h.page.onShow();
  assert.equal(h.page.data.matches.length, 0);
  assert.equal(h.page.data.matchCount, 0);
  assert.equal(h.page.data.previewMatches.length, 0);
  h.page.openRecipe({detail: {id}});
  assert.equal(h.navigation.length, 1);
});

test('result groups partition real recipe matches and honor complete-only filtering', () => {
  const h = harness(['南瓜', '小米', '鸡肉']);
  const page = h.open('ingredient-results');
  assert.ok(page.data.completeMatches.length > 0);
  assert.ok(page.data.partialMatches.length > 0);
  assert.ok(page.data.completeMatches.every(item => item.missingCount === 0));
  assert.ok(page.data.partialMatches.every(item => item.missingCount > 0));
  assert.equal(page.data.completeMatches.length + page.data.partialMatches.length, page.data.matches.length);
  const completeIds = Array.from(page.data.completeMatches, item => item.id);
  page.changeComplete(input(true));
  assert.equal(page.data.partialMatches.length, 0);
  assert.deepEqual(Array.from(page.data.matches, item => item.id), completeIds);
  page.changeComplete(input(false));
  assert.ok(page.data.partialMatches.length > 0);
});

test('returning to ingredient selection keeps choices and updated selections are used for the next result', () => {
  const h = harness(['南瓜', '小米']);
  const page = h.open('ingredient-results');
  page.selectIngredients();
  assert.deepEqual(h.navigation, [{type: 'navigateBack'}]);
  h.page.onShow();
  assert.deepEqual(Array.from(h.page.data.pantry), ['南瓜', '小米']);
  remove(h.page, '小米');
  page.onShow();
  assert.deepEqual(Array.from(page.data.pantry), ['南瓜']);
  assert.equal(page.data.matches.length, h.page.data.matchCount);
  h.page.clearPantry();
  page.onShow();
  assert.equal(page.data.matches.length, 0);
  assert.equal(page.data.completeMatches.length, 0);
  assert.equal(page.data.partialMatches.length, 0);
});

test('opening results directly still offers a working path to select ingredients', () => {
  const h = harness();
  const page = h.open('ingredient-results');
  h.setStack([page]);
  assert.equal(page.data.matches.length, 0);
  page.selectIngredients();
  assert.deepEqual(h.navigation, [{type: 'redirectTo', url: '/pages/ingredients/index'}]);
});

test('results refresh after recipe updates and open only matched recipe IDs without writing saved data', () => {
  const h = harness(['南瓜', '小米']);
  const page = h.open('ingredient-results');
  const before = copy(h.state);
  const id = page.data.matches[0].id;
  page.openRecipe({currentTarget: {dataset: {id}}});
  page.openRecipe({detail: {id: 'not-a-result'}});
  assert.deepEqual(h.navigation, [{type: 'navigateTo', url: '/pages/detail/index?id=' + encodeURIComponent(id)}]);
  page.changeComplete(input(true));
  assert.deepEqual(h.state, before);
  h.state.recipes = [];
  page.refresh();
  h.page.refresh();
  assert.equal(page.data.matches.length, 0);
  assert.equal(h.page.data.matchCount, 0);
});
