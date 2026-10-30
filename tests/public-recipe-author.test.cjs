'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {getProfileAvatar} = require('../utils/profile-avatar');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const author = {id: 'a'.repeat(32), name: '朋友的小厨房', bio: '', exists: true};
const recipe = {id: 'b'.repeat(64), profileId: author.id, name: '南瓜粥', ingredients: [{name: '南瓜'}], steps: ['煮熟']};
const turn = () => new Promise(resolve => setImmediate(resolve));

function setup(overrides = {}) {
  let owner = 'owner-a';
  const listeners = new Set();
  const calls = {errors: [], toasts: [], routes: [], updates: 0, profiles: [], follows: [], saves: []};
  const store = {getSyncInfo: () => ({owner}), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  const wx = {
    showToast(value) { calls.toasts.push(value.title); }, navigateTo(value) { calls.routes.push(value.url); },
    showShareMenu() {}, hideShareMenu() {}, previewImage() {}
  };
  const social = {
    getRecipe: async () => ({recipe, author}), findImportedRecipe: () => null,
    getProfile: async (id, offset) => { calls.profiles.push([id, offset]); return {profile: author, isSelf: false, following: false, followedBy: true}; },
    setFollowing: async (id, following) => { calls.follows.push([id, following]); return {following, followedBy: true}; },
    addToCookbook: async id => { calls.saves.push(id); return {recipeId: 'shared-copy', added: true}; }, ...overrides
  };
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {
    module: accountModule, wx, require() { return store; }
  });
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/public-recipe/index.js'), 'utf8'), {
    Page(value) { definition = value; }, wx,
    require(dep) {
      if (dep.endsWith('/social')) return social;
      if (dep.endsWith('/account')) return accountModule.exports;
      if (dep.endsWith('/profile-avatar')) return {getProfileAvatar};
      if (dep.endsWith('/ui')) return {error(error) { calls.errors.push(error.message); }, back() {}};
      throw Error(dep);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(value) { calls.updates++; Object.assign(this.data, clone(value)); }};
  page.onLoad({id: recipe.id});
  return {page, calls, changeOwner(value, notify = true) { owner = value; if (notify) listeners.forEach(fn => fn()); }};
}

test('author relationship loads independently after the recipe becomes readable', async () => {
  const pending = deferred();
  const {page, calls} = setup({getProfile: () => pending.promise});
  const loading = page.load(); await turn();
  assert.equal(page.data.loading, false); assert.equal(page.data.recipe.id, recipe.id);
  assert.equal(page.data.relationLoading, true);
  await page.add();
  assert.deepEqual(calls.saves, [recipe.id]); assert.equal(page.data.importedId, 'shared-copy');
  pending.resolve({profile: author, following: false, followedBy: true, isSelf: false}); await loading;
  assert.equal(page.data.relationReady, true); assert.equal(page.data.followedBy, true);
});

test('public recipe author avatars depend on the public ID, preserve the DTO, and survive a nickname change', async () => {
  let reads = 0;
  const original = Object.freeze({...author, id: '0'.repeat(31) + '1', avatar: 'https://untrusted.example/avatar'});
  const {page} = setup({getRecipe: async () => ({recipe, author: ++reads === 1 ? original : {...original, name: '更新后的昵称'}})});
  await page.load();
  assert.equal(page.data.author.avatar, getProfileAvatar(original.id));
  assert.equal(original.avatar, 'https://untrusted.example/avatar');
  await page.load();
  assert.equal(page.data.author.name, '更新后的昵称');
  assert.equal(page.data.author.avatar, getProfileAvatar(original.id));
});

test('relationship failure preserves recipe, share, save, and author navigation, then retries', async () => {
  let attempts = 0;
  const {page, calls} = setup({getProfile: async () => {
    if (++attempts === 1) throw Error('关注状态读取失败');
    return {profile: author, isSelf: false, following: false, followedBy: true};
  }});
  await page.load();
  assert.equal(page.data.error, ''); assert.equal(page.data.recipe.id, recipe.id);
  assert.equal(page.data.relationError, '关注状态读取失败'); assert.equal(page.data.relationReady, false);
  assert.equal(page.onShareAppMessage().path, '/pages/public-recipe/index?id=' + recipe.id);
  page.openAuthor(); assert.deepEqual(calls.routes, ['/pages/profile/index?id=' + author.id]);
  await page.add(); assert.equal(page.data.importedId, 'shared-copy');
  await page.refreshAuthorRelationship();
  assert.equal(page.data.relationError, ''); assert.equal(page.data.relationReady, true);
});

