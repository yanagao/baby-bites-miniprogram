'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const selectors = require('../utils/selectors');
const seeds = require('../data/recipes');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const event = value => ({detail: {value}});
const pending = () => { let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject}; };
function cookbook(options = {}) {
  let owner = options.owner === undefined ? 'owner-a' : options.owner;
  const state = {recipes: seeds.slice(0, 3).map((recipe, index) => ({...recipe, updatedAt: index + 1,
    createdAt: index + 1, favorite: index === 0})), logs: []};
  const listeners = new Set();
  const hooks = {};
  const calls = {mine: 0, updates: 0};
  const store = {getState: () => state, getWarning: () => '', getSyncInfo: () => ({owner}),
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);}};
  const social = {async getMine() {calls.mine++; return hooks.mine ? hooks.mine() : {published: [
    {id: 'public-one', sourceRecipeId: state.recipes[0].id, sourceUpdatedAt: state.recipes[0].updatedAt}
  ]};}};
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/recipes/index.js'), 'utf8'), {
    Page(value) {definition = value;}, wx: {navigateTo() {}},
    require(name) {
      if (name.endsWith('/store')) return store;
      if (name.endsWith('/social')) return social;
      if (name.endsWith('/selectors')) return selectors;
      if (name.endsWith('/cloud')) return {socialEnabled: true};
      if (name.endsWith('/tab-bar')) return {syncTabBar() {}};
      if (name.endsWith('/ui')) return {error(error) {throw error;}};
      throw Error(name);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(update) {calls.updates++; Object.assign(this.data, clone(update));}};
  page.onLoad(options.query || {}); page.refresh();
  return {page, state, hooks, calls, listeners, changeOwner(value) {owner = value; listeners.forEach(listener => listener());}};
}

test('cookbook entry queries preselect favorites or visibility and preserve a literal search', async () => {
  const favorite = cookbook({query: {collection: 'favorites', search: '南瓜'}});
  assert.equal(favorite.page.data.collection, 'favorites');
  assert.equal(favorite.page.data.onlyFavorites, true);
  assert.equal(favorite.page.data.search, '南瓜');
  const published = cookbook({query: {collection: 'public'}});
  assert.equal(published.page.data.visibility, 'public');
  assert.equal(published.page.data.recipes.length, 0, 'unknown visibility must not be guessed');
  await published.page.refreshPublication();
  assert.equal(published.page.data.recipes.length, 1);
  const invalid = cookbook({query: {collection: 'unknown'}});
  assert.equal(invalid.page.data.collection, 'all');
});

test('publication visibility is unknown until confirmed and never inferred private from a failed request', async () => {
  const app = cookbook();
  assert.ok(app.page.data.recipes.every(recipe => recipe.visibility === 'unknown'));
  app.hooks.mine = async () => {throw Error('网络暂时不可用');};
  await app.page.refreshPublication();
  assert.equal(app.page.data.publicationReady, false);
  assert.ok(app.page.data.recipes.every(recipe => recipe.visibility === 'unknown'));
  app.page.changeCollection(event('private'));
  assert.equal(app.page.data.recipes.length, 0);
  assert.match(app.page.data.publicationError, /网络/);
});

test('all, private, public and favorite views compose with filters without changing stored data', async () => {
  const app = cookbook();
  const before = clone(app.state);
  await app.page.refreshPublication();
  assert.equal(app.page.data.publicCount, 1);
  assert.equal(app.page.data.privateCount, 2);
  app.page.changeCollection(event('public'));
  assert.deepEqual(app.page.data.recipes.map(recipe => recipe.id), [app.state.recipes[0].id]);
  app.page.searchInput(event('不会匹配的搜索'));
  assert.equal(app.page.data.recipes.length, 0);
  app.page.searchInput(event(''));
  app.page.changeCollection(event('private'));
  assert.equal(app.page.data.recipes.length, 2);
  assert.ok(app.page.data.recipes.every(recipe => recipe.visibility === 'private'));
  app.page.changeCollection(event('favorites'));
  assert.equal(app.page.data.recipes.length, 1);
  assert.equal(app.page.data.recipes[0].visibility, 'public');
  app.page.resetFilters();
  assert.equal(app.page.data.collection, 'all');
  assert.equal(app.page.data.recipes.length, 3);
  assert.deepEqual(app.state, before);
});

