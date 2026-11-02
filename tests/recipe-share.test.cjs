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
  const storage = new Map([['baby-bites-v1', {version: 1, nickname: '宝宝私密称呼', profileUpdatedAt: 1,
    recipes: [localRecipe], logs: [{id: 'private-meal', recipeId: LOCAL_ID, rating: 2,
      date: '2020-01-01', portion: '', note: '私密用餐记录', createdAt: 1}]}]]);
  const hooks = {};
  const syncListeners = new Set();
  const calls = {mine: 0, recipe: [], publish: [], unpublish: [], navigation: [], toasts: [], errors: [],
    shareMenu: [], updates: 0, backs: 0};
  let published = Boolean(options.published);
  let sourceUpdatedAt = 1;
  let publicRecipe = {id: PUBLIC_ID, profileId: AUTHOR_ID, name: '已公开的南瓜小米粥',
    photoURL: 'https://example.com/public.jpg', ingredients: [{name: '南瓜', amount: '30 克'}],
    steps: ['煮软。']};
  const wx = {
    getStorageSync(key) { return clone(storage.get(key)); },
    setStorageSync(key, value) { storage.set(key, clone(value)); },
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
    async getMine() {
      calls.mine++;
      if (hooks.mine) return hooks.mine();
      return {profile: {exists: options.profileExists !== false}, published: published ?
        [{id: PUBLIC_ID, sourceRecipeId: LOCAL_ID, sourceUpdatedAt}] : []};
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
      if (name.endsWith('/cloud-sync')) return {getStatus: () => ({owner: OWNER, revision: 0, publicationVersion: 0}), subscribe(listener) {
        syncListeners.add(listener); return () => syncListeners.delete(listener);
      }};
      if (name.endsWith('/selectors')) return selectors;
      if (name.endsWith('/cloud')) return {socialEnabled: options.enabled !== false};
      if (name.endsWith('/ui')) return {error(error) { calls.errors.push(error.message); }, back() { calls.backs++; }};
      throw Error(name);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(update) {
    calls.updates++; Object.assign(this.data, clone(update));
  }};
  page.onLoad({id: LOCAL_ID});
  return {page, store, calls, hooks, options, syncListeners, isPublished: () => published,
    emitSync(status) { syncListeners.forEach(listener => listener({state: 'synced', owner: OWNER, lastSyncedAt: 10, revision: 1, publicationVersion: 1, ...status})); },
    updatePublicSnapshot(name) { publicRecipe = {...publicRecipe, name}; sourceUpdatedAt = store.getRecipe(LOCAL_ID).updatedAt; },
    async open() { await page.onShow(); await turn(); return page; }};
}

function assertUnshareable(page) {
  const share = page.onShareAppMessage();
  assert.equal(share.path, '/pages/home/index');
  assert.doesNotMatch(JSON.stringify(share), /尚未公开|只给自己|宝宝私密|私密用餐|private-recipe-one|private-meal/);
}

test('private recipe share asks permission before publishing or opening profile setup; cancel preserves all data', async () => {
  for (const profileExists of [true, false]) {
    const app = setup({profileExists}); const page = await app.open();
    const before = clone(app.store.getState());
    await page.requestShare();
    assert.equal(page.data.publishVisible, true);
    assert.equal(page.data.shareAfterPublish, true);
    assert.equal(page.data.shareVisible, false);
    assert.equal(app.calls.navigation.length, 0);
    assert.deepEqual(app.calls.publish, []);
    assertUnshareable(page);
    page.cancelPublish(); await page.confirmPublish();
    assert.equal(page.data.shareAfterPublish, false);
    assert.equal(page.data.publishVisible, false);
    assert.equal(app.isPublished(), false);
    assert.deepEqual(app.calls.publish, []);
    assert.deepEqual(clone(app.store.getState()), before);
  }
});

test('confirming private share publishes once and offers native sending only after publication completes', async () => {
  const app = setup(); const page = await app.open();
  const gate = pending(); app.hooks.publish = () => gate.promise;
  await page.requestShare();
  const work = page.confirmPublish();
  await page.confirmPublish(); await page.requestShare();
  assert.deepEqual(app.calls.publish, [LOCAL_ID]);
  assert.equal(page.data.shareVisible, false);
  assertUnshareable(page);
  gate.resolve(); await work;
  assert.equal(page.data.publicBusy, false);
  assert.equal(page.data.shareVisible, true);
  const share = page.onShareAppMessage();
  assert.equal(share.path, '/pages/public-recipe/index?id=' + PUBLIC_ID);
  assert.equal(share.title, app.store.getRecipe(LOCAL_ID).name + ' · 口袋食谱');
  assert.equal(share.imageUrl, '/assets/cute/pocket-mascot.png');
  assert.doesNotMatch(JSON.stringify(share), /只给自己|宝宝私密|私密用餐|private-recipe-one|private-meal/);
});