test('follow-back uses author public ID and confirms mutual relationship', async () => {
  const {page, calls} = setup();
  await page.load(); await page.toggleFollow();
  assert.deepEqual(calls.profiles, [[author.id, 0]]);
  assert.deepEqual(calls.follows, [[author.id, true]]);
  assert.equal(page.data.following, true); assert.equal(page.data.followedBy, true);
  assert.deepEqual(calls.toasts, ['已互相关注']);
  await page.toggleFollow(); assert.equal(page.data.following, false);
});

test('own author hides follow behavior and unknown relationships cannot be mutated', async () => {
  const {page, calls} = setup({getProfile: async () => ({isSelf: true, profile: author, following: false, followedBy: false})});
  await page.load(); await page.toggleFollow();
  assert.equal(page.data.authorIsSelf, true); assert.deepEqual(calls.follows, []);
  page.setData({authorIsSelf: false, relationReady: false}); await page.toggleFollow();
  assert.deepEqual(calls.follows, []);
});

test('missing own public profile exposes setup without losing recipe or faking a follow', async () => {
  const {page, calls} = setup({setFollowing: async () => { throw Object.assign(Error('先设置主页'), {code: 'PROFILE_REQUIRED'}); }});
  await page.load(); await page.toggleFollow();
  assert.equal(page.data.needsProfile, true); assert.equal(page.data.following, false);
  assert.equal(page.data.recipe.id, recipe.id); assert.equal(page.data.error, ''); assert.equal(page.data.followBusy, false);
  page.openProfileSetup(); assert.deepEqual(calls.routes, ['/pages/profile/index?edit=1']);
  assert.deepEqual(calls.toasts, []);
});

test('follow is deduplicated and page-show does not interrupt an active mutation', async () => {
  const pending = deferred(); let attempts = 0;
  const {page} = setup({setFollowing: () => { attempts++; return pending.promise; }});
  await page.load(); const task = page.toggleFollow();
  await page.toggleFollow(); await page.onShow(); await page.load();
  assert.equal(attempts, 1); assert.equal(page.data.followBusy, true); assert.equal(page.data.following, false);
  pending.resolve({following: true, followedBy: true}); await task;
  assert.equal(page.data.followBusy, false); assert.equal(page.data.following, true);
});

test('a failed follow leaves known relationship unchanged and can retry without hiding recipe', async () => {
  let attempts = 0;
  const {page} = setup({setFollowing: async () => {
    if (++attempts === 1) throw Error('稍后重试');
    return {following: true, followedBy: true};
  }});
  await page.load(); await page.toggleFollow();
  assert.equal(page.data.relationError, '稍后重试'); assert.equal(page.data.following, false);
  assert.equal(page.data.relationReady, true); assert.equal(page.data.recipe.id, recipe.id);
  await page.toggleFollow(); assert.equal(page.data.following, true); assert.equal(page.data.relationError, '');
});

test('late relationship read cannot overwrite a newer read', async () => {
  const older = deferred(), newer = deferred(); let reads = 0;
  const {page} = setup({getProfile: () => ++reads === 1 ? older.promise : newer.promise});
  const load = page.load(); await turn();
  const refresh = page.refreshAuthorRelationship();
  newer.resolve({profile: author, isSelf: false, following: true, followedBy: true}); await refresh;
  older.resolve({profile: author, isSelf: false, following: false, followedBy: false}); await load;
  assert.equal(page.data.following, true); assert.equal(page.data.followedBy, true);
});

test('account switch invalidates late relationship and follow responses', async () => {
  const pending = deferred();
  const fixture = setup({getProfile: () => pending.promise});
  const task = fixture.page.load(); await turn(); fixture.changeOwner('owner-b', false);
  pending.resolve({profile: author, following: true, followedBy: true, isSelf: false}); await task;
  assert.equal(fixture.page.data.recipe, null); assert.match(fixture.page.data.error, /账号已切换/);
  assert.equal(fixture.page.data.author, null);
  const following = deferred();
  const next = setup({setFollowing: () => following.promise});
  await next.page.load(); const mutation = next.page.toggleFollow(); next.changeOwner('owner-b');
  following.resolve({following: true, followedBy: true}); await mutation;
  assert.equal(next.page.data.recipe, null); assert.deepEqual(next.calls.toasts, []);
});

test('unloaded page ignores pending author request and mutation failures', async () => {
  for (const operation of ['read', 'follow']) {
    const pending = deferred();
    const {page, calls} = setup(operation === 'read' ? {getProfile: () => pending.promise} : {setFollowing: () => pending.promise});
    let task;
    if (operation === 'read') { task = page.load(); await turn(); }
    else { await page.load(); task = page.toggleFollow(); }
    page.onUnload(); const updates = calls.updates;
    pending.reject(Error('网络错误')); await task;
    assert.equal(calls.updates, updates); assert.deepEqual(calls.errors, []); assert.deepEqual(calls.toasts, []);
  }
});
