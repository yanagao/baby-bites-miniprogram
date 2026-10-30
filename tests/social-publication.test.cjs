'use strict';

const test = require('node:test');
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
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }

function setup(options = {}) {
  const original = {id: 'one', name: '南瓜小米粥', category: '粥饭主食', minutes: 20, texture: '软烂颗粒',
    ingredients: [{name: '南瓜', amount: '50 克'}], steps: ['煮熟。'], note: '私密心得', photo: '', imageKey: '',
    favorite: false, isExample: false, createdAt: 1, updatedAt: 1};
  const storage = new Map([['baby-bites-v1', {version: 1, nickname: '宝宝私密称呼', profileUpdatedAt: 1,
    recipes: [original], logs: [{id: 'meal', recipeId: 'one', rating: 2, date: '2020-01-01', portion: '', note: '', createdAt: 1}]}]]);
  const hooks = {};
  const calls = {mine: 0, publish: 0, unpublish: 0, deletes: 0, backs: 0, navigation: [], navigationOptions: [], errors: [], toasts: [], updates: 0};
  let published = Boolean(options.published);
  const wx = {
    getStorageSync(key) { return copy(storage.get(key)); },
    setStorageSync(key, value) { if (hooks.storage) hooks.storage(); storage.set(key, copy(value)); },
    getStorageInfoSync() { return {keys: [...storage.keys()]}; },
    navigateTo(args) { calls.navigation.push(args.url); calls.navigationOptions.push(args); },
    showToast(args) { calls.toasts.push(args.title); },
    previewImage() { calls.navigation.push('preview'); }
  };
  const storeModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/store.js'), 'utf8'), {module: storeModule, require: requireStore, wx});
  const store = storeModule.exports;
  if (!options.unbound) store.bindAccount(OWNER);
  const actualDelete = store.deleteRecipe;
  store.deleteRecipe = id => { calls.deletes += 1; if (hooks.deleting) hooks.deleting(); return actualDelete(id); };
  const social = {
    async getMine() {
      calls.mine += 1;
      if (hooks.mine) { const response = await hooks.mine(); if (response) return response; }
      return {profile: {exists: options.profileExists !== false}, published: published ?
        [{id: PUBLIC_ID, sourceRecipeId: 'one', sourceUpdatedAt: store.getRecipe('one') && store.getRecipe('one').updatedAt}] : []};
    },
    async publishRecipe(id) { calls.publish += 1; if (hooks.publish) await hooks.publish(id); published = true; return {}; },
    async unpublishRecipe(id) { calls.unpublish += 1; if (hooks.unpublish) await hooks.unpublish(id); published = false; return {ok: true}; }
  };
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/detail/index.js'), 'utf8'), {
    wx, Page(value) { definition = value; },
    require(name) {
      if (name === '../../utils/store') return store;
      if (name === '../../utils/social') return social;
      if (name === '../../config/cloud') return {socialEnabled: options.enabled !== false};
      if (name === '../../utils/selectors') return selectors;
      if (name === '../../utils/ui') return {error(error) { calls.errors.push(error.message); }, back() { calls.backs += 1; }};
      throw Error(name);
    }
  });
  const page = Object.assign({}, definition, {data: copy(definition.data), setData(changes) { calls.updates += 1; Object.assign(this.data, copy(changes)); }});
  page.onLoad({id: 'one'});
  store.subscribe(() => { if (!page._unloaded) page.refresh(); });
  return {store, page, hooks, calls, isPublished: () => published,
    async open() { page.onShow(); await turn(); return page; }};
}

test('publications are loaded on show, while store refreshes do not make HTTP loops', async () => {
  const app = setup({published: true});
  const page = await app.open();
  assert.equal(page.data.publicReady, true);
  assert.equal(page.data.publicInfo.id, PUBLIC_ID);
  const count = app.calls.mine;
  app.store.toggleFavorite('one');
  page.refresh();
  await turn();
  assert.equal(app.calls.mine, count);
  assert.equal(page.data.publicChanged, true);
  page.onShow();
  await turn();
  assert.equal(app.calls.mine, count + 1);
});

