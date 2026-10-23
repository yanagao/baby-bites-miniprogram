'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const profile = {id: 'a'.repeat(32), name: '朋友的小厨房', bio: '', exists: true};
const recipe = {id: 'b'.repeat(64), profileId: profile.id, name: '南瓜粥', ingredients: [{name: '南瓜'}], steps: ['煮熟']};
function setup(name, social, options = {}) {
  const calls = {errors: [], toasts: [], routes: [], share: [], updates: 0};
  let owner = options.owner === undefined ? 'owner-a' : options.owner;
  const listeners = new Set();
  const store = {getSyncInfo: () => ({owner}), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  const wx = {
    showToast(o) { calls.toasts.push(o.title); },
    navigateTo(o) { calls.routes.push(o.url); }, switchTab(o) { calls.routes.push(o.url); },
    showShareMenu() { calls.share.push('show'); }, hideShareMenu() { calls.share.push('hide'); }, previewImage() {}
  };
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {
    module: accountModule, wx, require() { return store; }
  });
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages', name, 'index.js'), 'utf8'), {
    Page(value) { definition = value; },
    require(dep) {
      if (dep.endsWith('/social')) return social;
      if (dep.endsWith('/account')) return accountModule.exports;
      if (dep.endsWith('/ui')) return {error(e) { calls.errors.push(e.message); }, back() { calls.routes.push('back'); }};
      throw Error(dep);
    },
    wx
  });
  const page = {...definition, data: clone(definition.data), setData(change) { calls.updates++; Object.assign(this.data, clone(change)); }};
  page.onLoad(options);
  return {page, calls, listeners, changeOwner(value, notify = true) { owner = value; if (notify) listeners.forEach(fn => fn()); }};
}

test('own profile stays private until an explicit save and share links contain only a public ID', async () => {
  let saved = 0;
  const fixture = setup('profile', {
    getMine: async () => ({profile: {...profile, name: '口袋小厨', exists: false}}),
    saveProfile: async () => { saved++; }
  });
  await fixture.page.load();
  assert.equal(saved, 0);
  assert.equal(fixture.page.data.isSelf, true);
  assert.equal(fixture.page.onShareAppMessage().path, '/pages/home/index');
  assert.deepEqual(fixture.calls.share, ['hide']);
  fixture.page.setData({profile});
  const share = fixture.page.onShareAppMessage();
  assert.equal(share.path, '/pages/profile/index?id=' + profile.id);
  assert.equal(share.imageUrl, '/assets/cute/pocket-mascot.png', 'share image cannot capture personal meal data');
});

test('a late profile response cannot replace a newer profile or an unloaded page', async () => {
  const old = deferred(), newer = deferred(); let reads = 0;
  const {page} = setup('profile', {getProfile: () => ++reads === 1 ? old.promise : newer.promise}, {id: profile.id});
  const first = page.load(), second = page.load();
  newer.resolve({profile: {...profile, name: '最新主页'}, recipes: [], isSelf: false}); await second;
  old.resolve({profile, recipes: [], isSelf: false}); await first;
  assert.equal(page.data.profile.name, '最新主页');
  const last = deferred();
  const unloaded = setup('profile', {getProfile: () => last.promise}, {id: profile.id}).page;
  const task = unloaded.load(); unloaded.onUnload(); last.resolve({profile, recipes: [], isSelf: false}); await task;
  assert.equal(unloaded.data.profile, null);
});

test('unavailable profiles cannot keep sharing a stale profile card', async () => {
  const {page} = setup('profile', {getProfile: async () => { throw Error('主页暂时不可用'); }}, {id: profile.id});
  page.setData({profile, recipes: [recipe]});
  await page.load();
  assert.equal(page.data.profile, null);
  assert.equal(page.data.recipes.length, 0);
  assert.equal(page.onShareAppMessage().path, '/pages/home/index');
});

test('profile save requires a nickname and never submits the baby nickname', async () => {
  let input;
  const {page, calls} = setup('profile', {
    saveProfile: async value => { input = value; },
    getMine: async () => ({profile}), getProfile: async () => ({profile, recipes: [], isSelf: true})
  });
  page.setData({name: '   ', bio: '介绍'}); await page.save();
  assert.equal(input, undefined); assert.equal(calls.errors[0], '请填写公开昵称');
  page.setData({name: ' 我的厨房 ', bio: ' 只分享做法 '}); await page.save();
  assert.equal(input.name, '我的厨房'); assert.equal(input.bio, '只分享做法');
  assert.deepEqual(Object.keys(input).sort(), ['bio', 'name']);
});

test('changing following tabs ignores an older feed response', async () => {
  const feed = deferred();
  const {page} = setup('following', {getFeed: () => feed.promise, getFollowing: async () => ({profiles: [profile], nextOffset: null})});
  const old = page.load();
  page.setData({tab: 'people'}); await page.load();
  feed.resolve({recipes: [recipe], nextCursor: 'old'}); await old;
  assert.equal(page.data.profiles.length, 1);
  assert.equal(page.data.recipes.length, 0);
  assert.equal(page.data.nextCursor, null);
});

test('feed pagination deduplicates recipes when new publications shift pages', async () => {
  const seen = [];
  const {page} = setup('following', {getFeed: async cursor => {
    seen.push(cursor);
    return cursor ? {recipes: [recipe, {...recipe, id: 'second'}], nextCursor: null} : {recipes: [recipe], nextCursor: 'next'};
  }});
  await page.load(); await page.loadMore();
  assert.equal(page.data.recipes.length, 2);
  assert.deepEqual(seen, [undefined, 'next']);
  assert.equal(page.data.nextCursor, null);
});