test('an already public recipe shares its published snapshot without publishing local edits', async () => {
  const app = setup({published: true}); const page = await app.open();
  const before = clone(app.store.getState());
  assert.equal(page.data.publicChanged, true);
  await page.requestShare();
  const share = page.onShareAppMessage();
  assert.equal(share.title, '已公开的南瓜小米粥 · 口袋食谱');
  assert.equal(share.path, '/pages/public-recipe/index?id=' + PUBLIC_ID);
  assert.equal(share.imageUrl, '/assets/cute/pocket-mascot.png');
  assert.doesNotMatch(JSON.stringify(share), /尚未公开|只给自己|宝宝私密|private-recipe-one/);
  assert.deepEqual(app.calls.publish, []);
  assert.deepEqual(clone(app.store.getState()), before);
  assert.ok(app.calls.recipe.every(id => id === PUBLIC_ID));
});

test('completed automatic sync refreshes visibility and share metadata from the public snapshot once', async () => {
  const app = setup({published: true}); const page = await app.open();
  const mineCalls = app.calls.mine;
  for (const status of [{state: 'syncing', revision: 0, publicationVersion: 0}, {state: 'error', revision: 0, publicationVersion: 0}, {owner: OTHER}]) app.emitSync(status);
  await turn();
  assert.equal(app.calls.mine, mineCalls);
  assert.equal(page.data.publicChanged, true);
  app.updatePublicSnapshot('云端已同步的新菜名');
  app.emitSync(); await turn();
  assert.equal(app.calls.mine, mineCalls + 1);
  assert.equal(page.data.publicChanged, false);
  assert.equal(page.onShareAppMessage().title, '云端已同步的新菜名 · 口袋食谱');
  assert.notEqual(page.data.shareRecipe.name, app.store.getRecipe(LOCAL_ID).name);
  app.emitSync(); app.emitSync(); await turn();
  assert.equal(app.calls.mine, mineCalls + 1, 'duplicate completion notifications do not reload or loop');
  assert.deepEqual(app.calls.publish, []);
});

test('sync notifications during a publication read coalesce into one trailing refresh', async () => {
  const app = setup({published: true}); const page = await app.open();
  const mineCalls = app.calls.mine;
  const gate = pending();
  app.hooks.mine = () => gate.promise;
  app.emitSync();
  app.emitSync({publicationVersion: 2}); app.emitSync({publicationVersion: 3});
  assert.equal(app.calls.mine, mineCalls + 1);
  delete app.hooks.mine;
  app.updatePublicSnapshot('合并通知后的公开菜名');
  gate.resolve({profile: {exists: true}, published: [{id: PUBLIC_ID, sourceRecipeId: LOCAL_ID, sourceUpdatedAt: 1}]});
  await turn();
  assert.equal(app.calls.mine, mineCalls + 2);
  assert.equal(page.data.publicChanged, false);
  assert.equal(page.onShareAppMessage().title, '合并通知后的公开菜名 · 口袋食谱');
  app.emitSync({publicationVersion: 3}); await turn();
  assert.equal(app.calls.mine, mineCalls + 2);
});

test('identity timestamps do not refresh detail but a partial publication update does', async () => {
  const app = setup({published: true}); const page = await app.open();
  const reads = app.calls.mine;
  app.emitSync({revision: 0, publicationVersion: 0, lastSyncedAt: 20});
  app.emitSync({revision: 0, publicationVersion: 0, lastSyncedAt: 21}); await turn();
  assert.equal(app.calls.mine, reads);
  app.updatePublicSnapshot('部分同步已成功的菜名');
  app.emitSync({state: 'pending', revision: 0, publicationVersion: 1, lastSyncedAt: 21}); await turn();
  assert.equal(app.calls.mine, reads + 1);
  assert.equal(page.onShareAppMessage().title, '部分同步已成功的菜名 · 口袋食谱');
  app.emitSync({revision: 0, publicationVersion: 1, lastSyncedAt: 22}); await turn();
  assert.equal(app.calls.mine, reads + 1);
});

