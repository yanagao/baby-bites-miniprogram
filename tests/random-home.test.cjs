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
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);

function harness(name = 'home', recipes = [seed[0], seed[2], seed[5]], logs = [], initialOwner = OWNER) {
  const state = {nickname: '宝宝', recipes: copy(recipes), logs: copy(logs)};
  const app = {globalData: {pantry: []}};
  const navigation = [], errors = [], listeners = new Set();
  let definition, owner = initialOwner, failSave = false, writes = 0;
  const store = {
    getState: () => state, getWarning: () => '', getSyncInfo: () => ({owner}),
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    toggleFavorite(id) {
      if (failSave) throw new Error('保存失败');
      const recipe = state.recipes.find(item => item.id === id);
      if (!recipe) throw new Error('这道菜谱已经不存在了');
      recipe.favorite = !recipe.favorite;
      writes++;
      listeners.forEach(callback => callback());
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages', name, 'index.js'), 'utf8'), {
    Page(value) { definition = value; },
    getApp: () => app,
    require(dependency) {
      if (dependency.endsWith('/selectors')) return selectors;
      if (dependency.endsWith('/store')) return store;
      if (dependency.endsWith('/tab-bar')) return {syncTabBar() {}};
      if (dependency.endsWith('/cloud')) return {socialEnabled: false};
      if (dependency.endsWith('/social')) return {getMine: async () => ({profile: {babyBirthDate: null}})};
      if (dependency.endsWith('/baby-age')) return require('../utils/baby-age');
      if (dependency.endsWith('/recipe-ages')) return require('../utils/recipe-ages');
      return {error(error) { errors.push(error.message); }, back() { navigation.push({type: 'back'}); }};
    },
    wx: {
      hideKeyboard() {},
      navigateTo(options) { navigation.push({type: 'navigateTo', url: options.url}); },
      switchTab(options) { navigation.push({type: 'switchTab', url: options.url}); }
    }
  });
  const page = {...definition, data: copy(definition.data), setData(update) { Object.assign(this.data, update); }};
  if (page.onLoad) page.onLoad();
  return {page, state, app, navigation, errors, listeners,
    switchOwner(value) { owner = value; listeners.forEach(callback => callback()); },
    failSave() { failSave = true; }, get writes() { return writes; }};
}

test('home recommendations come only from the current saved collection', () => {
  const recipes = seed.slice(0, 8).map((recipe, index) => ({...recipe, createdAt: index, favorite: index < 2}));
  const h = harness('home', recipes, [{id: 'meal', recipeId: recipes[0].id, rating: 1, date: '2000-01-01', createdAt: 1}]);
  const before = copy(h.state);
  h.page.onShow();
  assert.deepEqual(Array.from(h.page.data.recommendations, item => item.id), recipes.slice(2).reverse().map(item => item.id));
  h.page.onShow();
  assert.deepEqual(h.state, before);
  assert.equal(h.writes, 0);
});