test('before social setup is enabled, private deletion stays local and makes no social requests', async () => {
  const app = setup({enabled: false});
  const page = await app.open();
  assert.equal(app.calls.mine, 0);
  page.requestPublish();
  await page.confirmPublish();
  await page.unpublish();
  assert.equal(app.calls.publish, 0);
  assert.equal(app.calls.unpublish, 0);
  page.remove();
  assert.doesNotMatch(page.data.deleteContent, /公开/);
  await page.confirmDelete();
  assert.equal(app.calls.unpublish, 0);
  assert.equal(app.store.getRecipe('one'), null);
  assert.equal(app.calls.backs, 1);
});

test('publication requires confirmation, and cancel does not change private or public data', async () => {
  const app = setup();
  const page = await app.open();
  const original = app.store.getState();
  await page.confirmPublish();
  page.requestPublish();
  assert.equal(page.data.publishVisible, true);
  page.cancelPublish();
  await page.confirmPublish();
  assert.equal(app.calls.publish, 0);
  assert.equal(app.isPublished(), false);
  assert.deepEqual(copy(app.store.getState()), copy(original));
});

test('a missing public profile opens setup without publishing', async () => {
  const app = setup({profileExists: false});
  const page = await app.open();
  page.requestPublish();
  assert.equal(app.calls.publish, 0);
  assert.equal(page.data.publishVisible, false);
  assert.deepEqual(app.calls.navigation, ['/pages/profile/index?edit=1&returnToRecipe=1']);
});

test('failed publication preserves private recipe and previous public status, then supports retry', async () => {
  const app = setup();
  const page = await app.open();
  const original = app.store.getState();
  app.hooks.publish = () => { throw Error('等待联网后重试'); };
  page.requestPublish();
  await page.confirmPublish();
  assert.equal(page.data.publicBusy, false);
  assert.equal(page.data.publishVisible, false);
  assert.match(page.data.publicError, /联网/);
  assert.equal(app.isPublished(), false);
  assert.equal(page.data.publicInfo, null);
  assert.deepEqual(copy(app.store.getState()), copy(original));
  delete app.hooks.publish;
  page.requestPublish();
  await page.confirmPublish();
  assert.equal(app.isPublished(), true);
  assert.equal(page.data.publicInfo.id, PUBLIC_ID);
  assert.deepEqual(app.calls.toasts, ['菜谱已公开']);
});

test('publication locks competing delete, favorite and navigation actions until completion', async () => {
  const app = setup();
  const page = await app.open();
  const gate = deferred();
  app.hooks.publish = () => gate.promise;
  page.requestPublish();
  const work = page.confirmPublish();
  await page.confirmPublish();
  page.remove(); page.favorite(); page.edit(); page.record(); page.openProfile(); page.back();
  assert.equal(app.calls.publish, 1);
  assert.equal(page.data.deleteVisible, false);
  assert.equal(app.store.getRecipe('one').favorite, false);
  assert.equal(app.calls.navigation.length, 0);
  assert.equal(app.calls.backs, 0);
  gate.resolve();
  await work;
  assert.equal(page.data.publicBusy, false);
});

test('failed withdrawal keeps the public status and the private recipe unchanged', async () => {
  const app = setup({published: true});
  const page = await app.open();
  const original = app.store.getState();
  app.hooks.unpublish = () => { throw Error('连接失败'); };
  await page.unpublish();
  assert.equal(app.isPublished(), true);
  assert.equal(page.data.publicInfo.id, PUBLIC_ID);
  assert.equal(page.data.publicBusy, false);
  assert.deepEqual(copy(app.store.getState()), copy(original));
  assert.equal(app.calls.toasts.length, 0);
});

test('deletion waits for a successful withdrawal and never deletes on network or identity failure', async () => {
  const app = setup({published: true});
  const page = await app.open();
  const original = app.store.getState();
  app.hooks.unpublish = () => { throw Error('未能确认当前微信账号'); };
  page.remove();
  await page.confirmDelete();
  assert.equal(app.calls.deletes, 0);
  assert.equal(app.isPublished(), true);
  assert.equal(page.data.publicInfo.id, PUBLIC_ID);
  assert.deepEqual(copy(app.store.getState()), copy(original));
  delete app.hooks.unpublish;
  const gate = deferred();
  app.hooks.unpublish = () => gate.promise;
  page.remove();
  const deleting = page.confirmDelete();
  await page.confirmDelete();
  page.requestPublish(); await page.unpublish(); page.favorite();
  assert.equal(app.calls.deletes, 0);
  assert.equal(page.data.publishVisible, false);
  assert.equal(app.store.getRecipe('one').favorite, false);
  gate.resolve();
  await deleting;
  assert.equal(app.calls.deletes, 1);
  assert.equal(app.isPublished(), false);
  assert.equal(app.store.getRecipe('one'), null);
  assert.equal(app.store.getState().logs.length, 0);
  assert.equal(app.calls.backs, 1);
});

