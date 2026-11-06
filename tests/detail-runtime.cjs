'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '..');
const requireStore = createRequire(path.join(root, 'utils/store.js'));
const selectors = require('../utils/selectors');
const OWNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const PUBLIC_ID = 'c'.repeat(64);
const AUTHOR_ID = 'd'.repeat(32);
const LOCAL_ID = 'private-recipe-one';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
function pending() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}

function setup(options = {}) {
  const localRecipe = {id: LOCAL_ID, name: '尚未公开的南瓜粥改名', category: '粥饭主食', minutes: 20,
    texture: '软烂颗粒', ingredients: [{name: '南瓜', amount: '50 克'}], steps: ['煮熟。'],
    note: '只给自己看的心得', photo: '', imageKey: '', favorite: false, isExample: false,
    createdAt: 1, updatedAt: 2, ...(options.recipe || {})};
  const sourceID = localRecipe.id;
  const storage = new Map([['baby-bites-v1', {version: 1, nickname: '宝宝私密称呼', profileUpdatedAt: 1,
    recipes: [localRecipe], logs: [{id: 'private-meal', recipeId: sourceID, rating: 2,
      date: '2020-01-01', portion: '', note: '私密用餐记录', createdAt: 1}]}]]);
  const hooks = {};
  let readVersion = 0;
  const syncListeners = new Set();
  const appHideListeners = new Set();
  const calls = {shareLinks: [], mine: 0, recipe: [], publish: [], unpublish: [], navigation: [], toasts: [], errors: [],
    shareMenu: [], updates: 0, backs: 0, sync: 0};
  let published = Boolean(options.published);
  let sourceUpdatedAt = 1;
  let publicRecipe = {id: PUBLIC_ID, profileId: AUTHOR_ID, name: '已公开的南瓜小米粥',
    photoURL: 'https://example.com/public.jpg', ingredients: [{name: '南瓜', amount: '30 克'}],
    steps: ['煮软。']};
  const wx = {
    onAppHide(listener) { appHideListeners.add(listener); },
    offAppHide(listener) { appHideListeners.delete(listener); },
    getStorageSync(key) { return clone(storage.get(key)); },
    setStorageSync(key, value) { if (hooks.storage) hooks.storage(); storage.set(key, clone(value)); },
    getStorageInfoSync() { return {keys: [...storage.keys()]}; },
    navigateTo(args) { calls.navigation.push(args); },
    showToast(args) { calls.toasts.push(args.title); },
    showShareMenu(args) { calls.shareMenu.push({show: true, ...clone(args)}); },
    hideShareMenu(args) { calls.shareMenu.push({show: false, ...clone(args)}); },
    previewImage() {}
  };
  const storeModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/store.js'), 'utf8'), {
    module: storeModule, require: requireStore, wx
  });
  const store = storeModule.exports;
  if (!options.unbound) store.bindAccount(OWNER);
  const social = {
    getReadVersion: () => readVersion,
    async getRecipeShareLink(id, options) {
      calls.shareLinks.push({id, ...options});
      const localVersion = JSON.stringify(store.getRecipe(id));
      if (hooks.link) return hooks.link(id, options, localVersion);
      const source = store.getRecipe(id).source;
      const result = hooks.recipe ? await hooks.recipe(source ? source.recipeId : PUBLIC_ID) :
        {recipe: {...clone(publicRecipe), id: source ? source.recipeId : PUBLIC_ID}};
      published = true;
      return {...result, localVersion};
    },
    async getMine() {
      calls.mine++;
      if (hooks.mine) return hooks.mine();
      return {profile: {exists: options.profileExists !== false}, published: published ?
        [{id: PUBLIC_ID, sourceRecipeId: sourceID, sourceUpdatedAt}] : []};
    },
    async getRecipe(id) {
      calls.recipe.push(id);
      if (hooks.recipe) return hooks.recipe(id);
      if (!published) throw Error('这道菜谱已取消公开');
      return {recipe: clone(publicRecipe), author: {id: AUTHOR_ID, name: '公开昵称'}};
    },
    async publishRecipe(id) {
      calls.publish.push(id);
      const submittedName = store.getRecipe(id).name;
      if (hooks.publish) await hooks.publish(id);
      published = true;
      publicRecipe = {...publicRecipe, name: submittedName};
      sourceUpdatedAt = store.getRecipe(id).updatedAt;
      return {recipe: clone(publicRecipe)};
    },
    async unpublishRecipe(id) {
      calls.unpublish.push(id);
      if (hooks.unpublish) await hooks.unpublish(id);
      published = false;
      return {ok: true};
    }
  };
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/detail/index.js'), 'utf8'), {
    wx, Page(value) { definition = value; },
    require(name) {
      if (name.endsWith('/store')) return store;
      if (name.endsWith('/social')) return social;
      if (name.endsWith('/native-share-return')) return require('../utils/native-share-return');
      if (name.endsWith('/cloud-sync')) return {async syncNow() { calls.sync++; const result = hooks.sync ? await hooks.sync() : {state: 'synced'}; if (result.state === 'synced') published = false; return result; }, getStatus: () => ({owner: OWNER, revision: 0, publicationVersion: 0}), subscribe(listener) {
        syncListeners.add(listener); return () => syncListeners.delete(listener);
      }};
      if (name.endsWith('/selectors')) return selectors;
      if (name.endsWith('/recipe-origin')) return require('../utils/recipe-origin');
      if (name.endsWith('/recipe-covers')) return {getCover: recipe => options.cover ? options.cover(recipe) : ''};
      if (name.endsWith('/cloud')) return {socialEnabled: options.enabled !== false};
      if (name.endsWith('/ui')) return {error(error) { calls.errors.push(error.message); }, back() { calls.backs++; }};
      throw Error(name);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(update) {
    calls.updates++; Object.assign(this.data, clone(update));
  }};
  page.onLoad({id: sourceID});
  return {page, store, calls, hooks, options, syncListeners, sourceID, isPublished: () => published,
    appHideListeners, hideApp(reason) { appHideListeners.forEach(listener => listener({reason})); },
    invalidateReads() { readVersion++; },
    emitSync(status) { syncListeners.forEach(listener => listener({state: 'synced', owner: OWNER, lastSyncedAt: 10, revision: 1, publicationVersion: 1, ...status})); },
    updatePublicSnapshot(name) { publicRecipe = {...publicRecipe, name}; sourceUpdatedAt = store.getRecipe(sourceID).updatedAt; },
    async open() { await page.onShow(); await turn(); return page; }};
}

function assertUnshareable(page) {
  const share = page.onShareAppMessage();
  assert.equal(share.path, '/pages/home/index');
  assert.doesNotMatch(JSON.stringify(share), /尚未公开|只给自己|宝宝私密|私密用餐|private-recipe-one|private-meal/);
}


module.exports = {setup, pending, turn, assertUnshareable, clone, OWNER, OTHER, PUBLIC_ID, AUTHOR_ID, LOCAL_ID};
