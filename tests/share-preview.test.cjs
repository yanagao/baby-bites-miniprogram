'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '..');
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64), PUBLIC_ID = 'c'.repeat(64);
const AUTHOR_ID = 'd'.repeat(32), TOKEN = 'e'.repeat(64), LOCAL_ID = 'my-saved-recipe';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
function pending() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}
function setup(options = {}) {
  const localRecipe = {id: LOCAL_ID, name: '我的本机菜谱', category: '粥饭主食', minutes: 20,
    texture: '软烂颗粒', ingredients: [{name: '南瓜', amount: '30 克'}], steps: ['本机做法。'],
    note: '不公开的私人心得', photo: '', imageKey: '', favorite: false, isExample: false,
    createdAt: 1, updatedAt: 2, ...(options.localRecipe || {})};
  const storage = new Map([['baby-bites-v1', {version: 1, nickname: '宝宝私人称呼', profileUpdatedAt: 1,
    allergies: ['鸡蛋'], allergiesUpdatedAt: 1, recipes: [localRecipe],
    logs: [{id: 'private-meal', recipeId: localRecipe.id, rating: 3, date: '2020-01-01',
      portion: '私人食量', note: '不公开的用餐记录', createdAt: 1}]}]]);
  const calls = {preview: [], publish: [], updates: 0, backs: 0, navigation: [], toasts: [], shareMenu: [], errors: []};
  const hooks = {};
  const wx = {
    getStorageSync(key) { return clone(storage.get(key)); },
    setStorageSync(key, value) { storage.set(key, clone(value)); },
    getStorageInfoSync() { return {keys: [...storage.keys()]}; },
    navigateTo(args) { calls.navigation.push(args); }, redirectTo(args) { calls.navigation.push(args); },
    showToast(args) { calls.toasts.push(args.title); },
    showShareMenu(args) { calls.shareMenu.push({show: true, ...clone(args)}); },
    hideShareMenu(args) { calls.shareMenu.push({show: false, ...clone(args)}); },
    previewImage() {}, navigateBack() { calls.backs++; }
  };
  const storeModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/store.js'), 'utf8'), {
    module: storeModule, require: createRequire(path.join(root, 'utils/store.js')), wx
  });
  const store = storeModule.exports;
  store.bindAccount(OWNER);
  const info = store.getSyncInfo();
  store.applySyncedSnapshot(store.getSyncSnapshot(), {owner: OWNER, sequence: info.sequence, revision: 1});
  let preview = {previewToken: TOKEN, alreadyPublished: options.alreadyPublished === true,
    author: {id: AUTHOR_ID, name: '对外显示的昵称', bio: '家常做法', babyAgeMonths: 12},
    recipe: {id: PUBLIC_ID, profileId: AUTHOR_ID, authorName: '对外显示的昵称', name: '预览里的菜名',
      category: '粥饭主食', texture: '软烂颗粒', minutes: 25, ageGroups: ['12-17'],
      ingredients: [{name: '小米', amount: '20 克'}], steps: ['预览做法一。', '预览做法二。'],
      imageKey: '', displayPhoto: '', photoURL: options.photo ? 'https://example.test/preview-photo.jpg' : '',
      source: {profileId: 'f'.repeat(32), recipeId: '1'.repeat(64), authorName: '原作者'}}};
  const social = {
    async previewPublication(id) { calls.preview.push(id); return hooks.preview ? hooks.preview(id) : clone(preview); },
    async publishRecipe(id, token) {
      calls.publish.push({id, token});
      return hooks.publish ? hooks.publish(id, token) : {recipe: clone(preview.recipe)};
    }
  };
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/share-preview/index.js'), 'utf8'), {
    wx, Page(value) { definition = value; },
    require(name) {
      if (name.endsWith('/store')) return store;
      if (name.endsWith('/social')) return social;
      if (name.endsWith('/ui')) return {back() { calls.backs++; }, error(error) { calls.errors.push(error.message); }};
      if (name.endsWith('/recipe-origin')) return require('../utils/recipe-origin');
      if (name.endsWith('/recipe-ages')) return require('../utils/recipe-ages');
      if (name.endsWith('/baby-age')) return require('../utils/baby-age');
      if (name.endsWith('/profile-avatar')) return require('../utils/profile-avatar');
      if (name.endsWith('/cloud')) return {socialEnabled: options.enabled !== false};
      throw Error('Unexpected share-preview dependency: ' + name);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(update) {
    calls.updates++;
    for (const [key, value] of Object.entries(clone(update))) {
      const parts = key.split('.'); let target = this.data;
      while (parts.length > 1) target = target[parts.shift()];
      target[parts[0]] = value;
    }
  }};
  page.onLoad({id: options.id === undefined ? localRecipe.id : options.id});
  return {page, store, calls, hooks, getPreview: () => clone(preview),
    setPreview(value) { preview = value; },
    async open() { await page.onShow(); await turn(); return page; }};
}
function assertPrivateShare(page) {
  const share = page.onShareAppMessage();
  assert.equal(share.path, '/pages/home/index');
  assert.equal(share.imageUrl, '/assets/cute/pocket-mascot.png');
  assert.doesNotMatch(JSON.stringify(share), /我的本机|预览里的|私人|my-saved-recipe|private-meal/);
}