test('successful withdrawal followed by failed local deletion keeps the recipe and shows it private', async () => {
  const app = setup({published: true});
  const page = await app.open();
  const original = app.store.getState();
  app.hooks.deleting = () => { app.hooks.storage = () => { throw Error('Storage full'); }; };
  page.remove();
  await page.confirmDelete();
  assert.equal(app.isPublished(), false);
  assert.equal(page.data.publicInfo, null);
  assert.equal(page.data.deleting, false);
  assert.deepEqual(copy(app.store.getState()), copy(original));
  assert.equal(app.calls.backs, 0);
  assert.match(app.calls.errors[0], /保存失败/);
});

test('switching accounts permanently locks a stale detail page, including A to B to A', async () => {
  const app = setup({published: true});
  const page = await app.open();
  page.requestPublish();
  app.store.bindAccount(OTHER);
  app.store.bindAccount(OWNER);
  page.onShow();
  await page.confirmPublish();
  await page.unpublish();
  page.remove(); await page.confirmDelete(); page.favorite(); page.edit(); page.record(); page.openPublicRecipe();
  assert.equal(page.data.recipe, null);
  assert.equal(page.data.lastLog, null);
  assert.equal(page.data.publicInfo, null);
  assert.equal(app.calls.publish, 0);
  assert.equal(app.calls.unpublish, 0);
  assert.equal(app.calls.deletes, 0);
  assert.equal(app.calls.navigation.length, 0);
  assert.equal(app.store.getRecipe('one').favorite, false);
  assert.ok(app.calls.errors.every(message => /账号已切换/.test(message)));
  page.back();
  assert.equal(app.calls.backs, 1);
});

test('the initial null-to-first-account binding is allowed and does not discard the page', async () => {
  const app = setup({unbound: true});
  app.hooks.mine = () => { app.store.bindAccount(OWNER); };
  const page = await app.open();
  assert.equal(page.data.recipe.id, 'one');
  assert.equal(page.data.publicReady, true);
  assert.equal(page._accountLocked, false);
  page.requestPublish();
  await page.confirmPublish();
  assert.equal(app.calls.publish, 1);
});

test('switching accounts while withdrawal for deletion is pending never deletes from either account', async () => {
  const app = setup({published: true});
  const page = await app.open();
  const gate = deferred();
  app.hooks.unpublish = () => gate.promise;
  page.remove();
  const work = page.confirmDelete();
  app.store.bindAccount(OTHER);
  app.store.bindAccount(OWNER);
  gate.resolve();
  await work;
  assert.equal(app.calls.deletes, 0);
  assert.ok(app.store.getRecipe('one'));
  assert.equal(page.data.recipe, null);
  assert.equal(app.calls.backs, 0);
});

test('unloading during publish, withdrawal or deletion suppresses late UI changes and private deletion', async () => {
  for (const action of ['publish', 'unpublish', 'delete']) {
    const app = setup({published: action !== 'publish'});
    const page = await app.open();
    const gate = deferred();
    app.hooks[action === 'publish' ? 'publish' : 'unpublish'] = () => gate.promise;
    let work;
    if (action === 'publish') { page.requestPublish(); work = page.confirmPublish(); }
    else if (action === 'unpublish') work = page.unpublish();
    else { page.remove(); work = page.confirmDelete(); }
    page.onUnload();
    const count = app.calls.updates;
    gate.resolve();
    await work;
    assert.equal(app.calls.updates, count);
    assert.equal(app.calls.deletes, 0);
    assert.equal(app.calls.toasts.length, 0);
    assert.equal(app.calls.backs, 0);
    assert.ok(app.store.getRecipe('one'));
  }
});

test('a stale publication load cannot overwrite a newer result or update an unloaded page', async () => {
  const app = setup();
  const page = await app.open();
  const gate = deferred();
  app.hooks.mine = () => gate.promise;
  const old = page.refreshPublication();
  delete app.hooks.mine;
  await page.refreshPublication();
  gate.resolve({profile: {exists: true}, published: [{id: PUBLIC_ID, sourceRecipeId: 'one', sourceUpdatedAt: 1}]});
  await old;
  assert.equal(page.data.publicInfo, null);
  const count = app.calls.mine;
  page.onUnload();
  await page.refreshPublication();
  assert.equal(app.calls.mine, count);
});

