'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const selectors = require('../utils/selectors');
const allergies = require('../utils/allergies');
const clone = value => JSON.parse(JSON.stringify(value));
const root = path.join(__dirname, '..');
const OWNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const author = {id: 'a'.repeat(32), name: '朋友', exists: true};
const makeRecipe = (id, ingredient) => ({id, profileId: author.id, authorName: author.name, name: ingredient + '辅食',
  ingredients: [{name: ingredient, amount: '少量'}], steps: ['煮熟'], category: '粥饭主食', texture: '细腻泥糊', minutes: 10,
  photo: '', photoURL: '', createdAt: 1, updatedAt: 1, favorite: false});
const egg = makeRecipe('e'.repeat(64), '鸡蛋');
const rice = makeRecipe('b'.repeat(64), '大米');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {resolve, promise}; };

function setup(name, social = {}) {
  let definition, owner = OWNER, filterEnabled = false;
  const state = {nickname: '宝宝', allergies: ['鸡蛋'], recipes: clone([egg, rice]), logs: []};
  const listeners = new Set(), errors = [], routes = [];
  const store = {getAllergyFilterEnabled: () => filterEnabled, setAllergyFilterEnabled(value) {filterEnabled = value;}, getState: () => state, getWarning: () => '', getSyncInfo: () => ({owner}),
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}};
  const wx = {showShareMenu() {}, hideShareMenu() {}, stopPullDownRefresh() {},
    navigateTo(value) {routes.push(value.url);}, showToast() {}};
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/profile/account.js'), 'utf8'), {module: accountModule, wx, require() {return store;}});
  const api = {getDiscover: async () => ({recipes: clone([egg, rice]), nextCursor: null}),
    getFeed: async () => ({recipes: clone([egg, rice]), nextCursor: null}),
    getRecipe: async () => ({recipe: clone(egg), author}), findImportedRecipe: () => null,
    getProfileSummary: async () => ({isSelf: false, following: false, followedBy: false}), ...social};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages', name, 'index.js'), 'utf8'), {
    Page(value) {definition = value;}, wx, getApp: () => ({globalData: {pantry: ['鸡蛋', '大米']}}),
    require(dep) {
      if (dep.endsWith('/native-share-return')) return require('../utils/native-share-return');
      if (dep.endsWith('/store')) return store;
      if (dep.endsWith('/selectors')) return selectors;
      if (dep.endsWith('/allergies')) return allergies;
      if (dep.endsWith('/social')) return api;
      if (dep.endsWith('/account')) return accountModule.exports;
      if (dep.endsWith('/cloud')) return {socialEnabled: true};
      if (dep.endsWith('/profile-avatar')) return require('../utils/profile-avatar');
      if (dep.endsWith('/baby-age')) return require('../utils/baby-age');
      if (dep.endsWith('/recipe-ages')) return require('../utils/recipe-ages');
      if (dep.endsWith('/tab-bar')) return {syncTabBar() {}};
      if (dep.endsWith('/ui')) return {error(error) {errors.push(error.message);}, back() {}};
      throw Error(dep);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(changes) {Object.assign(this.data, clone(changes));}};
  if (page.onLoad) page.onLoad({id: egg.id});
  return {page, store, state, errors, routes, changeOwner() {owner = OTHER; listeners.forEach(fn => fn());}};
}

test('home skips an allergic recent meal and still offers other saved recipes', () => {
  const h = setup('home');
  h.store.setAllergyFilterEnabled(true);
  h.state.logs = [{id: 'meal', recipeId: egg.id, date: selectors.today(), rating: 3, createdAt: 1}];
  h.page.refresh();
  assert.deepEqual(h.page.data.recommendations.map(item => item.id), [rice.id]);
  assert.equal(h.page.data.recommendationTitle, '今日推荐');
  assert.equal(h.page.data.hasAllergies, true);
  assert.equal(h.state.recipes.length, 2);
  assert.equal(h.state.logs.length, 1);
});

test('returning to a recent feed applies changed allergies without another remote read', async () => {
  for (const name of ['discover', 'following']) {
    let reads = 0;
    const read = async () => { reads++; return {recipes: clone([egg, rice]), nextCursor: null}; };
    const h = setup(name, {getReadVersion: () => 1, getDiscover: read, getFeed: read});
  h.store.setAllergyFilterEnabled(true);
    await h.page.onShow(); assert.deepEqual(h.page.data.recipes.map(item => item.id), [rice.id]);
    h.state.allergies = [];
    await h.page.onShow();
    assert.equal(reads, 1); assert.equal(h.page.data.recipes.length, 2);
    assert.equal(h.page.data.hasAllergies, false);
  }
});

test('random refresh removes a newly excluded result and resetting preferences keeps allergy filtering', () => {
  const h = setup('random');
  h.store.setAllergyFilterEnabled(true);
  h.page.refresh();
  assert.equal(h.page.data.result.id, rice.id);
  h.state.allergies = ['鸡蛋', '大米'];
  h.page.refresh();
  assert.equal(h.page.data.result, null);
  assert.equal(h.page.data.candidateCount, 0);
  h.page.resetFilters();
  assert.equal(h.page.data.result, null);
  assert.equal(h.page.data.hasAllergies, true);
});