test('account switches immediately drop publication metadata and reject older responses even after A to B to A', async () => {
  const app = cookbook();
  await app.page.refreshPublication();
  const late = pending();
  app.hooks.mine = () => late.promise;
  const work = app.page.refreshPublication();
  app.changeOwner('owner-b'); app.changeOwner('owner-a');
  assert.equal(app.page.data.publicCount, 0);
  assert.ok(app.page.data.recipes.every(recipe => recipe.visibility === 'unknown'));
  late.resolve({published: [{id: 'old', sourceRecipeId: app.state.recipes[0].id, sourceUpdatedAt: 1}]});
  await work;
  assert.equal(app.page.data.publicationReady, false);
  assert.match(app.page.data.publicationError, /账号已切换/);
  delete app.hooks.mine;
  await app.page.refreshPublication();
  assert.equal(app.page.data.publicationReady, true);
});

test('first identity binding succeeds, private store updates cause no repeated social calls, and unload ignores results', async () => {
  const app = cookbook({owner: ''});
  app.hooks.mine = async () => {app.changeOwner('owner-a'); return {published: []};};
  await app.page.refreshPublication();
  assert.equal(app.page.data.publicationReady, true);
  app.page.refresh();
  app.state.recipes[0].favorite = false;
  app.listeners.forEach(listener => listener());
  assert.equal(app.calls.mine, 1);
  const late = pending(); app.hooks.mine = () => late.promise;
  const work = app.page.refreshPublication();
  app.page.onUnload();
  const count = app.calls.updates;
  late.resolve({published: []}); await work;
  assert.equal(app.calls.updates, count);
  assert.equal(app.listeners.size, 0);
});

function publicDetail() {
  let owner = 'owner-a';
  const listeners = new Set();
  const calls = {routes: [], share: []};
  const store = {getSyncInfo: () => ({owner}), subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}};
  const wx = {navigateTo(options) {calls.routes.push(options.url);},
    showShareMenu() {calls.share.push('show');}, hideShareMenu() {calls.share.push('hide');}};
  const account = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/profile/account.js'), 'utf8'), {module: account, require: () => store, wx});
  const recipe = {id: 'a'.repeat(64), name: '南瓜小米粥', photoURL: '', source: {profileId: 'c'.repeat(32)}};
  const author = {id: 'b'.repeat(32), name: '小厨房'};
  const social = {getRecipe: async () => ({recipe, author}), findImportedRecipe: () => ({id: 'my-private-copy'})};
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/public-recipe/index.js'), 'utf8'), {
    wx, Page(value) {definition = value;}, require(name) {
      if (name.endsWith('/account')) return account.exports;
      if (name.endsWith('/social')) return social;
      if (name.endsWith('/profile-avatar')) return require('../utils/profile-avatar');
      if (name.endsWith('/ui')) return {back() {}, error() {}};
      throw Error(name);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(update) {Object.assign(this.data, clone(update));}};
  page.onLoad({id: recipe.id});
  return {page, recipe, social, calls, changeOwner() {owner = 'owner-b'; listeners.forEach(fn => fn());}};
}

test('public recipe shares only its public ID and cannot reuse a stale share after refresh failure or account change', async () => {
  const app = publicDetail();
  await app.page.load();
  const share = app.page.onShareAppMessage();
  assert.equal(share.path, '/pages/public-recipe/index?id=' + app.recipe.id);
  assert.equal(share.imageUrl, '/assets/cute/pocket-mascot.png');
  assert.doesNotMatch(JSON.stringify(share), /my-private-copy|owner-a/);
  const gate = pending(); app.social.getRecipe = () => gate.promise;
  const work = app.page.load();
  assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
  gate.reject(Error('作者已设为私密')); await work;
  assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
  app.page.setData({recipe: app.recipe, author: {id: 'b'.repeat(32)}});
  app.changeOwner();
  app.page.openAuthor(); app.page.openSource();
  assert.deepEqual(app.calls.routes, []);
  assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
});
