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
const friend = {id: 'a'.repeat(32), name: '朋友的小厨房', bio: '每天做一道好吃的', exists: true};
const second = {...friend, id: 'b'.repeat(32), name: '另一个小厨房'};
const tap = id => ({currentTarget: {dataset: {id}}});

function setup(name, social, options = {}) {
  let owner = 'owner-a';
  const listeners = new Set();
  const calls = {errors: [], toasts: [], routes: [], updates: 0};
  const store = {getState: () => ({recipes: [], logs: []}), getSyncInfo: () => ({owner}), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  const wx = {
    showToast(value) { calls.toasts.push(value.title); },
    navigateTo(value) { calls.routes.push(value.url); }, switchTab(value) { calls.routes.push(value.url); },
    showShareMenu() {}, hideShareMenu() {}
  };
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {
    module: accountModule, wx, require() { return store; }
  });
  let definition;
  evaluatePage(name, {
    Page(value) { definition = value; }, wx,
    require(dep) {
      if (dep.endsWith('/social')) return social;
      if (dep.endsWith('/store')) return store;
      if (dep.endsWith('/profile-poster')) return {remove() {}};
      if (dep.endsWith('/account')) return accountModule.exports;
      if (dep.endsWith('/ui')) return {error(error) { calls.errors.push(error.message); }, back() {}};
      throw Error(dep);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(value) {
    calls.updates++;
    Object.entries(clone(value)).forEach(([key, next]) => {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      let target = this.data;
      parts.slice(0, -1).forEach(part => { target = target[part]; });
      target[parts[parts.length - 1]] = next;
    });
  }};
  page.onLoad(options);
  return {page, calls, changeOwner(value, notify = true) { owner = value; if (notify) listeners.forEach(fn => fn()); }};
}

test('profile counters use server totals rather than the first recipe page', async () => {
  const {page} = setup('profile', {getProfile: async () => ({profile: friend, isSelf: false,
    following: false, followedBy: true, followingCount: 13, followerCount: 7, publishedCount: 45,
    recipes: [{id: 'first'}], nextOffset: 20})}, {id: friend.id});
  await page.load();
  assert.equal(page.data.publishedCount, 45);
  assert.equal(page.data.followingCount, 13);
  assert.equal(page.data.followerCount, 7);
  assert.equal(page.data.followedBy, true);
  assert.equal(page.data.following, false);
});

test('profile follow-back applies confirmed reciprocal state and follower count', async () => {
  const sent = [];
  const {page, calls} = setup('profile', {
    getProfile: async () => ({profile: friend, isSelf: false, following: false, followedBy: true, followerCount: 7, recipes: []}),
    setFollowing: async (id, following) => { sent.push([id, following]); return {following: true, followedBy: true}; }
  }, {id: friend.id});
  await page.load(); await page.toggleFollow();
  assert.deepEqual(sent, [[friend.id, true]]);
  assert.equal(page.data.following, true); assert.equal(page.data.followedBy, true);
  assert.equal(page.data.followerCount, 8);
  assert.deepEqual(calls.toasts, ['已互相关注']);
});

test('missing public profile offers setup without pretending the follow succeeded', async () => {
  const {page, calls} = setup('profile', {
    getProfile: async () => ({profile: friend, isSelf: false, following: false, followedBy: true, followerCount: 7, recipes: []}),
    setFollowing: async () => { throw Object.assign(Error('请设置主页'), {code: 'PROFILE_REQUIRED'}); }
  }, {id: friend.id});
  await page.load(); await page.toggleFollow();
  assert.equal(page.data.needsProfile, true); assert.equal(page.data.following, false);
  assert.equal(page.data.followerCount, 7); assert.equal(page.data.followBusy, false);
  assert.deepEqual(calls.toasts, []); assert.deepEqual(calls.errors, []);
  page.openMine(); assert.deepEqual(calls.routes, ['/pages/profile/index?edit=1']);
});

test('onboarding opens the public nickname form without creating a profile', async () => {
  let saves = 0;
  const {page} = setup('profile', {
    getMine: async () => ({profile: {...friend, exists: false}, followingCount: 0, followerCount: 0}),
    saveProfile: async () => { saves++; }
  }, {edit: '1'});
  await page.load();
  assert.equal(page.data.isSelf, true); assert.equal(page.data.editing, true); assert.equal(saves, 0);
  assert.equal(page.onShareAppMessage().path, '/pages/home/index');
  page.cancelEdit(); await page.load(); assert.equal(page.data.editing, false);
});

test('profile response cannot show the previous account after an unnotified account switch', async () => {
  const pending = deferred();
  const fixture = setup('profile', {getProfile: () => pending.promise}, {id: friend.id});
  const task = fixture.page.load();
  fixture.changeOwner('owner-b', false);
  pending.resolve({profile: friend, isSelf: false, recipes: [], followerCount: 9}); await task;
  assert.equal(fixture.page.data.profile, null); assert.equal(fixture.page.data.followerCount, 0);
  assert.match(fixture.page.data.error, /账号已切换/);
});

test('own relationship counters navigate to the right list and visitor counters do not', async () => {
  const {page, calls} = setup('profile', {});
  page.setData({isSelf: true}); page.openFollowing(); page.openFollowers();
  page.setData({isSelf: false}); page.openFollowing(); page.openFollowers();
  assert.deepEqual(calls.routes, ['/pages/following/index?tab=people', '/pages/following/index?tab=followers']);
});

test('followers deep link paginates across empty filtered pages and deduplicates profiles', async () => {
  const offsets = [];
  const {page} = setup('following', {getFollowers: async offset => {
    offsets.push(offset);
    if (offset === 0) return {profiles: [], nextOffset: 20};
    if (offset === 20) return {profiles: [{...friend, following: false, followedBy: true}], nextOffset: 40};
    return {profiles: [friend, second], nextOffset: null};
  }}, {tab: 'followers'});
  await page.load(); assert.equal(page.data.profiles.length, 0); assert.equal(page.data.nextOffset, 20);
  await page.loadMore(); await page.loadMore();
  assert.deepEqual(offsets, [0, 20, 40]); assert.equal(page.data.profiles.length, 2);
  assert.equal(page.data.profiles[0].followedBy, true); assert.equal(page.data.nextOffset, null);
});

test('following and follower rows derive stable avatars on every page without changing server profiles', async t => {
  const original = Object.freeze({...friend, avatar: 'https://untrusted.example/avatar'});
  for (const tab of ['people', 'followers']) await t.test(tab, async () => {
    const read = async offset => offset === 0 ? {profiles: [original], nextOffset: 20}
      : {profiles: [original, Object.freeze({...second})], nextOffset: null};
    const {page} = setup('following', {getFollowing: read, getFollowers: read}, {tab});
    await page.load(); await page.loadMore();
    assert.equal(page.data.profiles.length, 2);
    assert.equal(page.data.profiles[0].avatar, getProfileAvatar(friend.id));
    assert.equal(page.data.profiles[1].avatar, getProfileAvatar(second.id));
    assert.equal(original.avatar, 'https://untrusted.example/avatar');
    assert.equal(page.data.profiles[0].following, tab === 'people');
    assert.equal(page.data.profiles[0].followedBy, tab === 'followers');
  });
});

test('following feed authors use the same account avatar across recipe pages and fallback safely for absent IDs', async () => {
  const first = Object.freeze({id: 'recipe-a', profileId: friend.id, authorName: '原昵称'});
  const later = Object.freeze({id: 'recipe-b', profileId: friend.id, authorName: '新昵称'});
  const {page, calls} = setup('following', {getFeed: async cursor => cursor
    ? {recipes: [later, {id: 'recipe-c', authorName: '暂无主页'}], nextCursor: null}
    : {recipes: [first], nextCursor: 'next-page'}});
  await page.load(); await page.loadMore();
  assert.equal(page.data.recipes.length, 3);
  assert.equal(page.data.recipes[0].authorAvatar, getProfileAvatar(friend.id));
  assert.equal(page.data.recipes[1].authorAvatar, getProfileAvatar(friend.id));
  assert.equal(page.data.recipes[2].authorAvatar, '/assets/cute/pocket-mascot.png');
  assert.equal(first.authorAvatar, undefined); assert.equal(later.authorAvatar, undefined);
  page.openProfile(tap(friend.id));
  assert.deepEqual(calls.routes, ['/pages/profile/index?id=' + friend.id]);
});

test('one-tap follow-back blocks repeated taps and tab changes while pending', async () => {
  const pending = deferred(); let writes = 0;
  const {page, calls} = setup('following', {
    getFollowers: async () => ({profiles: [{...friend, following: false, followedBy: true}], nextOffset: null}),
    setFollowing: (id, following) => { writes++; assert.equal(id, friend.id); assert.equal(following, true); return pending.promise; }
  }, {tab: 'followers'});
  await page.load();
  const task = page.toggleFollow(tap(friend.id));
  await page.toggleFollow(tap(friend.id)); page.changeTab({detail: {value: 'people'}});
  assert.equal(writes, 1); assert.equal(page.data.tab, 'followers');
  assert.equal(page.data.profiles[0].following, false);
  pending.resolve({following: true, followedBy: true}); await task;
  assert.equal(page.data.profiles[0].following, true); assert.equal(page.data.followBusyId, '');
  assert.deepEqual(calls.toasts, ['已互相关注']); assert.deepEqual(calls.routes, []);
});

test('unfollowing reloads the outgoing list so shifted pagination cannot skip a person', async () => {
  const offsets = []; let removed = false;
  const {page} = setup('following', {
    getFollowing: async offset => { offsets.push(offset); return removed ? {profiles: [second], nextOffset: null} : {profiles: [friend], nextOffset: 20}; },
    setFollowing: async (id, following) => { assert.equal(following, false); removed = true; return {following: false, followedBy: false}; }
  }, {tab: 'people'});
  await page.load(); await page.toggleFollow(tap(friend.id));
  assert.deepEqual(offsets, [0, 0]); assert.equal(page.data.profiles[0].id, second.id);
  assert.equal(page.data.followBusyId, ''); assert.equal(page.data.nextOffset, null);
});

test('followers missing-profile failure retains rows and offers setup', async () => {
  const {page, calls} = setup('following', {
    getFollowers: async () => ({profiles: [friend], nextOffset: null}),
    setFollowing: async () => { throw Object.assign(Error('请先设置主页'), {code: 'PROFILE_REQUIRED'}); }
  }, {tab: 'followers'});
  await page.load(); await page.toggleFollow(tap(friend.id));
  assert.equal(page.data.profiles.length, 1); assert.equal(page.data.profiles[0].following, false);
  assert.equal(page.data.needsProfile, true); assert.equal(page.data.followBusyId, '');
  page.openMine(); assert.deepEqual(calls.routes, ['/pages/profile/index?edit=1']);
});

test('pending follow-back cannot restore rows or notify after account switch', async () => {
  const pending = deferred();
  const fixture = setup('following', {
    getFollowers: async () => ({profiles: [friend], nextOffset: null}),
    setFollowing: () => pending.promise
  }, {tab: 'followers'});
  await fixture.page.load(); const task = fixture.page.toggleFollow(tap(friend.id));
  fixture.changeOwner('owner-b'); pending.resolve({following: true, followedBy: true}); await task;
  assert.equal(fixture.page.data.profiles.length, 0); assert.equal(fixture.page.data.followBusyId, '');
  assert.deepEqual(fixture.calls.toasts, []); assert.match(fixture.page.data.error, /账号已切换/);
});

test('pending list mutation has no UI effects after unload', async () => {
  const pending = deferred();
  const {page, calls} = setup('following', {
    getFollowers: async () => ({profiles: [friend], nextOffset: null}), setFollowing: () => pending.promise
  }, {tab: 'followers'});
  await page.load(); const task = page.toggleFollow(tap(friend.id)); page.onUnload();
  const updates = calls.updates;
  pending.reject(Error('暂时失败')); await task;
  assert.equal(calls.updates, updates); assert.deepEqual(calls.errors, []); assert.deepEqual(calls.toasts, []);
});

test('feed image failures match the current recipe and URL instead of an index from an older render', async () => {
  let reads = 0;
  const oldURL = 'https://example.test/old-signature', currentURL = 'https://example.test/current-signature';
  const cover = '/assets/food/carrot-chicken.jpg';
  const {page, calls} = setup('following', {getFeed: async () => ({recipes: ++reads === 1
    ? [{id: 'first', photoURL: oldURL}]
    : [{id: 'replacement', displayPhoto: cover}, {id: 'first', photoURL: currentURL}], nextCursor: null})});
  const error = (id, url, index = 0) => ({currentTarget: {dataset: {id, url, index}}});
  await page.load(); await page.onShow();
  const updates = calls.updates;
  page.photoError(error('first', oldURL));
  page.photoError(error('gone', cover));
  assert.equal(calls.updates, updates);
  assert.equal(page.data.recipes[0].displayPhoto, cover);
  assert.equal(page.data.recipes[1].photoURL, currentURL);
  page.photoError(error('first', currentURL));
  assert.equal(page.data.recipes[0].displayPhoto, cover);
  assert.equal(page.data.recipes[1].photoURL, '');
  page.photoError(error('replacement', cover));
  assert.equal(page.data.recipes[0].displayPhoto, '');
});

test('feed image errors after an account change or unload cannot update the old content', async t => {
  const image = {id: 'first', photoURL: 'https://example.test/photo'};
  const event = {currentTarget: {dataset: {id: image.id, url: image.photoURL, index: 0}}};
  await t.test('unnotified account switch', async () => {
    const fixture = setup('following', {getFeed: async () => ({recipes: [image], nextCursor: null})});
    await fixture.page.load(); fixture.changeOwner('owner-b', false); fixture.page.photoError(event);
    assert.deepEqual(fixture.page.data.recipes, []);
    assert.match(fixture.page.data.error, /账号已切换/);
  });
  await t.test('unloaded page', async () => {
    const {page, calls} = setup('following', {getFeed: async () => ({recipes: [image], nextCursor: null})});
    await page.load(); page.onUnload(); const updates = calls.updates;
    page.photoError(event);
    assert.equal(calls.updates, updates);
    assert.equal(page.data.recipes[0].photoURL, image.photoURL);
  });
});
