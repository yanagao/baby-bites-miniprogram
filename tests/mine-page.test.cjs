'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {evaluatePage} = require('./page-runtime.cjs');
const {getProfileAvatar} = require('../utils/profile-avatar');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const profile = {id: 'a'.repeat(32), name: '我的公开厨房', bio: '', exists: true};
const tap = value => ({currentTarget: {dataset: {value}}});
const recipe = (id, favorite = false) => ({id, name: '菜谱' + id, favorite, ingredients: [{name: '南瓜', amount: '20克'}], steps: ['煮熟'], minutes: 20, texture: '软烂颗粒', category: '粥饭', createdAt: 1, updatedAt: 1});
function setup(overrides = {}) {
  let owner = 'owner-a', state = {recipes: [recipe('1', true), recipe('2')], logs: [{id: 'log', recipeId: '1', date: '2026-10-28', rating: 3, note: 'PRIVATE NOTE', createdAt: 1}]};
  const listeners = new Set();
  const calls = {routes: [], tabs: [], updates: 0, syncs: 0, mine: 0, profiles: 0, errors: [], codes: [], saved: []};
  const wx = {navigateTo(options) { calls.routes.push(options.url); }, switchTab(options) { calls.tabs.push(options.url); },
    hideShareMenu() {}, showShareMenu() {}, showToast() {}, getAccountInfoSync: () => ({miniProgram: {envVersion: 'develop'}})};
  const store = {getSyncInfo: () => ({owner}), getState: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  const social = {getMine: async () => { calls.mine++; return {profile, published: [{sourceRecipeId: '1', sourceUpdatedAt: 1}], publishedCount: 1, followingCount: 5, followerCount: 6}; },
    getProfile: async () => { calls.profiles++; throw Error('Own tab should not load public recipe pages'); },
    getShareCode: async (id, env) => { calls.codes.push({id, env}); return {codeURL: 'https://example.test/code'}; },
    saveProfile: async value => { calls.saved.push(value); }, ...overrides.social};
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {module: accountModule, wx, require: () => store});
  let definition;
  evaluatePage(overrides.pageName || 'mine', {wx, socialEnabled: overrides.socialEnabled, onSyncTabBar() { calls.syncs++; }, Page(value) { definition = value; }, require(dep) {
    if (dep.endsWith('/social')) return social;
    if (dep.endsWith('/account')) return accountModule.exports;
    if (dep.endsWith('/store')) return store;
    if (dep.endsWith('/profile-poster')) return {remove() {}, render: async () => '/tmp/poster.png'};
    if (dep.endsWith('/ui')) return {error(error) { calls.errors.push(error.message); }, back() {}};
    throw Error(dep);
  }});
  const page = {...definition, data: clone(definition.data), setData(value) { calls.updates++; Object.assign(this.data, clone(value)); }};
  page.onLoad(overrides.loadOptions);
  return {page, calls, listeners, changeOwner(value, notify = true) { owner = value; if (notify) listeners.forEach(fn => fn()); }, changeState(value) { state = value; }};
}

test('mine is the own profile with a local cookbook, authoritative relationship totals and no second profile request', async () => {
  const {page, calls} = setup(); await page.onShow(); page.onReady();
  assert.equal(page.data.isTab, true); assert.equal(page.data.isSelf, true);
  assert.equal(page.data.recipeCount, 2); assert.equal(page.data.favoriteCount, 1); assert.equal(page.data.logCount, 1);
  assert.equal(page.data.followingCount, 5); assert.equal(page.data.followerCount, 6); assert.equal(calls.profiles, 0); assert.equal(calls.syncs, 2);
  assert.deepEqual(page.data.recipes.map(r => r.visibility), ['public', 'private']);
});