test('the publish entry reads unknown status on demand and still requires explicit confirmation', async () => {
  const app = setup(); app.page.refresh();
  await app.page.requestPublish();
  assert.equal(app.page.data.publicReady, true); assert.equal(app.page.data.publishVisible, true);
  assert.equal(app.calls.publish, 0);
});

test('saving a nickname returns to a fresh confirmation; cancel and duplicate taps never publish', async () => {
  const options = {profileExists: false}; const app = setup(options); const page = await app.open();
  page.requestPublish(); page.requestPublish(); assert.equal(app.calls.navigation.length, 1);
  options.profileExists = true; app.calls.navigationOptions[0].events.profileSaved();
  await page.onShow(); assert.equal(page.data.publishVisible, true); assert.equal(app.calls.publish, 0);
  page.cancelPublish(); await page.onShow(); assert.equal(page.data.publishVisible, false);
  await page.confirmPublish(); assert.equal(app.calls.publish, 0);
  page.requestPublish(); await page.confirmPublish(); assert.equal(app.calls.publish, 1);
});

test('leaving nickname setup without saving does not resume publishing even if profile state changed elsewhere', async () => {
  const options = {profileExists: false}; const app = setup(options); const page = await app.open();
  page.requestPublish(); options.profileExists = true;
  await page.onShow(); assert.equal(page.data.publishVisible, false); assert.equal(app.calls.publish, 0);
  app.calls.navigationOptions[0].events.profileSaved();
  await page.onShow(); assert.equal(page.data.publishVisible, false, 'a late callback from the abandoned editor is ignored');
});

test('setup navigation failure clears its lock and allows retrying the visible publish entry', async () => {
  const app = setup({profileExists:false}); const page = await app.open(); page.requestPublish();
  app.calls.navigationOptions[0].fail(); page.requestPublish();
  assert.equal(app.calls.navigation.length, 2); assert.equal(page.data.publishVisible, false); assert.equal(app.calls.publish, 0);
});

test('returning from setup offline retains a retryable state and cannot assume privacy or publish', async () => {
  const options={profileExists:false}; const app=setup(options); const page=await app.open(); page.requestPublish();
  options.profileExists=true; app.calls.navigationOptions[0].events.profileSaved();
  app.hooks.mine=()=>{throw Error('暂时离线');}; await page.onShow();
  assert.equal(page.data.publicReady,false); assert.equal(page.data.publicLoading,false); assert.equal(page.data.publishVisible,false);
  assert.match(page.data.publicError,/离线/); assert.equal(app.calls.publish,0);
  delete app.hooks.mine; await page.requestPublish(); assert.equal(page.data.publishVisible,true); assert.equal(app.calls.publish,0);
});

test('a removed recipe, account change or unload cannot resume publishing from an old editor', async () => {
  for (const mode of ['deleted','account','unloaded']) {
    const options={profileExists:false}; const app=setup(options); const page=await app.open(); page.requestPublish();
    if(mode==='deleted') app.store.deleteRecipe('one');
    if(mode==='account') app.store.bindAccount(OTHER);
    if(mode==='unloaded') page.onUnload();
    options.profileExists=true; app.calls.navigationOptions[0].events.profileSaved(); await page.onShow();
    assert.equal(page.data.publishVisible,false,mode); assert.equal(app.calls.publish,0,mode);
  }
});

test('invalid visibility responses stay unknown and a backend identity mismatch clears pending publication', async () => {
  const app=setup(); const page=await app.open();
  app.hooks.mine=()=>({profile:{exists:true},published:null}); await page.refreshPublication();
  assert.equal(page.data.publicReady,false); assert.equal(page.data.publicLoading,false); assert.match(page.data.publicError,/确认公开状态/);
  app.hooks.mine=()=>{throw Object.assign(Error('old owner'),{code:'ACCOUNT_CHANGED'});}; await page.refreshPublication();
  assert.equal(page.data.recipe,null); assert.equal(page.data.publicInfo,null); assert.equal(page._accountLocked,true);
  page.requestPublish(); assert.equal(app.calls.publish,0);
});
