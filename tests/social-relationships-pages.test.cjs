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
  let owner = 'owner-a', now = Date.now();
  class ClockDate extends Date { static now() { return now; } }
  const listeners = new Set();
  const calls = {errors: [], toasts: [], routes: [], updates: 0, refreshStops: 0};
  const store = {getAllergyFilterEnabled: () => false, getState: () => ({recipes: [], logs: []}), getSyncInfo: () => ({owner}), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  const wx = {
    showToast(value) { calls.toasts.push(value.title); },
    navigateTo(value) { calls.routes.push(value.url); }, switchTab(value) { calls.routes.push(value.url); },
    showShareMenu() {}, hideShareMenu() {}, stopPullDownRefresh() { calls.refreshStops++; }
  };
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {
    module: accountModule, wx, require() { return store; }
  });
  let definition;
  evaluatePage(name, {
    Page(value) { definition = value; }, wx, Date: ClockDate,
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
  return {page, calls, advance(milliseconds) { now += milliseconds; }, changeOwner(value, notify = true) { owner = value; if (notify) listeners.forEach(fn => fn()); }};
}

test('following pages retain pagination across long returns until a write or manual refresh', async () => {
  let version = 1; const reads = [];
  const fixture = setup('following', {getReadVersion: () => version, getFollowing: async (offset, options) => {
    reads.push({offset, options}); return {profiles: [offset ? second : friend], nextOffset: offset ? null : 20};
  }}, {tab: 'people'});
  await fixture.page.onShow(); await fixture.page.loadMore(); await fixture.page.onShow();
  assert.equal(reads.length, 2); assert.equal(fixture.page.data.profiles.length, 2);
  assert.equal(fixture.page.data.nextOffset, null); assert.equal(fixture.page.data.loading, false);
  for (const elapsed of [30001, 3600000, 86400000]) {
    fixture.advance(elapsed); await fixture.page.onShow();
    assert.equal(reads.length, 2); assert.equal(fixture.page.data.profiles.length, 2);
  }
  version++; await fixture.page.onShow(); assert.equal(reads.length, 3);
  await fixture.page.onPullDownRefresh(); assert.equal(reads[3].options.force, true);
  assert.equal(fixture.calls.refreshStops, 1);
  fixture.advance(30001); await fixture.page.onShow(); assert.equal(reads.length, 4);
  fixture.changeOwner('owner-b', false); await fixture.page.onShow();
  assert.equal(reads.length, 4); assert.equal(fixture.page.data.profiles.length, 0);
});

test('following people preserve custom-avatar fallbacks across reloads and ignore stale errors', async () => {
  let avatarURL = 'https://example.test/first-avatar.png';
  const fixture = setup('following', {getFollowing: async () => ({profiles: [{...friend, avatarURL}], nextOffset: null})}, {tab: 'people'});
  const {page} = fixture;
  const error = url => ({currentTarget: {dataset: {id: friend.id, url}}});
  await page.load(); assert.equal(page.data.profiles[0].avatar, avatarURL);
  page.profileAvatarError(error(avatarURL)); assert.equal(page.data.profiles[0].avatar, getProfileAvatar(friend.id));
  await page.reload(); assert.equal(page.data.profiles[0].avatar, getProfileAvatar(friend.id));
  const previous = avatarURL; avatarURL = 'https://example.test/next-avatar.png';
  await page.reload(); assert.equal(page.data.profiles[0].avatar, avatarURL);
  page.profileAvatarError(error(previous)); assert.equal(page.data.profiles[0].avatar, avatarURL);
  page.profileAvatarError(error(avatarURL)); fixture.changeOwner('owner-b'); await page.reload();
  assert.equal(page.data.profiles[0].avatar, avatarURL);
});

test('feed custom-avatar failures update the source list so filtering and ordinary returns cannot revive broken images', async () => {
  let avatarURL = 'https://example.test/feed-avatar.png';
  const image = {id: 'recipe', profileId: friend.id, authorName: friend.name, name: '南瓜饭', ingredients: [{name: '南瓜'}]};
  const {page} = setup('following', {getFeed: async () => ({recipes: [{...image, authorAvatarURL: avatarURL}], nextCursor: null})});
  const error = url => ({currentTarget: {dataset: {id: friend.id, url}}});
  await page.load(); assert.equal(page.data.recipes[0].authorAvatar, avatarURL);
  page.feedAvatarError(error(avatarURL)); page.refreshAllergies(); await page.onShow();
  assert.equal(page.data.recipes[0].authorAvatar, getProfileAvatar(friend.id));
  await page.reload(); assert.equal(page.data.recipes[0].authorAvatar, getProfileAvatar(friend.id));
  const previous = avatarURL; avatarURL = 'https://example.test/new-feed-avatar.png';
  await page.reload(); page.feedAvatarError(error(previous));
  assert.equal(page.data.recipes[0].authorAvatar, avatarURL);
});

test('visitor profiles retain recipe pagination and refresh only after changes or a pull-down', async () => {
  let version = 1; const reads = [];
  const fixture = setup('profile', {getReadVersion: () => version, getProfile: async (id, offset, options) => {
    reads.push({offset, options});
    return {profile: friend, isSelf: false, recipes: [{id: offset ? 'second' : 'first'}], nextOffset: offset ? null : 20};
  }}, {id: friend.id});
  await fixture.page.onShow(); await fixture.page.loadMore();
  for (const elapsed of [30001, 3600000, 86400000]) {
    fixture.advance(elapsed); await fixture.page.onShow();
    assert.equal(reads.length, 2);
    assert.deepEqual(fixture.page.data.recipes.map(recipe => recipe.id), ['first', 'second']);
    assert.equal(fixture.page.data.nextOffset, null);
  }
  version++; await fixture.page.onShow(); assert.equal(reads.length, 3);
  await fixture.page.onPullDownRefresh(); assert.equal(reads[3].options.force, true);
  assert.equal(fixture.calls.refreshStops, 1);
});

test('following returns share pending loads and pending pull-down refreshes', async () => {
  const first = deferred(), refreshGate = deferred(); let reads = 0;
  const fixture = setup('following', {getReadVersion: () => 1,
    getFollowing: () => ++reads === 1 ? first.promise : refreshGate.promise}, {tab: 'people'});
  const loading = fixture.page.onShow(), revisit = fixture.page.onShow();
  assert.equal(reads, 1); assert.equal(loading, revisit);
  first.resolve({profiles: [friend], nextOffset: null}); await loading;
  const refresh = fixture.page.onPullDownRefresh();
  assert.equal(fixture.page.onPullDownRefresh(), refresh);
  const nextReturn = fixture.page.onShow(); assert.equal(reads, 2);
  refreshGate.resolve({profiles: [second], nextOffset: null});
  await Promise.all([refresh, nextReturn]); assert.equal(fixture.calls.refreshStops, 1);
  assert.deepEqual(fixture.page.data.profiles.map(profile => profile.id), [second.id]);
  fixture.page.setData({followBusyId: second.id}); await fixture.page.onPullDownRefresh();
  assert.equal(reads, 2); assert.equal(fixture.calls.refreshStops, 2);
});

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

test('profile follow works without reading or setting up the current user profile', async () => {
  const {page, calls} = setup('profile', {
    getProfile: async () => ({profile: friend, isSelf: false, following: false, followedBy: true, followerCount: 7, recipes: []}),
    getMine: async () => { throw Error('关注不需要读取本人资料'); },
    saveProfile: async () => { throw Error('关注不应保存资料'); },
    setFollowing: async (id, following) => { assert.equal(id, friend.id); return {following, followedBy: true}; }
  }, {id: friend.id});
  await page.load(); await page.toggleFollow();
  assert.equal(page.data.following, true); assert.equal(page.data.followerCount, 8);
  await page.toggleFollow();
  assert.equal(page.data.following, false); assert.equal(page.data.followerCount, 7);
  assert.equal(page.data.followBusy, false); assert.equal(page.data.editing, false);
  assert.deepEqual(calls.toasts, ['已互相关注', '已取消关注']);
  assert.deepEqual(calls.errors, []); assert.deepEqual(calls.routes, []);
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

test('followers can be followed back without opening profile setup', async () => {
  const {page, calls} = setup('following', {
    getFollowers: async () => ({profiles: [friend], nextOffset: null}),
    getMine: async () => { throw Error('关注不需要读取本人资料'); },
    saveProfile: async () => { throw Error('关注不应保存资料'); },
    setFollowing: async (id, following) => { assert.equal(id, friend.id); return {following, followedBy: true}; }
  }, {tab: 'followers'});
  await page.load(); await page.toggleFollow(tap(friend.id));
  assert.equal(page.data.profiles.length, 1); assert.equal(page.data.profiles[0].following, true);
  assert.equal(page.data.followBusyId, ''); assert.deepEqual(calls.errors, []);
  assert.deepEqual(calls.toasts, ['已互相关注']); assert.deepEqual(calls.routes, []);
  page.openMine(); assert.deepEqual(calls.routes, ['/pages/profile/index']);
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
  await page.load(); await page.reload();
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