test('a sync notification waits for an open share panel, deletion confirmation, or hidden page', async () => {
  for (const mode of ['share', 'delete', 'hidden']) {
    const app = setup({published: true}); const page = await app.open();
    if (mode === 'share') await page.requestShare();
    if (mode === 'delete') page.remove();
    if (mode === 'hidden') page.onHide();
    const mineCalls = app.calls.mine;
    app.updatePublicSnapshot('等待页面恢复后的公开菜名'); app.emitSync(); await turn();
    assert.equal(app.calls.mine, mineCalls, mode);
    if (mode === 'share') page.closeShare();
    if (mode === 'delete') page.cancelDelete();
    if (mode === 'hidden') await page.onShow();
    await turn();
    assert.equal(app.calls.mine, mineCalls + 1, mode);
    assert.equal(page.data.publishVisible, false, mode);
    assert.equal(page.onShareAppMessage().title, '等待页面恢复后的公开菜名 · 口袋食谱', mode);
  }
});

test('canceling first publication with a pending sync never publishes or restores the confirmation', async () => {
  const app = setup(); const page = await app.open();
  await page.requestShare();
  const mineCalls = app.calls.mine;
  app.emitSync(); await turn();
  assert.equal(app.calls.mine, mineCalls);
  page.cancelPublish(); await turn(); await page.confirmPublish();
  assert.equal(app.calls.mine, mineCalls + 1);
  assert.equal(page.data.publishVisible, false);
  assert.equal(page.data.shareAfterPublish, false);
  assert.deepEqual(app.calls.publish, []);
  assertUnshareable(page);
});

test('sync listeners and in-flight automatic snapshot refreshes cannot update an unloaded or changed-account page', async () => {
  for (const mode of ['account', 'unload']) {
    const app = setup({published: true}); const page = await app.open();
    const listener = [...app.syncListeners][0];
    const gate = pending(); app.hooks.recipe = () => gate.promise;
    app.emitSync(); await turn();
    if (mode === 'account') { app.store.bindAccount(OTHER); app.store.bindAccount(OWNER); }
    else { page.onUnload(); assert.equal(app.syncListeners.size, 0); }
    const updates = app.calls.updates, mineCalls = app.calls.mine;
    gate.resolve({recipe: {id: PUBLIC_ID, name: '不应出现的迟到同步菜名'}}); await turn();
    listener({state: 'synced', owner: OWNER, lastSyncedAt: 11, revision: 1, publicationVersion: 2}); await turn();
    assert.equal(app.calls.updates, updates, mode);
    assert.equal(app.calls.mine, mineCalls, mode);
    assertUnshareable(page);
  }
});

test('sharing is available for saved copies and default example recipes through the same confirmation', async () => {
  for (const recipe of [{isExample: true}, {source: {recipeId: 'e'.repeat(64), profileId: AUTHOR_ID, authorName: '原作者'}}]) {
    const app = setup({recipe}); const page = await app.open();
    await page.requestShare();
    assert.equal(page.data.publishVisible, true);
    assert.equal(app.calls.publish.length, 0);
    await page.confirmPublish();
    assert.equal(page.data.shareVisible, true);
    assert.equal(page.onShareAppMessage().path, '/pages/public-recipe/index?id=' + PUBLIC_ID);
  }
});

test('unknown or unavailable visibility never guesses a recipe is public or starts publication', async () => {
  const app = setup(); app.page.refresh();
  app.hooks.mine = () => { throw Error('暂时离线'); };
  await app.page.requestShare();
  assert.equal(app.page.data.publicReady, false);
  assert.equal(app.page.data.publishVisible, false);
  assert.equal(app.page.data.shareVisible, false);
  assert.deepEqual(app.calls.publish, []);
  assertUnshareable(app.page);
  delete app.hooks.mine;
  await app.page.requestShare();
  assert.equal(app.page.data.publishVisible, true);
  assert.deepEqual(app.calls.publish, []);
});

test('a failed public snapshot cannot leak the local title and sharing can retry without republishing', async () => {
  const app = setup({published: true});
  app.hooks.recipe = () => { throw Error('公开版本暂时无法读取'); };
  const page = await app.open();
  await page.requestShare();
  assert.equal(page.data.shareVisible, false);
  assertUnshareable(page);
  delete app.hooks.recipe;
  await page.requestShare();
  assert.equal(page.onShareAppMessage().title, '已公开的南瓜小米粥 · 口袋食谱');
  assert.deepEqual(app.calls.publish, []);
});