test('content and visibility tabs filter in place; own recipes and logs open local editors', async () => {
  const {page, calls} = setup(); await page.load();
  page.changeVisibility(tap('private')); assert.deepEqual(page.data.recipes.map(r => r.id), ['2']);
  page.openRecipe({detail: {id: '2'}});
  page.changeContentTab(tap('favorites')); assert.deepEqual(page.data.recipes.map(r => r.id), ['1']);
  page.changeContentTab(tap('records')); assert.equal(page.data.recipes.length, 0); assert.equal(page.data.logs[0].note, 'PRIVATE NOTE');
  page.openLog({currentTarget: {dataset: {id: 'log'}}});
  page.openFollowers(); page.openFollowing(); page.openSettings(); page.openRecords();
  assert.deepEqual(calls.routes, ['/pages/detail/index?id=2', '/pages/record-editor/index?logId=log', '/pages/following/index?tab=followers', '/pages/following/index?tab=people', '/pages/settings/index']);
  assert.deepEqual(calls.tabs, ['/pages/records/index']);
  page.changeContentTab(tap('recipes')); assert.deepEqual(page.data.recipes.map(r => r.id), ['2']);
});

test('profile editing and sharing happen on the mine page without another route', async () => {
  const {page, calls} = setup(); await page.load(); page.edit(); assert.equal(page.data.editing, true);
  page.cancelEdit(); await page.requestShare();
  assert.equal(page.data.shareVisible, true); assert.equal(page.data.posterPath, '/tmp/poster.png');
  assert.deepEqual(calls.routes, []); assert.deepEqual(calls.codes, [{id: profile.id, env: 'develop'}]);
  const shared = page.onShareAppMessage(); assert.equal(shared.path, '/pages/profile/index?id=' + profile.id);
  assert.doesNotMatch(JSON.stringify(shared), /PRIVATE NOTE|recipeId|owner-a/);
});

test('sharing an unset profile opens its nickname sheet and only explicit save creates a profile', async () => {
  let exists = false;
  const {page, calls} = setup({social: {getMine: async () => ({profile: {...profile, exists}, published: []}), saveProfile: async () => { exists = true; }}});
  await page.load(); await page.requestShare();
  assert.equal(page.data.editing, true); assert.equal(exists, false); assert.equal(page.data.shareVisible, false); assert.equal(calls.codes.length, 0);
  page.changeName({detail: {value: '公开昵称'}}); await page.save();
  assert.equal(exists, true); assert.equal(page.data.editing, false); assert.equal(page.data.shareVisible, true);
});

test('an unset profile uses the generated public name as its editable draft without reading a private nickname', async () => {
  const generated = {...profile, name: '小胡萝卜1233', exists: false};
  const fixture = setup({social: {getMine: async () => ({profile: generated, published: []})}});
  fixture.changeState({recipes: [], logs: [], baby: {nickname: 'PRIVATE BABY', birthday: '2025-01-01'}});
  await fixture.page.load();
  assert.equal(fixture.page.data.profile.name, generated.name);
  assert.equal(fixture.page.data.name, generated.name);
  assert.equal(fixture.page.data.profile.exists, false);
  assert.deepEqual(fixture.calls.saved, []);
  assert.equal(fixture.page.onShareAppMessage().path, '/pages/home/index');
  fixture.page.edit();
  assert.equal(fixture.page.data.editing, true); assert.equal(fixture.page.data.name, generated.name);
  fixture.page.changeName({detail: {value: '未保存的昵称'}}); fixture.page.cancelEdit(); fixture.page.edit();
  assert.equal(fixture.page.data.name, generated.name);
  assert.deepEqual(fixture.calls.saved, []); assert.deepEqual(fixture.calls.codes, []);
});

test('explicit save can keep the generated public name without uploading private baby fields', async () => {
  let current = {...profile, name: '小胡萝卜1233', exists: false};
  const saved = [];
  const fixture = setup({social: {
    getMine: async () => ({profile: current, published: []}),
    saveProfile: async value => {
      saved.push(clone(value)); current = {...current, ...value, exists: true};
      return {profile: current};
    }
  }});
  fixture.changeState({recipes: [], logs: [], baby: {nickname: 'PRIVATE BABY', birthday: '2025-01-01'}});
  await fixture.page.load(); fixture.page.edit(); await fixture.page.save();
  assert.deepEqual(saved, [{name: '小胡萝卜1233', bio: ''}]);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE BABY|birthday|2025-01-01/);
  assert.equal(fixture.page.data.profile.exists, true);
  assert.equal(fixture.page.data.profile.name, '小胡萝卜1233');
  assert.equal(fixture.page.data.editing, false); assert.deepEqual(fixture.calls.errors, []);
  assert.equal(fixture.page.onShareAppMessage().path, '/pages/profile/index?id=' + profile.id);
});