test('one-tap copy sends only the public ID, blocks duplicate taps and changes to view-own', async () => {
  const pending = deferred(); let imports = 0, incoming;
  const {page, calls} = setup('public-recipe', {
    getRecipe: async () => ({recipe, author: profile}), findImportedRecipe: () => null,
    addToCookbook(id) { imports++; incoming = id; return pending.promise; }
  }, {id: recipe.id});
  await page.load();
  const first = page.add(); await page.add();
  assert.equal(imports, 1); assert.equal(incoming, recipe.id); assert.equal(page.data.adding, true);
  pending.resolve({recipeId: 'shared-copy', added: true}); await first;
  assert.equal(page.data.adding, false); assert.equal(page.data.importedId, 'shared-copy');
  await page.add();
  assert.equal(imports, 1); assert.equal(calls.routes[0], '/pages/detail/index?id=shared-copy');
});

test('a failed copy never claims that a recipe was added', async () => {
  const {page, calls} = setup('public-recipe', {
    getRecipe: async () => ({recipe, author: profile}), findImportedRecipe: () => null,
    addToCookbook: async () => { throw Error('作者已取消公开'); }
  }, {id: recipe.id});
  await page.load(); await page.add();
  assert.equal(page.data.importedId, ''); assert.equal(page.data.adding, false);
  assert.deepEqual(calls.toasts, []); assert.deepEqual(calls.errors, ['作者已取消公开']);
});

test('failed public detail refresh clears any previously accessible recipe and private-copy link', async () => {
  const {page} = setup('public-recipe', {getRecipe: async () => { throw Error('已取消公开'); }}, {id: recipe.id});
  page.setData({recipe, author: profile, importedId: 'old-account-copy'});
  await page.load();
  assert.equal(page.data.recipe, null); assert.equal(page.data.importedId, '');
});

test('a draft from account A cannot save after switching to B before the request starts', async () => {
  let saves = 0;
  const fixture = setup('profile', {
    saveProfile: async () => { saves++; },
    getMine: async () => ({profile: {...profile, exists: false}})
  });
  await fixture.page.load();
  fixture.page.edit(); fixture.page.changeName({detail: {value: 'A 的未保存昵称'}});
  fixture.changeOwner('owner-b', false);
  await fixture.page.save();
  assert.equal(saves, 0);
  assert.equal(fixture.page.data.name, '');
  assert.equal(fixture.page.data.editing, false);
  assert.match(fixture.page.data.error, /账号已切换/);
});

test('account A to B to A stays locked until explicit reload, and initial binding is allowed', async () => {
  let follows = 0;
  const fixture = setup('profile', {
    getProfile: async () => ({profile, recipes: [], isSelf: false, following: false}),
    setFollowing: async () => { follows++; return {following: true}; }
  }, {id: profile.id, owner: ''});
  fixture.changeOwner('owner-a');
  await fixture.page.load(); assert.equal(fixture.page.data.profile.id, profile.id);
  fixture.changeOwner('owner-b'); fixture.changeOwner('owner-a');
  await fixture.page.toggleFollow(); await fixture.page.load();
  assert.equal(follows, 0); assert.equal(fixture.page.data.profile, null);
  await fixture.page.reload(); await fixture.page.toggleFollow();
  assert.equal(follows, 1);
  fixture.page.onUnload(); assert.equal(fixture.listeners.size, 0);
});

test('switching accounts blocks an existing imported-recipe link and one-tap copy', async () => {
  let imports = 0;
  const fixture = setup('public-recipe', {
    getRecipe: async () => ({recipe, author: profile}), findImportedRecipe: () => ({id: 'account-a-copy'}),
    addToCookbook: async () => { imports++; }
  }, {id: recipe.id});
  await fixture.page.load();
  fixture.changeOwner('owner-b');
  await fixture.page.add(); fixture.page.openOwn();
  assert.equal(imports, 0); assert.deepEqual(fixture.calls.routes, []);
  assert.equal(fixture.page.data.importedId, ''); assert.equal(fixture.page.data.recipe, null);
});

test('pending save, follow and copy have no UI effects after page unload', async t => {
  for (const method of ['save', 'toggleFollow', 'add']) {
    for (const fail of [false, true]) await t.test(method + (fail ? ' rejects' : ' resolves'), async () => {
      const pending = deferred();
      const fixture = setup(method === 'add' ? 'public-recipe' : 'profile', {
        saveProfile: () => pending.promise, setFollowing: () => pending.promise, addToCookbook: () => pending.promise
      }, {id: method === 'add' ? recipe.id : profile.id});
      fixture.page.setData({name: '公开昵称', profile, recipe});
      const task = fixture.page[method]();
      fixture.page.onUnload();
      const updates = fixture.calls.updates;
      if (fail) pending.reject(Object.assign(Error('账号已切换'), {code: 'ACCOUNT_CHANGED'}));
      else pending.resolve({following: true, recipeId: 'copy', added: true});
      await task;
      await fixture.page.reload();
      assert.equal(fixture.calls.updates, updates);
      assert.equal(fixture.listeners.size, 0);
      assert.deepEqual(fixture.calls.toasts, []);
      assert.deepEqual(fixture.calls.errors, []);
      assert.deepEqual(fixture.calls.routes, []);
    });
  }
});