test('invalid public snapshot identity or title cannot become a share payload', async () => {
  for (const recipe of [null, {id: 'e'.repeat(64), name: '另一道菜'}, {id: PUBLIC_ID, name: ' '}]) {
    const app = setup({published: true});
    app.hooks.recipe = () => ({recipe});
    const page = await app.open();
    assert.equal(page.data.shareRecipe, null);
    assertUnshareable(page);
    assert.deepEqual(app.calls.publish, []);
  }
});

test('a withdrawn public snapshot leaves a retryable state without recursively reloading stale publication metadata', async () => {
  const app = setup({published: true}); app.page.refresh();
  app.hooks.recipe = () => { throw Object.assign(Error('已取消公开'), {code: 'NOT_PUBLIC'}); };
  // Cap the stub so a regression fails deterministically instead of looping.
  app.hooks.mine = () => {
    if (app.calls.mine > 2) throw Error('重复加载了过期的公开状态');
    return {profile: {exists: true}, published: [{id: PUBLIC_ID, sourceRecipeId: LOCAL_ID, sourceUpdatedAt: 1}]};
  };
  await app.page.requestShare();
  assert.equal(app.calls.mine, 1);
  assert.equal(app.page.data.publicReady, false);
  assert.equal(app.page.data.shareVisible, false);
  assertUnshareable(app.page);
});

test('failed publication cannot expose a share and a new confirmation retries successfully', async () => {
  const app = setup(); const page = await app.open();
  const before = clone(app.store.getState());
  app.hooks.publish = () => { throw Error('公开失败，请联网重试'); };
  await page.requestShare(); await page.confirmPublish();
  assert.equal(app.isPublished(), false);
  assert.equal(page.data.shareVisible, false);
  assertUnshareable(page);
  assert.deepEqual(clone(app.store.getState()), before);
  delete app.hooks.publish;
  await page.requestShare();
  assert.equal(page.data.publishVisible, true);
  await page.confirmPublish();
  assert.equal(page.data.shareVisible, true);
  assert.equal(app.calls.publish.length, 2);
});

test('successful publication followed by snapshot failure retries sharing without publishing again', async () => {
  const app = setup(); const page = await app.open();
  app.hooks.recipe = () => { throw Error('公开版本暂时无法读取'); };
  await page.requestShare(); await page.confirmPublish();
  assert.equal(app.isPublished(), true);
  assert.equal(page.data.shareVisible, false);
  assertUnshareable(page);
  delete app.hooks.recipe;
  await page.requestShare();
  assert.equal(page.onShareAppMessage().path, '/pages/public-recipe/index?id=' + PUBLIC_ID);
  assert.equal(app.calls.publish.length, 1);
});

test('profile setup after confirmation resumes with another confirmation and preserves share intent', async () => {
  const app = setup({profileExists: false}); const page = await app.open();
  await page.requestShare(); await page.confirmPublish();
  assert.equal(app.calls.navigation.length, 1);
  assert.equal(app.calls.navigation[0].url, '/pages/profile/index?edit=1&returnToRecipe=1');
  assert.deepEqual(app.calls.publish, []);
  app.options.profileExists = true;
  app.calls.navigation[0].events.profileSaved();
  await page.onShow();
  assert.equal(page.data.publishVisible, true);
  assert.equal(page.data.shareAfterPublish, true);
  assert.deepEqual(app.calls.publish, []);
  await page.confirmPublish();
  assert.equal(page.data.shareVisible, true);
  assert.equal(app.calls.publish.length, 1);
});

test('returning from the background preserves publish-and-share confirmation for users with or without a profile', async () => {
  for (const profileExists of [true, false]) {
    const app = setup({profileExists}); const page = await app.open();
    await page.requestShare();
    const gate = pending(); app.hooks.mine = () => gate.promise;
    const resume = page.onShow();
    assert.equal(page.data.publishVisible, false, 'confirmation waits for fresh visibility');
    await page.confirmPublish();
    assert.deepEqual(app.calls.publish, []);
    gate.resolve({profile: {exists: profileExists}, published: []});
    await resume;
    delete app.hooks.mine;
    assert.equal(page.data.publishVisible, true);
    assert.equal(page.data.shareAfterPublish, true);
    assert.equal(page.data.shareVisible, false);
    assert.deepEqual(app.calls.publish, []);
    await page.confirmPublish();
    if (!profileExists) {
      assert.equal(app.calls.navigation.length, 1);
      assert.deepEqual(app.calls.publish, []);
      app.options.profileExists = true;
      app.calls.navigation[0].events.profileSaved();
      await page.onShow();
      assert.equal(page.data.publishVisible, true);
      assert.equal(page.data.shareAfterPublish, true);
      await page.confirmPublish();
    }
    assert.equal(app.calls.publish.length, 1);
    assert.equal(page.data.shareVisible, true, 'successful publication continues to native sending');
    assert.equal(page.onShareAppMessage().path, '/pages/public-recipe/index?id=' + PUBLIC_ID);
  }
});