for (const name of ['ingredients', 'ingredient-results']) test(name + ' excludes allergic pantry matches and restores them when the record changes', () => {
  const h = setup(name);
  h.store.setAllergyFilterEnabled(true);
  h.page.refresh();
  assert.deepEqual(h.page.data.matches.map(item => item.id), [rice.id]);
  assert.equal(h.page.data.hasAllergies, true);
  h.state.allergies = [];
  h.page.refresh();
  assert.equal(h.page.data.matches.length, 2);
});

for (const name of ['discover', 'following']) test(name + ' keeps cursors and original pages while filtering locally without disclosing allergy records', async () => {
  const requests = [];
  const read = async input => {
    requests.push(clone(input === undefined ? null : input));
    const cursor = typeof input === 'object' && input ? input.cursor : input;
    return cursor ? {recipes: clone([egg, rice]), nextCursor: null} : {recipes: [clone(egg)], nextCursor: 'next-page'};
  };
  const h = setup(name, {getDiscover: read, getFeed: read});
  h.store.setAllergyFilterEnabled(true);
  await h.page.load();
  assert.equal(h.page.data.recipes.length, 0);
  assert.equal(h.page.data.nextCursor, 'next-page');
  assert.equal(h.page.data.skippedAllergyCount, 1);
  await h.page.loadMore();
  assert.deepEqual(h.page.data.recipes.map(item => item.id), [rice.id]);
  assert.equal(h.page.data.nextCursor, null);
  h.state.allergies = [];
  h.page.refreshAllergies();
  assert.equal(h.page.data.recipes.length, 2);
  assert.equal(new Set(h.page.data.recipes.map(item => item.id)).size, 2);
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(requests), /allerg|鸡蛋/);
  assert.doesNotMatch(JSON.stringify(h.page.onShareAppMessage()), /allerg|鸡蛋/);
  h.changeOwner();
  h.page.refreshAllergies();
  assert.equal(h.page.data.recipes.length, 0);
  assert.equal(h.page._allRecipes.length, 0);
});

test('a pending discovery response uses the latest private allergy record', async () => {
  const pending = deferred();
  const h = setup('discover', {getDiscover: () => pending.promise});
  h.store.setAllergyFilterEnabled(true);
  h.state.allergies = [];
  const loading = h.page.load();
  h.state.allergies = ['鸡蛋'];
  pending.resolve({recipes: [clone(egg)], nextCursor: null});
  await loading;
  assert.equal(h.page.data.recipes.length, 0);
});

test('a direct public recipe remains readable with a private allergy warning that never enters sharing', async () => {
  const h = setup('public-recipe');
  h.store.setAllergyFilterEnabled(true);
  await h.page.load();
  assert.equal(h.page.data.recipe.id, egg.id);
  assert.match(h.page.data.allergyWarning, /鸡蛋/);
  assert.equal(h.page.data.authorKnown, true);
  const share = h.page.onShareAppMessage();
  assert.equal(share.path, '/pages/public-recipe/index?id=' + egg.id);
  assert.equal(share.imageUrl, '/assets/cute/pocket-mascot.png');
  assert.doesNotMatch(JSON.stringify(share), /过敏|allerg/);
  h.state.allergies = [];
  h.page.refreshAllergies();
  assert.equal(h.page.data.allergyWarning, '');
});

test('private store updates refresh the active public filter without reloading the feed', () => {
  let app, listener, refreshed = 0;
  const page = {route: 'pages/discover/index', refreshAllergies() {refreshed++;}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
    App(value) {app = value;}, getCurrentPages: () => [page],
    require(dep) {
      if (dep.endsWith('/store')) return {init() {}, getSyncInfo: () => ({owner: ''}), subscribe(fn) {listener = fn;}};
      if (dep.endsWith('/cloud-sync')) return {start() {}};
      if (dep.endsWith('/cover-loader')) return {subscribe() {return () => {};}};
      if (dep.endsWith('/tdesign-font')) return {};
      if (dep.endsWith('/recipe-covers')) return {};
      if (dep.endsWith('/family-photos')) return {subscribe: () => () => {}};
      throw Error(dep);
    }
  });
  app.prepareIcons = () => {}; app.prepareCovers = () => {};
  app.onLaunch();
  listener();
  assert.equal(refreshed, 1);
});


for (const name of ['home', 'random', 'ingredients', 'ingredient-results', 'discover', 'following']) test(name + ' keeps recorded allergens visible until the user opts in and restores them when disabled', async () => {
  const h = setup(name), refresh = async () => {
    if (name === 'discover' || name === 'following') { if (!h.page._allRecipes.length) await h.page.load(); else h.page.refreshAllergies(); }
    else h.page.refresh();
  };
  const count = () => name === 'home' ? h.page.data.recommendations.length : name === 'random' ? h.page.data.candidateCount :
    name === 'ingredients' || name === 'ingredient-results' ? h.page.data.matches.length : h.page.data.recipes.length;
  await refresh(); assert.equal(count(), 2); assert.equal(h.page.data.hasAllergies, false);
  h.store.setAllergyFilterEnabled(true); await refresh(); assert.equal(count(), 1); assert.equal(h.page.data.hasAllergies, true);
  h.store.setAllergyFilterEnabled(false); await refresh(); assert.equal(count(), 2); assert.equal(h.page.data.hasAllergies, false);
  assert.deepEqual(h.state.allergies, ['鸡蛋']); assert.deepEqual(h.errors, []);
});