test('a nonexistent visitor profile remains unavailable instead of falling back to an own generated profile', async () => {
  let publicReads = 0;
  const fixture = setup({pageName: 'profile', loadOptions: {id: profile.id, edit: '1'}, social: {
    getProfile: async () => { publicReads++; throw Object.assign(Error('主页不存在'), {code: 'PROFILE_NOT_FOUND'}); }
  }});
  await fixture.page.load(); fixture.page.edit(); await fixture.page.save();
  assert.equal(publicReads, 1); assert.equal(fixture.calls.mine, 0);
  assert.equal(fixture.page.data.profile, null); assert.equal(fixture.page.data.isSelf, false);
  assert.equal(fixture.page.data.editing, false); assert.equal(fixture.page.data.error, '主页不存在');
  assert.deepEqual(fixture.page.data.recipes, []); assert.deepEqual(fixture.page.data.logs, []);
  assert.deepEqual(fixture.calls.saved, []); assert.deepEqual(fixture.calls.codes, []);
  assert.equal(fixture.page.onShareAppMessage().path, '/pages/home/index');
});

test('failed public reads retain the local cookbook with unknown visibility and cannot mislabel it private', async () => {
  let reads = 0;
  const {page} = setup({social: {getMine: async () => { if (++reads === 1) throw Error('暂时离线'); return {profile, published: []}; }}});
  await page.load(); assert.equal(page.data.error, ''); assert.equal(page.data.publicationError, '暂时离线');
  assert.equal(page.data.recipes.length, 2); assert.ok(page.data.recipes.every(r => r.visibility === 'unknown'));
  page.changeVisibility(tap('private')); assert.equal(page.data.recipes.length, 0);
  await page.reload(); assert.equal(page.data.publicationError, ''); assert.equal(page.data.recipes.length, 2);
});

test('newer reads win and late old-account responses cannot refill private content after a switch', async () => {
  const first = deferred(), second = deferred(); let reads = 0;
  const f = setup({social: {getMine: () => ++reads === 1 ? first.promise : second.promise}});
  const a = f.page.load(), b = f.page.load(); second.resolve({profile: {...profile, name: '最新'}, published: []}); await b;
  first.resolve({profile, published: []}); await a; assert.equal(f.page.data.profile.name, '最新');
  f.page.changeContentTab(tap('records')); assert.equal(f.page.data.logs.length, 1);
  f.changeOwner('owner-b'); f.page.refresh(); f.page.requestShare(); f.page.openLog({currentTarget:{dataset:{id:'log'}}});
  assert.equal(f.page.data.logs.length, 0); assert.equal(f.page.data.recipes.length, 0); assert.equal(f.page.data.recipeCount, 0);
  assert.equal(f.page.data.isSelf, false); assert.equal(f.page.data.profile, null); assert.equal(f.page.published.length, 0);
  assert.match(f.page.data.error, /账号已切换/); assert.deepEqual(f.calls.routes, []);
});

test('A to B to A stays locked until reload, and unload removes the account subscription', async () => {
  const pending = deferred(); let reads = 0;
  const f = setup({social:{getMine: () => ++reads === 1 ? pending.promise : Promise.resolve({profile, published: []})}});
  const task = f.page.load(); f.changeOwner('owner-b'); f.changeOwner('owner-a');
  await f.page.load(); assert.equal(reads, 1); await f.page.reload(); pending.reject(Error('old')); await task;
  assert.equal(f.page.data.error, ''); assert.equal(f.page.data.recipeCount, 2);
  f.page.onUnload(); const updates = f.calls.updates; f.page.refresh(); assert.equal(f.calls.updates, updates); assert.equal(f.listeners.size, 0);
});

