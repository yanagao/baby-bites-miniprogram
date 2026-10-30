'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const selectors = require('../utils/selectors');
const seeds = require('../data/recipes');

function harness() {
  const state = {recipes: seeds.map((recipe, index) => ({...recipe,
    favorite: index === 0, createdAt: seeds.length - index})), logs: []};
  const navigation = [];
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/recipes/index.js'), 'utf8'), {
    Page(value) { definition = value; },
    require(name) {
      if (name.endsWith('/selectors')) return selectors;
      if (name.endsWith('/store')) return {getState: () => state, getWarning: () => ''};
      if (name.endsWith('/tab-bar')) return {syncTabBar() {}};
      return {error(error) { throw error; }};
    },
    wx: {navigateTo(options) { navigation.push(options.url); }}
  });
  const page = {...definition, data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) { Object.assign(this.data, update); }};
  page.refresh();
  return {page, state, navigation};
}
const event = value => ({detail: {value}});

test('collection tabs compose with search and advanced filters without modifying recipes', () => {
  const {page, state} = harness();
  const before = JSON.stringify(state);
  page.changeCollection(event('favorites'));
  assert.equal(page.data.recipes.length, 1);
  page.chooseCategory(event('蔬菜手抓'));
  assert.equal(page.data.recipes.length, 0);
  page.changeCollection(event('all'));
  assert.ok(page.data.recipes.length > 0);
  assert.ok(page.data.recipes.every(recipe => recipe.category === '蔬菜手抓'));
  page.changeTexture(event('细腻泥糊'));
  assert.match(page.data.filterSummary, /2 项筛选/);
  page.searchInput(event('西兰花'));
  assert.equal(page.data.recipes.length, 1);
  page.resetFilters();
  assert.equal(page.data.recipes.length, state.recipes.length);
  assert.equal(page.data.hasFilters, false);
  assert.equal(JSON.stringify(state), before);
});

test('recipe tiles open a recipe detail while keeping record and favorite actions there', () => {
  const {page, navigation} = harness();
  const id = page.data.recipes[0].id;
  page.openRecipe({currentTarget: {dataset: {id}}, detail: {}});
  assert.deepEqual(navigation, ['/pages/detail/index?id=' + encodeURIComponent(id)]);
  assert.equal(page.recordRecipe, undefined);
  assert.equal(page.toggleFavorite, undefined);
});

test('advanced filter sheet preserves the chosen collection when clearing its controls', () => {
  const {page, state} = harness(); const before = JSON.stringify(state);
  page.changeCollection(event('favorites')); page.openFilters();
  assert.equal(page.data.filtersVisible, true);
  page.searchInput(event('南瓜')); page.pickSort({currentTarget: {dataset: {value: 'quick'}}});
  assert.equal(page.data.advancedFilterCount, 2);
  page.clearAdvancedFilters();
  assert.equal(page.data.collection, 'favorites'); assert.equal(page.data.onlyFavorites, true);
  assert.equal(page.data.advancedFilterCount, 0); assert.equal(page.data.recipes.length, 1);
  page.closeFilters(); assert.equal(page.data.filtersVisible, false);
  assert.equal(JSON.stringify(state), before);
  page.openRecipe({detail: {id: state.recipes[0].id}});
});

test('filter popup follows the actual TDesign visible-change close event without resetting filters', () => {
  const {page} = harness();
  page.changeCollection(event('favorites')); page.searchInput(event('南瓜')); page.openFilters();
  page.filterVisibilityChange({detail: {visible: true}}); assert.equal(page.data.filtersVisible, true);
  page.filterVisibilityChange({detail: {}}); assert.equal(page.data.filtersVisible, true);
  page.filterVisibilityChange({detail: {visible: false}}); assert.equal(page.data.filtersVisible, false);
  assert.equal(page.data.collection, 'favorites'); assert.equal(page.data.search, '南瓜');
  const markup = fs.readFileSync(path.join(__dirname, '../pages/recipes/index.wxml'), 'utf8');
  assert.match(markup, /<t-popup[^>]*bind:visible-change="filterVisibilityChange"/);
});
