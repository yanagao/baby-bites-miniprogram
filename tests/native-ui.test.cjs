'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
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

function fontHarness(version, failures = 0) {
  const calls = [];
  const module = {exports: {}};
  // The Mini Program runtime executes registered JavaScript modules. Node's
  // require() also loads JSON, which can hide an app-startup failure here.
  const requireFontModule = name => {
    const file = path.resolve(root, 'utils', name);
    assert.equal(path.extname(file), '.js', 'font data must be a JavaScript module');
    const fontModule = {exports: {}};
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {module: fontModule}, {filename: file});
    const font = fontModule.exports;
    const bytes = Buffer.from(font.base64, 'base64');
    assert.equal(bytes.subarray(0, 4).toString(), 'wOFF');
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), font.sha256);
    assert.equal(font.sha256, '377024275d01176d32461000713af752fbefb0d2520c49b0aeda82a3a3150b54');
    return font;
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'utils/tdesign-font.js'),'utf8'), {
    module, require: requireFontModule, Promise,
    wx: {getAppBaseInfo: () => ({SDKVersion: version}), loadFontFace(options) {
      calls.push(options); if (failures-- > 0) options.fail(); else options.success();
    }}
  });
  return {...module.exports, calls};
}

test('official icon font loads offline on supported runtimes without changing the font or CSS', async () => {
  const h = fontHarness('3.7.12');
  assert.equal(await h.loadTDesignIcons(), 'offline');
  assert.equal(await h.loadTDesignIcons(), 'offline');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].family, 't');
  assert.equal(h.calls[0].global, true);
  assert.match(h.calls[0].source, /^url\("data:font\/woff;base64,/);
  assert.equal(h.supportsDataURL('3.7.8'), false);
  assert.equal(h.supportsDataURL('3.7.9'), true);
});

test('older runtimes or rejected local fonts fall back to the official font endpoint', async () => {
  const old = fontHarness('2.32.3');
  assert.equal(await old.loadTDesignIcons(), 'network');
  assert.match(old.calls[0].source, /^url\("https:\/\/tdesign\.gtimg\.com\//);
  const fallback = fontHarness('3.7.12', 1);
  assert.equal(await fallback.loadTDesignIcons(), 'network');
  assert.equal(fallback.calls.length, 2);
  const unavailable = fontHarness('3.7.12', 2);
  assert.equal(await unavailable.loadTDesignIcons(), 'unavailable');
});

function pageHarness(name, state, app) {
  let definition;
  const navigation = [];
  const selectors = require('../utils/selectors');
  vm.runInNewContext(fs.readFileSync(path.join(root, `pages/${name}/index.js`),'utf8'), {
    Page: value => { definition = value; }, getApp: () => app,
    require: name => name.endsWith('/selectors') ? selectors : name.endsWith('/store') ? {getState: () => state, getWarning: () => ''} : {error: error => {throw error;}},
    wx: {hideKeyboard() {}, pageScrollTo() {}, navigateTo: options => navigation.push(options.url)}
  });
  const page = {...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(value) {Object.assign(this.data, value);}};
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
  const app = {globalData: {pantry: ['牛肉', '冬瓜']}};
  const {page} = pageHarness('ingredients', {recipes: [], logs: []}, app);
  page.refresh();
  assert.equal(page.data.options.length, 9);
  page.changeIngredients({detail: {value: ['南瓜']}});
  assert.deepEqual(Array.from(app.globalData.pantry), ['牛肉', '冬瓜', '南瓜']);
  page.toggleAllIngredients();
  assert.ok(page.data.options.some(item => item.value === '冬瓜'));
  page.changeIngredients({detail: {value: ['南瓜', '冬瓜']}});
  assert.deepEqual(Array.from(app.globalData.pantry), ['南瓜', '冬瓜']);
  page.toggleAllIngredients();
  assert.equal(page.data.options.length, 9);
  page.searchIngredient({detail: {value: '牛肉'}});
  assert.deepEqual(Array.from(page.data.options, item => item.value), ['牛肉']);
  page.changeIngredients({detail: {value: ['牛肉']}});
  assert.deepEqual(Array.from(app.globalData.pantry), ['南瓜', '冬瓜', '牛肉']);
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