test('backend account mismatches clear private content and disabled social still allows the local profile', async () => {
  const f = setup({social:{getMine: async () => { throw Object.assign(Error('changed'), {code:'ACCOUNT_CHANGED'}); }}});
  await f.page.load(); assert.equal(f.page.data.recipes.length, 0); assert.match(f.page.data.error, /账号已切换/);
  const local = setup({socialEnabled: false}); await local.page.onShow();
  assert.equal(local.calls.mine, 0); assert.equal(local.page.data.recipeCount, 2); assert.equal(local.page.data.profile.exists, false);
  await local.page.requestShare(); assert.equal(local.calls.codes.length, 0);
});

test('malformed public-state responses stay unknown and cannot turn existing recipes into private ones', async () => {
  for (const published of [undefined, null, {}, [{id:'not-a-source-id'}]]) {
    const {page} = setup({social:{getMine: async () => ({profile, published})}});
    await page.load(); assert.equal(page.data.publicationReady, false);
    assert.ok(page.data.recipes.every(r => r.visibility === 'unknown'));
    page.changeVisibility(tap('private')); assert.equal(page.data.recipes.length, 0); assert.equal(page.data.privateCount, 0);
  }
});

test('an old account save cannot invalidate or alter the replacement account after explicit reload', async t => {
  for (const fails of [false, true]) await t.test(fails ? 'late rejection' : 'late success', async () => {
    const pending = deferred(); let reads = 0;
    const f = setup({social:{getMine: async () => ({profile:{...profile, name: ++reads === 1 ? 'A' : 'B'}, published:[]}), saveProfile: () => pending.promise}});
    await f.page.load(); f.page.edit(); const saving = f.page.save(); f.changeOwner('owner-b'); await f.page.reload();
    const updates = f.calls.updates;
    if (fails) pending.reject(Object.assign(Error('old owner'), {code:'ACCOUNT_CHANGED'})); else pending.resolve({});
    await saving;
    assert.equal(f.page.data.profile.name, 'B'); assert.equal(f.page.data.error, ''); assert.equal(f.page.accountSession.changed, false);
    assert.equal(f.calls.updates, updates); assert.equal(reads, 2); assert.equal(f.page.data.saving, false);
  });
});

test('mine and visitor views derive the same avatar without writing an avatar into the public profile', async () => {
  let current = {...profile, id: '0'.repeat(31) + '1', exists: false};
  const saved = [];
  const mine = setup({social: {
    getMine: async () => ({profile: current, published: []}),
    saveProfile: async value => { saved.push(clone(value)); current = {...current, ...value, exists: true}; return {profile: current}; }
  }});
  const avatar = getProfileAvatar(current.id);
  await mine.page.load(); assert.equal(mine.page.data.avatarPath, avatar);
  mine.page.edit(); mine.page.changeName({detail: {value: '改过的公开昵称'}}); await mine.page.save();
  assert.equal(mine.page.data.avatarPath, avatar); assert.equal(mine.page.data.profile.exists, true);
  assert.deepEqual(saved, [{name: '改过的公开昵称', bio: ''}]);
  assert.equal(Object.hasOwn(mine.page.data.profile, 'avatarPath'), false);
  const visitor = setup({pageName: 'profile', loadOptions: {id: current.id}, social: {
    getProfile: async () => ({profile: current, isSelf: false, recipes: [], nextOffset: null})
  }});
  await visitor.page.load(); assert.equal(visitor.page.data.avatarPath, avatar);
  await mine.page.onShow(); await visitor.page.onShow();
  assert.equal(mine.page.data.avatarPath, avatar); assert.equal(visitor.page.data.avatarPath, avatar);
});

