'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const selectors = require('../utils/selectors');
const recipes = require('../data/recipes');

function harness(pantry = []) {
  const app = {globalData: {pantry}};
  const state = {recipes, logs: []};
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/ingredients/index.js'), 'utf8'), {
    Page: value => { definition = value; }, getApp: () => app,
    require: name => name.endsWith('/selectors') ? selectors : name.endsWith('/store') ?
      {getState: () => state, getWarning: () => ''} : {error: error => {throw error;}},
    wx: {hideKeyboard() {}, showToast() {}, pageScrollTo() {}}
  });
  const page = {...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(value) {Object.assign(this.data, value);}};
  page.refresh();
  return {page, app};
}

function toggle(page, name) { page.toggleIngredient({currentTarget: {dataset: {name}}}); }

test('ingredient tile toggles preserve hidden choices and expose the selected state', () => {
  const {page, app} = harness(['冬瓜']);
  assert.equal(page.data.options.length, 9);
  assert.ok(page.data.options.some(item => item.value === '豆腐'));
  toggle(page, '南瓜');
  assert.deepEqual(Array.from(app.globalData.pantry), ['冬瓜', '南瓜']);
  assert.equal(page.data.options.find(item => item.value === '南瓜').selected, true);
  page.searchIngredient({detail: {value: '鸡蛋'}});
  toggle(page, '鸡蛋');
  assert.deepEqual(Array.from(app.globalData.pantry), ['冬瓜', '南瓜', '鸡蛋']);
  toggle(page, '南瓜');
  assert.deepEqual(Array.from(app.globalData.pantry), ['冬瓜', '南瓜', '鸡蛋'], 'a hidden tile cannot toggle a different selection');
  toggle(page, '鸡蛋');
  assert.deepEqual(Array.from(app.globalData.pantry), ['冬瓜', '南瓜']);
});

test('matching sections partition real recipe matches and honor complete-only filtering', () => {
  const {page} = harness(['南瓜', '小米', '鸡肉']);
  assert.ok(page.data.completeMatches.length > 0);
  assert.ok(page.data.partialMatches.length > 0);
  assert.ok(page.data.completeMatches.every(item => item.missingCount === 0));
  assert.ok(page.data.partialMatches.every(item => item.missingCount > 0));
  assert.equal(page.data.completeMatches.length + page.data.partialMatches.length, page.data.matches.length);
  const completeIds = Array.from(page.data.completeMatches, item => item.id);
  page.changeComplete({detail: {value: true}});
  assert.equal(page.data.partialMatches.length, 0);
  assert.deepEqual(Array.from(page.data.matches, item => item.id), completeIds);
  page.clearPantry();
  assert.equal(page.data.matches.length, 0);
  assert.equal(page.data.completeMatches.length, 0);
});

test('custom ingredient remains searchable after adding it to the pantry', () => {
  const {page, app} = harness();
  page.inputIngredient({detail: {value: ' 冬瓜 '}});
  page.addIngredient();
  assert.deepEqual(Array.from(app.globalData.pantry), ['冬瓜']);
  page.searchIngredient({detail: {value: '冬瓜'}});
  assert.equal(page.data.options.length, 1);
  assert.equal(page.data.options[0].selected, true);
});