test('home frequent recipes use the last 30 days of real meals and ignore future, old and deleted recipes', () => {
  const today = selectors.today();
  const daysAgo = days => new Date(Date.parse(today + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
  const recipes = seed.slice(0, 4);
  const meal = (id, index, date, createdAt = 1) => ({id, recipeId: recipes[index].id, date, createdAt, rating: 3});
  const logs = [meal('a', 0, daysAgo(1)), meal('b', 0, daysAgo(29)), meal('c', 1, today),
    meal('d', 2, daysAgo(30)), meal('future', 2, '9999-01-01'),
    {id: 'deleted', recipeId: 'deleted-recipe', date: today, rating: 2, createdAt: 1}];
  const h = harness('home', recipes, logs);
  const before = copy(h.state); h.page.refresh();
  assert.equal(h.page.data.recommendationTitle, '最近常做');
  assert.deepEqual(Array.from(h.page.data.recommendations, recipe => [recipe.id, recipe.recentMealCount]),
    [[recipes[0].id, 2], [recipes[1].id, 1]]);
  h.state.logs.push(meal('same-count', 1, today, 2)); h.page.refresh();
  assert.equal(h.page.data.recommendations[0].id, recipes[1].id);
  h.state.logs = before.logs; assert.deepEqual(h.state, before); assert.equal(h.writes, 0);
});

test('home ingredient preview mirrors temporary selected ingredients and defaults are not marked selected', () => {
  const h = harness(); h.page.refresh();
  assert.equal(h.page.data.pantryCount, 0);
  assert.deepEqual(Array.from(h.page.data.pantryPreview), ['南瓜', '鸡蛋', '西兰花', '小米']);
  h.app.globalData.pantry = ['牛肉', '山药', '面粉', '鸡蛋', '菠菜']; h.page.refresh();
  assert.equal(h.page.data.pantryCount, 5);
  assert.deepEqual(Array.from(h.page.data.pantryPreview), ['牛肉', '山药', '面粉', '鸡蛋']);
  assert.equal(h.writes, 0);
});

test('home quick favorite toggles only an existing recipe and leaves meal feedback untouched', () => {
  const h = harness(), id = h.state.recipes[0].id;
  h.page.refresh(); const beforeLogs = copy(h.state.logs), previous = h.state.recipes[0].favorite;
  h.page.toggleFavorite({currentTarget: {dataset: {id, owner: OWNER}}});
  assert.equal(h.state.recipes[0].favorite, !previous); assert.deepEqual(h.state.logs, beforeLogs);
  h.page.toggleFavorite({currentTarget: {dataset: {id: 'deleted', owner: OWNER}}});
  assert.equal(h.writes, 1);
  h.failSave(); h.page.toggleFavorite({currentTarget: {dataset: {id, owner: OWNER}}});
  assert.equal(h.state.recipes[0].favorite, !previous); assert.deepEqual(h.errors, ['保存失败']);
});

test('home ignores a favorite tap from a card rendered for a different account', () => {
  const h = harness(); h.page.refresh(); const id = h.state.recipes[0].id;
  h.switchOwner(OTHER); h.page.toggleFavorite({currentTarget: {dataset: {id, owner: OWNER}}});
  assert.equal(h.writes, 0); assert.equal(h.page.data.recommendationOwner, OTHER);
});

test('home search trims and encodes a submitted query and ignores empty searches', () => {
  const {page, navigation} = harness();
  page.submitSearch(input('  '));
  assert.equal(navigation.length, 0);
  page.search(input(' 南瓜 & 鸡蛋 '));
  page.submitSearch({detail: {}});
  page.submitSearch(input(' 面条 '));
  assert.deepEqual(navigation, [
    {type: 'navigateTo', url: '/pages/recipes/index?search=' + encodeURIComponent('南瓜 & 鸡蛋')},
    {type: 'navigateTo', url: '/pages/recipes/index?search=' + encodeURIComponent('面条')}
  ]);
  assert.equal(page.data.search, '面条');
});

test('home entries open the random, ingredient, cookbook and recipe editor pages', () => {
  const {page, navigation} = harness();
  ['goRandom', 'goIngredients', 'goRecipes', 'addRecipe'].forEach(action => page[action]());
  assert.deepEqual(navigation, [
    {type: 'navigateTo', url: '/pages/random/index'},
    {type: 'navigateTo', url: '/pages/ingredients/index'},
    {type: 'navigateTo', url: '/pages/recipes/index'},
    {type: 'navigateTo', url: '/pages/editor/index'}
  ]);
  page.openRecipe({detail: {id: 'one & two'}});
  page.openRecipe({currentTarget: {dataset: {id: 'recent'}}});
  assert.equal(navigation[4].url, '/pages/detail/index?id=one%20%26%20two');
  assert.equal(navigation[5].url, '/pages/detail/index?id=recent');
});

test('home refresh replaces old recommendations while retaining the search draft', () => {
  const {page, state} = harness();
  page.onShow();
  page.search(input('南瓜'));
  state.nickname = '新称呼';
  state.recipes = [{...copy(seed[0]), id: 'new-account', name: '新菜谱', favorite: true}];
  page.refresh();
  assert.equal(page.data.nickname, '新称呼');
  assert.equal(page.data.search, '南瓜');
  assert.deepEqual(Array.from(page.data.recommendations, item => item.id), ['new-account']);
  state.recipes = [];
  page.onShow();
  assert.equal(page.data.recommendations.length, 0);
});

test('standalone random keeps the chosen recipe on return and refreshes edits without writing a meal', () => {
  const h = harness('random', undefined, [{id: 'meal', recipeId: seed[0].id, rating: 1, date: '2026-10-21', createdAt: 1}]);
  const {page, state, navigation} = h;
  page.onShow();
  const id = page.data.result.id;
  assert.equal(page.data.candidateCount, 3);
  assert.equal(page.data.skipDisliked, false);
  page.detail();
  assert.equal(navigation[0].url, '/pages/detail/index?id=' + encodeURIComponent(id));
  state.recipes.find(recipe => recipe.id === id).name = '修改后的菜名';
  page.onShow();
  assert.equal(page.data.result.id, id);
  assert.equal(page.data.result.name, '修改后的菜名');
  page.draw();
  assert.notEqual(page.data.result.id, id);
  assert.equal(state.logs.length, 1);
  assert.equal(h.writes, 0);
});

test('random filters use the latest meal preference and valid recipe categories', () => {
  const logs = [{id: 'old', recipeId: seed[0].id, rating: 3, date: '2026-10-20', createdAt: 1},
    {id: 'latest', recipeId: seed[0].id, rating: 1, date: '2026-10-21', createdAt: 2}];
  const {page, state} = harness('random', undefined, logs);
  const before = copy(state);
  page.onShow();
  page.toggleFilters();
  assert.equal(page.data.filtersVisible, true);
  page.toggleFilters();
  assert.equal(page.data.filtersVisible, false);
  page.changeCategory(input('粥饭主食'));
  assert.equal(page.data.result.id, seed[0].id);
  assert.equal(page.data.candidateCount, 1);
  page.skip(input(true));
  assert.equal(page.data.result, null);
  assert.equal(page.data.candidateCount, 0);
  page.changeCategory(input('全部'));
  assert.equal(page.data.candidateCount, 2);
  page.changeCategory(input('不存在的分类'));
  assert.equal(page.data.category, '全部');
  assert.deepEqual(state, before);
  state.logs.push({id: 'new', recipeId: seed[0].id, rating: 2, date: '2026-10-22', createdAt: 3});
  page.onShow();
  assert.equal(page.data.candidateCount, 3);
  page.resetFilters();
  assert.equal(page.data.skipDisliked, false);
});

test('random handles single recipes, deletions and the first added recipe', () => {
  const {page, state, navigation} = harness('random', [seed[0]]);
  page.onShow();
  page.draw();
  assert.equal(page.data.result.id, seed[0].id);
  assert.equal(page.data.candidateCount, 1);
  state.recipes = [];
  page.onShow();
  assert.equal(page.data.result, null);
  assert.equal(page.data.hasRecipes, false);
  page.detail();
  assert.equal(navigation.length, 0);
  page.add();
  assert.equal(navigation[0].url, '/pages/editor/index');
  state.recipes.push(copy(seed[2]));
  page.onShow();
  assert.equal(page.data.result.id, seed[2].id);
});

test('random favorite and unfavorite keep the chosen dish and never create or alter meal feedback', () => {
  const logs = [{id: 'meal', recipeId: seed[0].id, rating: 1, date: '2026-10-21', createdAt: 1}];
  const h = harness('random', [{...seed[0], favorite: false}], logs);
  h.page.onShow();
  h.page.favorite();
  assert.equal(h.page.data.result.id, seed[0].id);
  assert.equal(h.page.data.result.favorite, true);
  assert.equal(h.page.data.result.rating, 1);
  h.page.favorite();
  assert.equal(h.page.data.result.favorite, false);
  assert.equal(h.writes, 2);
  assert.deepEqual(h.state.logs, logs);
});

test('failed favorite persistence leaves the recipe and displayed favorite state unchanged', () => {
  const h = harness('random', [{...seed[0], favorite: false}]);
  h.page.onShow();
  h.failSave();
  h.page.favorite();
  assert.equal(h.page.data.result.favorite, false);
  assert.equal(h.state.recipes[0].favorite, false);
  assert.equal(h.writes, 0);
  assert.deepEqual(h.errors, ['保存失败']);
});

test('random immediately clears and locks old account results through an A to B to A switch', () => {
  const h = harness('random');
  h.page.onShow();
  h.page.toggleFilters();
  h.switchOwner(OTHER);
  assert.equal(h.page.data.filtersVisible, false);
  assert.equal(h.page.data.result, null);
  assert.ok(h.page.data.accountError);
  h.switchOwner(OWNER);
  h.page.onShow();
  h.page.draw();
  h.page.favorite();
  h.page.detail();
  assert.equal(h.page.data.result, null);
  assert.equal(h.writes, 0);
  assert.equal(h.navigation.length, 0);
  h.page.onUnload();
  assert.equal(h.listeners.size, 0);
});

test('random permits first account binding and ignores actions after unloading', () => {
  const h = harness('random', [{...seed[0], favorite: false}], [], '');
  h.page.onShow();
  h.switchOwner(OWNER);
  h.page.favorite();
  assert.equal(h.page.data.result.favorite, true);
  assert.equal(h.page.data.accountError, '');
  h.page.onUnload();
  h.page.favorite();
  assert.equal(h.writes, 1);
});

test('random category chips combine real categories with OR and empty selection restores all dishes', () => {
  const h = harness('random');
  const tap = category => ({currentTarget: {dataset: {category}}});
  h.page.onShow();
  assert.deepEqual(Array.from(h.page.data.categoryOptions, item => item.value), selectors.categories);
  assert.equal(h.page.data.categoryOptions.filter(item => item.selected).length, 1);
  h.page.toggleCategory(tap('粥饭主食'));
  assert.deepEqual(Array.from(h.page.data.selectedCategories), ['粥饭主食']);
  assert.equal(h.page.data.result.id, seed[0].id);
  h.page.toggleCategory(tap('蔬菜手抓'));
  assert.equal(h.page.data.candidateCount, 2);
  assert.deepEqual(Array.from(h.page.candidates(h.state), item => item.id).sort(), [seed[0].id, seed[2].id].sort());
  assert.equal(h.page.data.categoryOptions.filter(item => item.selected).length, 2);
  const current = h.page.data.result.id;
  h.page.onShow();
  assert.equal(h.page.data.result.id, current);
  assert.deepEqual(Array.from(h.page.data.selectedCategories), ['粥饭主食', '蔬菜手抓']);
  h.page.draw();
  assert.notEqual(h.page.data.result.id, current);
  h.page.toggleCategory(tap('蔬菜手抓'));
  assert.equal(h.page.data.candidateCount, 1);
  h.page.toggleCategory(tap('粥饭主食'));
  assert.equal(h.page.data.candidateCount, 3);
  assert.equal(h.page.data.categoryOptions[0].selected, true);
  h.page.toggleCategory(tap('月龄筛选'));
  assert.equal(h.page.data.candidateCount, 3);
  h.page.toggleCategory(tap('早餐饼'));
  h.page.toggleCategory(tap('全部'));
  assert.deepEqual(Array.from(h.page.data.selectedCategories), []);
  assert.equal(h.page.data.candidateCount, 3);
  assert.equal(h.writes, 0);
});

test('random multi-category candidates honor the latest dislikes without changing the saved collection', () => {
  const state = {recipes: copy([seed[0], seed[2], seed[5]]), logs: [
    {id: 'old', recipeId: seed[0].id, rating: 3, date: '2026-10-20', createdAt: 1},
    {id: 'new', recipeId: seed[0].id, rating: 1, date: '2026-10-21', createdAt: 2}
  ]};
  const before = copy(state);
  const categories = ['粥饭主食', '蔬菜手抓', '粥饭主食', '不存在'];
  assert.deepEqual(selectors.randomCandidates(state, {categories}).map(item => item.id), [seed[2].id]);
  assert.equal(selectors.randomCandidates(state, {categories, skipDisliked: false}).length, 2);
  assert.equal(selectors.randomRecipe(state, {categories, skipDisliked: false, lastId: seed[0].id}, () => 0).id, seed[2].id);
  assert.equal(selectors.randomRecipe(state, {category: '粥饭主食', skipDisliked: false}, () => 0).id, seed[0].id);
  assert.equal(selectors.randomRecipe(state, {category: '粥饭主食'}, () => 0), null);
  assert.equal(selectors.randomCandidates(state, {category: '粥饭主食', categories: [], skipDisliked: false}).length, 3);
  assert.deepEqual(state, before);
});

test('random account invalidation clears category preferences and blocks every filter action', () => {
  const h = harness('random');
  const tap = category => ({currentTarget: {dataset: {category}}});
  h.page.onShow();
  h.page.toggleCategory(tap('蔬菜手抓'));
  h.page.skip(input(true));
  h.switchOwner(OTHER);
  assert.deepEqual(Array.from(h.page.data.selectedCategories), []);
  assert.equal(h.page.data.skipDisliked, false);
  h.page.toggleCategory(tap('早餐饼'));
  h.page.changeCategory(input('粥饭主食'));
  h.page.skip(input(true));
  h.page.resetFilters();
  assert.deepEqual(Array.from(h.page.data.selectedCategories), []);
  assert.equal(h.page.data.skipDisliked, false);
  assert.equal(h.page.data.result, null);
  assert.equal(h.writes, 0);
});

test('random card keeps favorite separate from recipe navigation and labels both primary actions directly', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../pages/random/index.wxml'), 'utf8');
  assert.match(markup, /class="random-favorite[^>]+catchtap="favorite"/);
  assert.match(markup, /class="random-action random-skip"[^>]+bindtap="draw"[^>]*>[\s\S]*?<text>换一个<\/text>/);
  assert.match(markup, /class="random-action random-detail"[^>]+bindtap="detail"[^>]*><text>看看做法<\/text>/);
  assert.match(markup, /class="random-category[^>]+bindtap="toggleCategory"/);
  assert.doesNotMatch(markup, /hasRecipes && filtersVisible|高蛋白|6-8月/);
});

test('random month chips union selected ages and intersect categories without writing preferences', () => {
  const recipes = [
    {...seed[0], ageGroups: ['6-8', '9-11']},
    {...seed[2], ageGroups: ['9-11']},
    {...seed[5], ageGroups: ['12-17', '18+']},
    {...seed[3]}
  ];
  const h = harness('random', recipes);
  const tap = ageGroup => ({currentTarget: {dataset: {ageGroup}}});
  h.page.onShow();
  assert.equal(h.page.data.candidateCount, 4);
  assert.equal(h.page.data.ageOptions[0].selected, true);
  h.page.toggleAgeGroup(tap('6-8'));
  assert.equal(h.page.data.candidateCount, 2);
  assert.ok([seed[0].id, seed[3].id].includes(h.page.data.result.id));
  h.page.toggleAgeGroup(tap('9-11'));
  assert.equal(h.page.data.candidateCount, 3);
  assert.deepEqual(Array.from(h.page.data.selectedAgeGroups), ['6-8', '9-11']);
  const previous = h.page.data.result.id;
  h.page.onShow();
  assert.equal(h.page.data.result.id, previous);
  h.page.draw();
  assert.notEqual(h.page.data.result.id, previous);
  h.page.toggleCategory({currentTarget: {dataset: {category: '蔬菜手抓'}}});
  assert.equal(h.page.data.candidateCount, 1);
  assert.equal(h.page.data.result.id, seed[2].id);
  h.page.toggleAgeGroup(tap('9-11'));
  assert.equal(h.page.data.candidateCount, 0);
  assert.equal(h.page.data.result, null);
  h.page.resetFilters();
  assert.equal(h.page.data.candidateCount, 4);
  assert.deepEqual(Array.from(h.page.data.selectedAgeGroups), []);
  assert.deepEqual(Array.from(h.page.data.selectedCategories), []);
  assert.equal(h.writes, 0);
});

test('random age candidates include missing and empty age selections while honoring category and dislike exclusions', () => {
  const state = {recipes: [
    {...seed[0], ageGroups: ['6-8', '9-11']},
    {...seed[2], ageGroups: ['9-11']},
    {...seed[5], ageGroups: []},
    {...seed[3]}
  ], logs: [{id: 'recent', recipeId: seed[0].id, rating: 1, date: '2026-10-29', createdAt: 1}]};
  const before = copy(state);
  const options = {ageGroups: ['6-8', '9-11', '9-11']};
  assert.deepEqual(selectors.randomCandidates(state, options).map(recipe => recipe.id), [seed[2].id, seed[5].id, seed[3].id]);
  assert.equal(selectors.randomCandidates(state, {...options, skipDisliked: false}).length, 4);
  assert.equal(selectors.randomCandidates(state, {ageGroups: [], skipDisliked: false}).length, 4);
  assert.deepEqual(selectors.randomCandidates(state, {ageGroups: ['18+'], skipDisliked: false}).map(recipe => recipe.id), [seed[5].id, seed[3].id]);
  assert.deepEqual(selectors.randomCandidates(state, {ageGroups: ['18+'], categories: ['粥饭主食'], skipDisliked: false}).map(recipe => recipe.id), [seed[3].id]);
  state.logs.push({id: 'disliked-unrestricted', recipeId: seed[3].id, rating: 1, date: '2026-10-29', createdAt: 2});
  assert.deepEqual(selectors.randomCandidates(state, {ageGroups: ['18+'], categories: ['粥饭主食']}).map(recipe => recipe.id), []);
  state.logs.pop();
  assert.equal(selectors.randomRecipe(state, {...options, skipDisliked: false, lastId: seed[0].id}, () => 0).id, seed[2].id);
  assert.deepEqual(state, before);
});

test('age toggles clear back to unrestricted, ignore invalid values and redraw after recipe metadata changes', () => {
  const h = harness('random', [{...seed[0], ageGroups: ['6-8']}, {...seed[2], ageGroups: ['9-11']}]);
  const tap = ageGroup => ({currentTarget: {dataset: {ageGroup}}});
  h.page.onShow();
  h.page.toggleAgeGroup(tap('6-8'));
  h.page.toggleAgeGroup(tap('not-an-age'));
  assert.deepEqual(Array.from(h.page.data.selectedAgeGroups), ['6-8']);
  h.state.recipes[0].ageGroups = ['12-17'];
  h.page.onShow();
  assert.equal(h.page.data.result, null);
  h.page.toggleAgeGroup(tap('6-8'));
  assert.equal(h.page.data.candidateCount, 2);
  h.page.toggleAgeGroup(tap('12-17'));
  h.page.toggleAgeGroup(tap('全部'));
  assert.equal(h.page.data.ageOptions[0].selected, true);
  assert.equal(h.page.data.candidateCount, 2);
});

test('random age selections are cleared and locked across account switches and after unloading', () => {
  const h = harness('random', [{...seed[0], ageGroups: ['6-8']}]);
  const tap = ageGroup => ({currentTarget: {dataset: {ageGroup}}});
  h.page.onShow();
  h.page.toggleAgeGroup(tap('6-8'));
  h.switchOwner(OTHER);
  h.switchOwner(OWNER);
  h.page.toggleAgeGroup(tap('9-11'));
  assert.deepEqual(Array.from(h.page.data.selectedAgeGroups), []);
  assert.equal(h.page.data.result, null);
  h.page.onUnload();
  h.page.toggleAgeGroup(tap('6-8'));
  assert.deepEqual(Array.from(h.page.data.selectedAgeGroups), []);
  assert.equal(h.writes, 0);
});

test('default recipes and clearing all recipe age choices participate in every selected month without data migration', () => {
  const h = harness('random', seed);
  const before = copy(h.state);
  h.page.onShow();
  for (const {value} of selectors.ageGroups) {
    h.page.toggleAgeGroup({currentTarget: {dataset: {ageGroup: '全部'}}});
    h.page.toggleAgeGroup({currentTarget: {dataset: {ageGroup: value}}});
    assert.equal(h.page.data.candidateCount, seed.length);
    assert.equal(h.page.data.result.ageLabel, '不限月龄');
  }
  assert.deepEqual(h.state, before);
  assert.equal(h.writes, 0);
  const limited = harness('random', [{...seed[0], ageGroups: ['6-8']}]);
  limited.page.onShow();
  limited.page.toggleAgeGroup({currentTarget: {dataset: {ageGroup: '18+'}}});
  assert.equal(limited.page.data.result, null);
  limited.state.recipes[0].ageGroups = [];
  limited.page.onShow();
  assert.equal(limited.page.data.candidateCount, 1);
  assert.equal(limited.page.data.result.id, seed[0].id);
  assert.equal(limited.page.data.result.ageLabel, '不限月龄');
});