test('profile switching clears the old avatar immediately and stale reads cannot replace a newer avatar', async () => {
  const firstProfile = {...profile, id: '0'.repeat(31) + '1'}, secondProfile = {...profile, id: '0'.repeat(31) + '2'};
  const pending = deferred(), latest = deferred(); let reads = 0;
  const f = setup({pageName: 'profile', loadOptions: {id: firstProfile.id}, social: {
    getProfile: () => ++reads === 1 ? Promise.resolve({profile: firstProfile, isSelf: false, recipes: []}) :
      reads === 2 ? pending.promise : latest.promise
  }});
  await f.page.load(); assert.equal(f.page.data.avatarPath, getProfileAvatar(firstProfile.id));
  f.page.profileId = secondProfile.id;
  const older = f.page.load(); assert.equal(f.page.data.avatarPath, getProfileAvatar());
  const newer = f.page.load();
  latest.resolve({profile: secondProfile, isSelf: false, recipes: []}); await newer;
  pending.resolve({profile: firstProfile, isSelf: false, recipes: []}); await older;
  assert.equal(f.page.data.avatarPath, getProfileAvatar(secondProfile.id));
  assert.equal(f.page.data.profile.id, secondProfile.id);
});

test('unavailable profiles and invalid IDs cannot retain the previous account avatar', async () => {
  let fail = false;
  const f = setup({social: {getMine: async () => {
    if (fail) throw Error('离线'); return {profile: {...profile, id: '0'.repeat(31) + '3'}, published: []};
  }}});
  await f.page.load(); assert.notEqual(f.page.data.avatarPath, getProfileAvatar());
  fail = true; await f.page.load(); assert.equal(f.page.data.profile, null);
  assert.equal(f.page.data.avatarPath, getProfileAvatar());
  for (const id of [undefined, '', 'private-owner', 'x'.repeat(32)]) {
    const invalid = setup({social: {getMine: async () => ({profile: {...profile, id}, published: []})}});
    await invalid.page.load(); assert.equal(invalid.page.data.avatarPath, getProfileAvatar());
  }
});

test('switching account clears its avatar and A to B to A cannot revive an outstanding avatar response', async () => {
  const original = {...profile, id: '0'.repeat(31) + '0'}, replacement = {...profile, id: '0'.repeat(31) + '2'};
  const pending = deferred(); let reads = 0;
  const f = setup({social: {getMine: () => ++reads === 1 ? Promise.resolve({profile: original, published: []}) :
    reads === 2 ? pending.promise : Promise.resolve({profile: replacement, published: []})}});
  await f.page.load(); assert.equal(f.page.data.avatarPath, getProfileAvatar(original.id));
  const old = f.page.load(); f.changeOwner('owner-b'); f.changeOwner('owner-a');
  assert.equal(f.page.data.avatarPath, getProfileAvatar());
  pending.resolve({profile: original, published: []}); await old;
  assert.equal(f.page.data.avatarPath, getProfileAvatar()); assert.equal(f.page.data.profile, null);
  await f.page.reload(); assert.equal(f.page.data.avatarPath, getProfileAvatar(replacement.id));
  f.changeOwner('owner-b', false); f.page.refresh();
  assert.equal(f.page.data.avatarPath, getProfileAvatar()); assert.equal(f.page.data.profile, null);
});

test('refreshing the same confirmed profile keeps its avatar while the response is pending', async t => {
  for (const visitor of [false, true]) await t.test(visitor ? 'visitor profile' : 'mine', async () => {
    const current = {...profile, id: '0'.repeat(31) + '1'};
    const pending = deferred(); let reads = 0;
    const response = value => visitor ? {profile: value, isSelf: false, recipes: [], nextOffset: null} : {profile: value, published: []};
    const read = () => ++reads === 1 ? Promise.resolve(response(current)) : pending.promise;
    const f = setup({pageName: visitor ? 'profile' : 'mine', loadOptions: visitor ? {id: current.id} : {}, social: visitor ? {getProfile: read} : {getMine: read}});
    await f.page.load();
    const avatar = f.page.data.avatarPath; assert.notEqual(avatar, getProfileAvatar());
    const refreshing = f.page.onShow();
    assert.equal(f.page.data.loading, true); assert.equal(f.page.data.avatarPath, avatar);
    pending.resolve(response({...current, name: '更新后的公开昵称'})); await refreshing;
    assert.equal(f.page.data.loading, false); assert.equal(f.page.data.avatarPath, avatar);
    assert.equal(f.page.data.profile.name, '更新后的公开昵称');
  });
});
