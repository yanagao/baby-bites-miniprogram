'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const uiFiles = ['pages','components','custom-tab-bar'].flatMap(dir => walk(path.join(root, dir))).concat(path.join(root,'app.wxss'));

// The supplied 2026-10-23 design authorizes application styling.
// Vendor integrity remains enforced below.

test('generated TDesign runtime remains byte-for-byte identical to the installed release', () => {
  const installed = path.join(root, 'node_modules/tdesign-miniprogram');
  assert.ok(fs.existsSync(installed), 'run npm ci before validating vendor integrity');
  const generated = path.join(root, 'miniprogram_npm/tdesign-miniprogram');
  for (const file of walk(generated)) {
    const relative = path.relative(generated, file);
    const original = path.join(installed, relative === 'LICENSE' ? relative : 'miniprogram_dist/' + relative);
    assert.ok(fs.existsSync(original), relative);
    assert.ok(fs.readFileSync(file).equals(fs.readFileSync(original)), relative + ' was modified');
  }
});

function pageHarness(name, state, app) {
  let definition;
  const navigation = [];
  const selectors = require('../utils/selectors');
  vm.runInNewContext(fs.readFileSync(path.join(root, `pages/${name}/index.js`),'utf8'), {
    Page: value => { definition = value; }, getApp: () => app,
    require: name => name.endsWith('/selectors') ? selectors : name.endsWith('/store') ? {getState: () => state, getWarning: () => '', getSyncInfo: () => ({owner: 'owner-a'}), subscribe: () => () => {}} : {error: error => {throw error;}},
    wx: {hideKeyboard() {}, pageScrollTo() {}, navigateTo: options => navigation.push(options.url)}
  });
  const page = {...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(value) {Object.assign(this.data, value);}};
  if (page.onLoad) page.onLoad({});
  return {page, navigation};
}

test('searching and changing visible ingredients preserves selected ingredients hidden by the search', () => {
  const app = {globalData: {pantry: ['南瓜', '鸡蛋']}};
  const {page} = pageHarness('ingredients', {recipes: [], logs: []}, app);
  page.refresh();
  page.searchIngredient({detail: {value: '南瓜'}});
  assert.deepEqual(Array.from(page.data.options, item => item.value), ['南瓜']);
  page.changeIngredients({detail: {value: []}});
  assert.deepEqual(Array.from(app.globalData.pantry), ['鸡蛋']);
  page.changeIngredients({detail: {value: ['南瓜', '南瓜']}});
  assert.deepEqual(Array.from(app.globalData.pantry), ['鸡蛋', '南瓜']);
  page.searchIngredient({detail: {value: '找不到'}});
  assert.equal(page.data.options.length, 0);
  assert.equal(page.data.pantry.length, 2);
  page.clearPantry();
  assert.equal(page.data.pantry.length, 0);
});

test('compact ingredient choices preserve selections from the full list and custom ingredients', () => {
  const app = {globalData: {pantry: ['山药', '冬瓜']}};
  const {page} = pageHarness('ingredients', {recipes: [], logs: []}, app);
  page.refresh();
  assert.equal(page.data.options.length, 8);
  page.changeIngredients({detail: {value: ['南瓜']}});
  assert.deepEqual(Array.from(app.globalData.pantry), ['山药', '冬瓜', '南瓜']);
  page.toggleAllIngredients();
  assert.ok(page.data.options.some(item => item.value === '冬瓜'));
  page.changeIngredients({detail: {value: ['南瓜', '冬瓜']}});
  assert.deepEqual(Array.from(app.globalData.pantry), ['南瓜', '冬瓜']);
  page.toggleAllIngredients();
  assert.equal(page.data.options.length, 8);
  page.searchIngredient({detail: {value: '山药'}});
  assert.deepEqual(Array.from(page.data.options, item => item.value), ['山药']);
  page.changeIngredients({detail: {value: ['山药']}});
  assert.deepEqual(Array.from(app.globalData.pantry), ['南瓜', '冬瓜', '山药']);
});

test('random selection is stable when returning and never creates a meal record', () => {
  const recipes = require('../data/recipes');
  const state = {recipes: recipes.map((recipe, index) => ({...recipe, createdAt: index})), logs: []};
  const {page, navigation} = pageHarness('random', state);
  page.onShow();
  const first = page.data.result.id;
  assert.equal(page.data.candidateCount, recipes.length);
  page.onShow();
  assert.equal(page.data.result.id, first);
  page.draw();
  assert.notEqual(page.data.result.id, first);
  assert.equal(state.logs.length, 0);
  page.detail();
  assert.match(navigation[0], /^\/pages\/detail\/index\?id=/);
  page.changeCategory({detail: {value: '不存在'}});
  assert.equal(page.data.category, '全部');
});