test('failed visibility refresh on foreground closes share confirmation and never resumes publication automatically', async () => {
  for (const profileExists of [true, false]) {
    const app = setup({profileExists}); const page = await app.open();
    await page.requestShare();
    app.hooks.mine = () => { throw Error('恢复页面时网络不可用'); };
    await page.onShow();
    assert.equal(page.data.publicReady, false);
    assert.equal(page.data.publishVisible, false);
    assert.equal(page.data.shareAfterPublish, false);
    assert.equal(page.data.shareVisible, false);
    await page.confirmPublish();
    assert.deepEqual(app.calls.publish, []);
    assert.equal(app.calls.navigation.length, 0);
    delete app.hooks.mine;
    await page.onShow();
    assert.equal(page.data.publishVisible, false, 'network recovery alone is not renewed confirmation');
    await page.confirmPublish();
    assert.deepEqual(app.calls.publish, []);
    await page.requestShare();
    assert.equal(page.data.publishVisible, true);
    assert.equal(page.data.shareAfterPublish, true);
  }
});

test('leaving profile setup without saving abandons share publication even when a late save event arrives', async () => {
  const app = setup({profileExists: false}); const page = await app.open();
  await page.requestShare(); await page.confirmPublish();
  app.options.profileExists = true;
  await page.onShow();
  app.calls.navigation[0].events.profileSaved();
  await page.onShow(); await page.confirmPublish();
  assert.equal(page.data.publishVisible, false);
  assert.equal(page.data.shareVisible, false);
  assert.deepEqual(app.calls.publish, []);
});

test('failed profile navigation or an offline return clears pending share intent and requires a new confirmation', async () => {
  for (const mode of ['navigation', 'offline']) {
    const app = setup({profileExists: false}); const page = await app.open();
    await page.requestShare(); await page.confirmPublish();
    if (mode === 'navigation') app.calls.navigation[0].fail();
    else {
      app.options.profileExists = true;
      app.calls.navigation[0].events.profileSaved();
      app.hooks.mine = () => { throw Error('返回后暂时离线'); };
      await page.onShow();
      assert.equal(page.data.publicReady, false);
      delete app.hooks.mine;
      await page.refreshPublication();
    }
    assert.equal(page.data.shareAfterPublish, false, mode);
    assert.equal(page.data.publishVisible, false, mode);
    assert.equal(page.data.shareVisible, false, mode);
    await page.confirmPublish();
    assert.deepEqual(app.calls.publish, [], mode);
    await page.requestShare();
    assert.equal(page.data.publishVisible, true, mode);
    assert.equal(page.data.shareAfterPublish, true, mode);
  }
});

test('already public recipes keep sharing available while deletion confirmation temporarily hides it', async () => {
  const app = setup({published: true}); const page = await app.open();
  const menuShown = () => app.calls.shareMenu[app.calls.shareMenu.length - 1].show;
  assert.equal(menuShown(), true);
  page.requestPublish();
  assert.equal(page.data.publishVisible, false);
  assert.equal(menuShown(), true);
  assert.equal(page.onShareAppMessage().path, '/pages/public-recipe/index?id=' + PUBLIC_ID);
  page.remove();
  assert.equal(menuShown(), false);
  assertUnshareable(page);
  page.cancelDelete();
  assert.equal(menuShown(), true);
  assert.equal(page.onShareAppMessage().path, '/pages/public-recipe/index?id=' + PUBLIC_ID);
  assert.deepEqual(app.calls.publish, []);
  assert.deepEqual(app.calls.unpublish, []);
});