test('opening or returning to preview never publishes or shares a recipe by default', async () => {
  const app = setup(); const before = clone(app.store.getState()); const page = await app.open();
  assert.equal(app.calls.preview.length, 1);
  assert.deepEqual(app.calls.publish, []);
  assertPrivateShare(page);
  await page.onShow(); await turn();
  assert.deepEqual(app.calls.publish, []);
  assert.deepEqual(clone(app.store.getState()), before);
});

test('preview displays server-selected fields and never copies personal recipe or baby data', async () => {
  const app = setup(); const page = await app.open(); const preview = app.getPreview();
  assert.deepEqual(clone(page.data.recipe), preview.recipe);
  assert.deepEqual(clone(page.data.author), preview.author);
  assert.equal(page.data.recipe.name, '预览里的菜名');
  assert.equal(page.data.recipe.minutes, 25);
  assert.deepEqual(clone(page.data.recipe.ingredients), [{name: '小米', amount: '20 克'}]);
  assert.deepEqual(clone(page.data.recipe.steps), ['预览做法一。', '预览做法二。']);
  assert.ok(page.data.ageLabels);
  assert.doesNotMatch(JSON.stringify(page.data), /不公开的私人心得|宝宝私人称呼|私人食量|不公开的用餐记录|private-meal/);
  const markup = fs.readFileSync(path.join(root, 'pages/share-preview/index.wxml'), 'utf8');
  for (const field of ['recipe.name', 'recipe.category', 'recipe.minutes', 'recipe.texture', 'recipe.ingredients',
    'recipe.steps', 'recipe.source.authorName', 'author.name', 'author.bio', 'author.babyAgeMonths', 'ageLabels', 'photoSrc']) {
    assert.ok(markup.includes(field), field);
  }
  assert.doesNotMatch(markup, /\{\{(?:recipe\.(?:note|favorite|logs)|author\.(?:babyBirthDate|nickname)|allergies)\b/);
  assert.match(markup, /不会分享：小心得、宝宝称呼和生日、过敏记录、收藏及用餐记录/);
});

test('only explicit confirmation publishes the exact preview token and enables sharing after success', async () => {
  const app = setup(); const page = await app.open();
  assert.equal(page.data.published, false); assert.deepEqual(app.calls.publish, []); assertPrivateShare(page);
  await page.confirmPublish();
  assert.deepEqual(app.calls.publish, [{id: LOCAL_ID, token: TOKEN}]);
  assert.equal(page.data.published, true); assert.equal(page.data.previewToken, '');
  assert.equal(app.calls.toasts.at(-1), '已公开分享');
  assert.equal(page.onShareAppMessage().path, '/pages/public-recipe/index?id=' + PUBLIC_ID);
  assert.equal(page.onShareAppMessage().title, '预览里的菜名 · 口袋食谱');
  assert.equal(app.calls.shareMenu.at(-1).show, true);
  await page.confirmPublish(); await page.onShow();
  assert.equal(app.calls.publish.length, 1);
});

test('keeping a recipe to oneself or returning closes preview without publishing', async () => {
  const app = setup(); const page = await app.open(); const before = clone(app.store.getState());
  page.back();
  assert.equal(app.calls.backs, 1);
  assert.deepEqual(app.calls.publish, []);
  assert.deepEqual(clone(app.store.getState()), before);
  assertPrivateShare(page);
  const markup = fs.readFileSync(path.join(root, 'pages/share-preview/index.wxml'), 'utf8');
  assert.match(markup, /先留给自己/);
  assert.match(markup, /确认公开分享/);
  assert.doesNotMatch(markup, /\bchecked(?:=|\s|>)/);
});

test('confirmation is single-flight and cannot expose a recipe before server success', async () => {
  const app = setup(); const page = await app.open(), gate = pending();
  app.hooks.publish = () => gate.promise;
  const work = page.confirmPublish(); await page.confirmPublish(); page.back(); await page.reload();
  assert.equal(app.calls.publish.length, 1); assert.equal(app.calls.preview.length, 1);
  assert.equal(app.calls.backs, 0); assert.equal(page.data.confirming, true); assertPrivateShare(page);
  gate.resolve({recipe: app.getPreview().recipe}); await work;
  assert.equal(page.data.confirming, false); assert.equal(page.data.published, true);
});

test('user photos must visibly load for the current preview before confirmation', async () => {
  const app = setup({photo: true}); const page = await app.open();
  assert.equal(page.data.photoSrc, 'https://example.test/preview-photo.jpg');
  assert.equal(page.data.photoReady, false);
  await page.confirmPublish(); assert.deepEqual(app.calls.publish, []);
  page.imageLoaded({currentTarget: {dataset: {token: 'f'.repeat(64)}}});
  await page.confirmPublish(); assert.deepEqual(app.calls.publish, []);
  page.imageLoaded({currentTarget: {dataset: {token: TOKEN}}});
  assert.equal(page.data.photoReady, true);
  await page.confirmPublish(); assert.equal(app.calls.publish.length, 1);
});

test('photo errors clear consent and require a newly loaded preview rather than bypassing the photo', async () => {
  const app = setup({photo: true}); const page = await app.open();
  page.imageError({currentTarget: {dataset: {token: TOKEN}}});
  assert.equal(page.data.photoFailed, true); assert.equal(page.data.previewToken, '');
  assert.match(page.data.error, /照片/);
  page.imageLoaded({currentTarget: {dataset: {token: TOKEN}}});
  await page.confirmPublish(); assert.deepEqual(app.calls.publish, []);
  const next = app.getPreview(); next.previewToken = 'f'.repeat(64); app.setPreview(next);
  await page.reload();
  assert.equal(page.data.photoFailed, false); assert.equal(page.data.photoReady, false);
  page.imageLoaded({currentTarget: {dataset: {token: TOKEN}}});
  await page.confirmPublish(); assert.deepEqual(app.calls.publish, []);
  page.imageLoaded({currentTarget: {dataset: {token: next.previewToken}}});
  await page.confirmPublish();
  assert.deepEqual(app.calls.publish, [{id: LOCAL_ID, token: next.previewToken}]);
});

test('local changes invalidate the preview even when its recipe still exists', async () => {
  const app = setup(); const page = await app.open();
  app.store.saveRecipe({...app.store.getRecipe(LOCAL_ID), name: '稍后修改的名字'});
  assert.equal(page.data.previewToken, ''); assert.equal(page.data.photoReady, false);
  assert.match(page.data.error, /已有更新/);
  await page.confirmPublish(); assert.deepEqual(app.calls.publish, []); assertPrivateShare(page);
  const next = app.getPreview(); next.previewToken = 'f'.repeat(64); next.recipe.name = '稍后修改的名字'; app.setPreview(next);
  await page.reload(); await page.confirmPublish();
  assert.deepEqual(app.calls.publish, [{id: LOCAL_ID, token: next.previewToken}]);
});

test('account changes clear consent immediately and A to B to A cannot revive it', async () => {
  const app = setup(); const page = await app.open();
  app.store.bindAccount(OTHER); app.store.bindAccount(OWNER);
  assert.equal(page.data.recipe, null); assert.equal(page.data.author, null); assert.equal(page.data.previewToken, '');
  assert.match(page.data.error, /账号已切换/);
  await page.confirmPublish(); await page.reload();
  assert.deepEqual(app.calls.publish, []); assert.equal(app.calls.preview.length, 1); assertPrivateShare(page);
});

test('preview failures are retryable without publishing or creating share metadata', async () => {
  const app = setup(); app.hooks.preview = () => { throw Error('暂时离线'); };
  const page = await app.open();
  assert.equal(page.data.recipe, null); assert.equal(page.data.previewToken, ''); assert.match(page.data.error, /离线/);
  await page.confirmPublish(); assert.deepEqual(app.calls.publish, []); assertPrivateShare(page);
  delete app.hooks.preview; await page.reload();
  assert.equal(page.data.previewToken, TOKEN); assert.deepEqual(app.calls.publish, []);
});

test('malformed preview envelopes never provide usable confirmation', async () => {
  for (const value of [null, {}, {recipe: {}, author: {}, previewToken: 'bad', alreadyPublished: false},
    {recipe: {}, author: {}, previewToken: TOKEN, alreadyPublished: 'yes'}]) {
    const app = setup(); app.hooks.preview = () => value;
    const page = await app.open(); await page.confirmPublish();
    assert.equal(page.data.previewToken, ''); assert.deepEqual(app.calls.publish, []); assertPrivateShare(page);
  }
});

test('missing recipe IDs fail before requesting a preview or publishing', async () => {
  const app = setup({id: ''}); const page = await app.open(); await page.confirmPublish();
  assert.match(page.data.error, /没有找到/); assert.deepEqual(app.calls.preview, []);
  assert.deepEqual(app.calls.publish, []); assertPrivateShare(page);
});

test('stale preview errors clear the token and need a fresh preview plus a new confirmation', async () => {
  const app = setup(); const page = await app.open();
  app.hooks.publish = () => { throw Object.assign(Error('菜谱已有更新，请重新预览。'), {code: 'PREVIEW_STALE'}); };
  await page.confirmPublish();
  assert.equal(page.data.previewToken, ''); assert.equal(page.data.published, false);
  assert.match(page.data.error, /重新预览/); assertPrivateShare(page);
  await page.confirmPublish(); assert.equal(app.calls.publish.length, 1);
  const next = app.getPreview(); next.previewToken = 'f'.repeat(64); app.setPreview(next);
  delete app.hooks.publish; await page.reload();
  assert.equal(app.calls.publish.length, 1, 'reloading does not reconfirm automatically');
  await page.confirmPublish();
  assert.deepEqual(app.calls.publish[1], {id: LOCAL_ID, token: next.previewToken});
});

test('failed and malformed publish responses never enable sharing and cannot blindly retry the token', async () => {
  for (const response of [null, {}, {recipe: {id: 'wrong', name: '标题'}}, {recipe: {id: PUBLIC_ID, name: ''}}, 'network']) {
    const app = setup(); const page = await app.open();
    app.hooks.publish = () => { if (response === 'network') throw Error('网络暂时不可用'); return response; };
    await page.confirmPublish();
    assert.equal(page.data.previewToken, ''); assert.equal(page.data.published, false); assertPrivateShare(page);
    await page.confirmPublish(); assert.equal(app.calls.publish.length, 1);
  }
});

test('preview responses after account switch or unload cannot update the page', async () => {
  for (const mode of ['switch', 'unload']) {
    const app = setup(), gate = pending(); app.hooks.preview = () => gate.promise;
    const work = app.page.onShow();
    if (mode === 'switch') app.store.bindAccount(OTHER); else app.page.onUnload();
    const updates = app.calls.updates; gate.resolve(app.getPreview()); await work;
    assert.equal(app.calls.updates, updates); assert.deepEqual(app.calls.publish, []); assertPrivateShare(app.page);
  }
});

test('publish responses after account switch or unload cannot show success or share old-account data', async () => {
  for (const mode of ['switch', 'unload']) {
    const app = setup(); const page = await app.open(), gate = pending(); app.hooks.publish = () => gate.promise;
    const work = page.confirmPublish();
    if (mode === 'switch') app.store.bindAccount(OTHER); else page.onUnload();
    const updates = app.calls.updates; gate.resolve({recipe: app.getPreview().recipe}); await work;
    assert.equal(app.calls.updates, updates); assert.equal(app.calls.toasts.length, 0); assertPrivateShare(page);
  }
});

test('server identity errors lock the preview instead of allowing a retry in another session', async () => {
  for (const stage of ['preview', 'publish']) {
    const app = setup();
    if (stage === 'preview') app.hooks.preview = () => { throw Object.assign(Error('changed'), {code: 'ACCOUNT_CHANGED'}); };
    const page = await app.open();
    if (stage === 'publish') {
      app.hooks.publish = () => { throw Object.assign(Error('changed'), {code: 'ACCOUNT_CHANGED'}); };
      await page.confirmPublish();
    }
    assert.equal(page.data.previewToken, ''); assert.equal(page.data.recipe, null);
    assert.match(page.data.error, /账号已切换/); assertPrivateShare(page);
    const reads = app.calls.preview.length, writes = app.calls.publish.length;
    await page.reload(); await page.confirmPublish();
    assert.equal(app.calls.preview.length, reads); assert.equal(app.calls.publish.length, writes);
  }
});

test('previously shared recipes disclose their status but still do not publish on opening preview', async () => {
  const app = setup({alreadyPublished: true}); const page = await app.open();
  assert.equal(page.data.alreadyPublished, true); assert.deepEqual(app.calls.publish, []); assertPrivateShare(page);
  page.back(); assert.deepEqual(app.calls.publish, []);
});

test('late preview or publish rejections after unload cannot restore errors or consent', async () => {
  for (const stage of ['preview', 'publish']) {
    const app = setup(), gate = pending(); let work;
    if (stage === 'preview') { app.hooks.preview = () => gate.promise; work = app.page.onShow(); }
    else { await app.open(); app.hooks.publish = () => gate.promise; work = app.page.confirmPublish(); }
    app.page.onUnload(); const updates = app.calls.updates;
    gate.reject(Error('late network error')); await work;
    assert.equal(app.calls.updates, updates); assert.equal(app.calls.toasts.length, 0); assertPrivateShare(app.page);
  }
});