test('an account switch clears pending share confirmation and stale public sharing, including A to B to A', async () => {
  for (const published of [false, true]) {
    const app = setup({published}); const page = await app.open();
    await page.requestShare();
    app.store.bindAccount(OTHER); app.store.bindAccount(OWNER);
    await page.confirmPublish(); await page.requestShare();
    assert.equal(page.data.publishVisible, false);
    assert.equal(page.data.shareVisible, false);
    assert.equal(page.data.shareRecipe, null);
    assert.deepEqual(app.calls.publish, []);
    assertUnshareable(page);
  }
});

test('a delayed public snapshot cannot restore sharing after switching accounts or unloading', async () => {
  for (const mode of ['account', 'unload']) {
    const app = setup({published: true}); const page = await app.open();
    const gate = pending(); app.hooks.recipe = () => gate.promise;
    const work = page.refreshPublication(); await turn();
    assertUnshareable(page);
    if (mode === 'account') { app.store.bindAccount(OTHER); app.store.bindAccount(OWNER); }
    else page.onUnload();
    const updates = app.calls.updates;
    gate.resolve({recipe: {id: PUBLIC_ID, name: '迟到的公开内容'}}); await work;
    assert.equal(app.calls.updates, updates, mode);
    assertUnshareable(page);
  }
});

test('a newer private status wins over an earlier in-flight public snapshot', async () => {
  const app = setup({published: true}); const page = await app.open();
  const gate = pending(); app.hooks.recipe = () => gate.promise;
  const old = page.refreshPublication(); await turn();
  app.hooks.mine = () => ({profile: {exists: true}, published: []});
  await page.refreshPublication();
  gate.resolve({recipe: {id: PUBLIC_ID, name: '旧的公开版本'}}); await old;
  assert.equal(page.data.publicInfo, null);
  assert.equal(page.data.shareRecipe, null);
  assertUnshareable(page);
});

test('automatic publication refresh or withdrawal supersedes an older in-flight share snapshot', async () => {
  for (const action of ['sync', 'unpublish']) {
    const app = setup({published: true}); const page = await app.open();
    const gate = pending(); app.hooks.recipe = () => gate.promise;
    const old = page.refreshPublication(); await turn();
    delete app.hooks.recipe;
    if (action === 'sync') { app.updatePublicSnapshot('自动同步的新标题'); app.emitSync(); }
    else await page.unpublish();
    gate.resolve({recipe: {id: PUBLIC_ID, name: '不应恢复的过时公开标题'}}); await old; await turn();
    assert.equal(page.data.shareVisible, false, action);
    if (action === 'sync') {
      assert.equal(page.onShareAppMessage().title, '自动同步的新标题 · 口袋食谱');
      assert.equal(app.calls.publish.length, 0);
    } else {
      assert.equal(page.data.publicInfo, null);
      assert.equal(page.data.shareRecipe, null);
      assertUnshareable(page);
    }
  }
});

test('withdrawal and deletion block sharing while pending and remove public sharing on success', async () => {
  for (const action of ['unpublish', 'delete']) {
    const app = setup({published: true}); const page = await app.open();
    const gate = pending(); app.hooks.unpublish = () => gate.promise;
    let work;
    if (action === 'delete') { page.remove(); work = page.confirmDelete(); }
    else work = page.unpublish();
    assertUnshareable(page);
    await page.requestShare();
    assert.equal(page.data.publishVisible, false);
    assert.equal(page.data.shareVisible, false);
    gate.resolve(); await work;
    assertUnshareable(page);
    assert.equal(page.data.shareRecipe, null);
  }
});

test('share publication completion cannot reopen UI after account change or unload', async () => {
  for (const mode of ['account', 'unload']) {
    const app = setup(); const page = await app.open();
    const gate = pending(); app.hooks.publish = () => gate.promise;
    await page.requestShare(); const work = page.confirmPublish();
    if (mode === 'account') app.store.bindAccount(OTHER);
    else page.onUnload();
    const updates = app.calls.updates;
    gate.resolve(); await work;
    assert.equal(app.calls.updates, updates, mode);
    assert.equal(page.data.shareVisible, false);
    assert.equal(app.calls.toasts.length, 0);
    assertUnshareable(page);
  }
});

test('social-disabled pages do not publish or share private recipes', async () => {
  const app = setup({enabled: false}); const page = await app.open();
  await page.requestShare(); await page.confirmPublish();
  assert.equal(app.calls.mine, 0);
  assert.deepEqual(app.calls.recipe, []);
  assert.deepEqual(app.calls.publish, []);
  assert.equal(page.data.publishVisible, false);
  assertUnshareable(page);
});
