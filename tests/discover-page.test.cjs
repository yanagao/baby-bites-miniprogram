'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const recipe = {id: 'a'.repeat(64), profileId: 'b'.repeat(32), name: '南瓜小米粥', authorName: '小米的小厨房',
  ingredients: [{name: '南瓜'}], category: '粥', minutes: 15, texture: '细腻', photoURL: 'https://example.test/first'};
const second = {...recipe, id: 'c'.repeat(64), name: '南瓜蛋羹'};
const eventValue = value => ({detail: {value}});
const tap = id => ({currentTarget: {dataset: {id}}});

function setup(social) {
  let owner = 'owner-a';
  const listeners = new Set();
  const calls = {routes: [], syncs: 0, updates: 0, refreshStops: 0};
  const store = {getSyncInfo: () => ({owner}), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  const wx = {navigateTo(value) { calls.routes.push(value.url); }, hideShareMenu() {}, stopPullDownRefresh() { calls.refreshStops++; }};
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {
    module: accountModule, wx, require() { return store; }
  });
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/discover/index.js'), 'utf8'), {
    Page(value) { definition = value; }, wx,
    require(dep) {
      if (dep.endsWith('/social')) return social;
      if (dep.endsWith('/account')) return accountModule.exports;
      if (dep.endsWith('/tab-bar')) return {syncTabBar() { calls.syncs++; }};
      throw Error(dep);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(value) {
    calls.updates++;
    for (const [key, item] of Object.entries(clone(value))) {
      const nested = key.match(/^recipes\[(\d+)\]\.photoURL$/);
      if (nested) this.data.recipes[Number(nested[1])].photoURL = item;
      else this.data[key] = item;
    }
  }};
  page.onLoad();
  return {page, calls, changeOwner(value, notify = true) { owner = value; if (notify) listeners.forEach(fn => fn()); }};
}

test('latest queries public discovery and de-duplicates within and across pages', async () => {
  const queries = [];
  const {page} = setup({getDiscover: async options => {
    queries.push({...options});
    return options.cursor ? {recipes: [recipe, second, second], nextCursor: null} : {recipes: [recipe, recipe], nextCursor: 'page-two'};
  }});
  await page.changeTab(eventValue('latest'));
  assert.equal(page.data.recipes.length, 1);
  await page.loadMore();
  assert.deepEqual(queries, [{search: '', cursor: undefined}, {search: '', cursor: 'page-two'}]);
  assert.deepEqual(page.data.recipes.map(item => item.id), [recipe.id, second.id]);
  assert.equal(page.data.nextCursor, null);
});

test('search is explicit, uses server search for every page, and clear returns to latest', async () => {
  const queries = [];
  const {page} = setup({getDiscover: async options => {
    queries.push({...options}); return {recipes: [recipe], nextCursor: 'matched-page'};
  }});
  await page.load();
  page.searchInput(eventValue('  小米  '));
  assert.equal(queries.length, 1);
  assert.equal(page.data.recipes.length, 1);
  assert.equal(page.data.query, '');
  await page.submitSearch(); await page.loadMore();
  assert.deepEqual(queries.slice(1), [{search: '小米', cursor: undefined}, {search: '小米', cursor: 'matched-page'}]);
  await page.clearSearch();
  assert.equal(page.data.query, ''); assert.equal(page.data.search, '');
  assert.deepEqual(queries.at(-1), {search: '', cursor: undefined});
});

test('following uses its full feed while global search switches to latest without filtering a partial feed', async () => {
  const feedCursors = []; let discovery = 0;
  const {page, calls} = setup({getDiscover: async () => { discovery++; return {recipes: [], nextCursor: null}; },
    getFeed: async cursor => { feedCursors.push(cursor); return {recipes: [recipe], nextCursor: cursor ? null : 'feed-page'}; }});
  await page.submitSearch(eventValue('小米'));
  await page.changeTab(eventValue('following'));
  assert.equal(page.data.query, ''); assert.equal(page.data.search, ''); assert.equal(discovery, 1);
  await page.loadMore(); assert.deepEqual(feedCursors, [undefined, 'feed-page']);
  page.openFollowing(); assert.deepEqual(calls.routes, ['/pages/following/index?tab=people']);
  page.searchInput(eventValue('南瓜')); assert.equal(page.data.recipes.length, 1);
  await page.submitSearch(eventValue('南瓜'));
  assert.equal(page.data.tab, 'latest'); assert.equal(page.data.query, '南瓜'); assert.equal(discovery, 2);
  assert.deepEqual(feedCursors, [undefined, 'feed-page']);
});

test('recommended mixes real recipe categories and latest preserves publication order', async () => {
  const third = {...recipe, id: 'd'.repeat(64), category: '蒸蛋'}, fourth = {...recipe, id: 'e'.repeat(64), category: '手抓'};
  const incoming = [recipe, second, third, fourth];
  const {page} = setup({getDiscover: async () => ({recipes: incoming, nextCursor: null})});
  await page.load(); assert.equal(page.data.tab, 'recommended');
  assert.deepEqual(page.data.recipes.map(item => item.id), [recipe.id, third.id, fourth.id, second.id]);
  await page.changeTab(eventValue('latest'));
  assert.deepEqual(page.data.recipes.map(item => item.id), incoming.map(item => item.id));
  assert.equal(page.data.recipes.some(item => 'heat' in item || 'likes' in item), false);
});

test('empty search scan pages keep continuation and can reach later matches', async () => {
  const cursors = [];
  const {page} = setup({getDiscover: async ({cursor}) => {
    cursors.push(cursor);
    if (!cursor) return {recipes: [], nextCursor: 'scan-two'};
    if (cursor === 'scan-two') return {recipes: [], nextCursor: 'scan-three'};
    return {recipes: [recipe], nextCursor: null};
  }});
  await page.submitSearch(eventValue('南瓜'));
  assert.equal(page.data.recipes.length, 0); assert.equal(page.data.nextCursor, 'scan-two');
  await page.loadMore(); assert.equal(page.data.nextCursor, 'scan-three');
  await page.loadMore(); assert.equal(page.data.recipes[0].id, recipe.id);
  assert.deepEqual(cursors, [undefined, 'scan-two', 'scan-three']);
});

test('tab changes discard old initial responses and old pagination failures', async () => {
  const initial = deferred(), pagination = deferred(); let discovery = 0;
  const {page} = setup({getDiscover: () => ++discovery === 1 ? initial.promise : pagination.promise,
    getFeed: async () => ({recipes: [second], nextCursor: null})});
  const first = page.load();
  await page.changeTab(eventValue('following'));
  initial.resolve({recipes: [recipe], nextCursor: 'old'}); await first;
  assert.equal(page.data.recipes[0].id, second.id); assert.equal(page.data.nextCursor, null);
  page.setData({tab: 'latest', recipes: [recipe], nextCursor: 'old'});
  const more = page.loadMore();
  await page.changeTab(eventValue('following'));
  pagination.reject(Error('旧分页失败')); await more;
  assert.equal(page.data.recipes[0].id, second.id);
  assert.equal(page.data.loadMoreError, ''); assert.equal(page.data.loadingMore, false);
});

test('a new search invalidates pending pages and binds all following cursors to the new query', async () => {
  const oldPage = deferred(); const queries = [];
  const {page} = setup({getDiscover: options => {
    queries.push({...options});
    if (options.cursor === 'old-page') return oldPage.promise;
    return Promise.resolve({recipes: options.search ? [second] : [recipe], nextCursor: options.search ? null : 'old-page'});
  }});
  await page.load(); const more = page.loadMore();
  await page.submitSearch(eventValue('新菜'));
  oldPage.resolve({recipes: [recipe], nextCursor: 'old-next'}); await more;
  assert.equal(page.data.recipes.length, 1); assert.equal(page.data.recipes[0].id, second.id);
  assert.equal(page.data.nextCursor, null); assert.equal(page.data.query, '新菜');
  assert.deepEqual(queries.at(-1), {search: '新菜', cursor: undefined});
});

test('pagination failures retain rows and cursor for an explicit retry without duplicate requests', async () => {
  const pending = deferred(); let pages = 0;
  const {page} = setup({getDiscover: async ({cursor}) => {
    if (!cursor) return {recipes: [recipe], nextCursor: 'second'};
    if (++pages === 1) return pending.promise;
    return {recipes: [second], nextCursor: null};
  }});
  await page.load(); const task = page.loadMore(); await page.loadMore();
  assert.equal(pages, 1); pending.reject(Error('连接中断')); await task;
  assert.equal(page.data.recipes[0].id, recipe.id); assert.equal(page.data.nextCursor, 'second');
  assert.equal(page.data.error, ''); assert.equal(page.data.loadMoreError, '连接中断');
  await page.onReachBottom(); assert.equal(pages, 1);
  await page.loadMore(); assert.equal(pages, 2); assert.equal(page.data.recipes.length, 2);
  assert.equal(page.data.loadMoreError, ''); assert.equal(page.data.loadingMore, false);
});

test('account changes clear results and block navigation until explicit reload', async () => {
  const pending = deferred(); let attempts = 0;
  const fixture = setup({getDiscover: async () => ++attempts === 1 ? pending.promise : {recipes: [second], nextCursor: null}});
  const task = fixture.page.load(); fixture.changeOwner('owner-b', false);
  pending.resolve({recipes: [recipe], nextCursor: 'a'}); await task;
  assert.equal(fixture.page.data.recipes.length, 0); assert.match(fixture.page.data.error, /账号已切换/);
  fixture.page.openRecipe(tap(recipe.id)); fixture.page.openFollowing();
  assert.deepEqual(fixture.calls.routes, []);
  await fixture.page.reload(); assert.equal(fixture.page.data.recipes[0].id, second.id);
  fixture.page.openRecipe(tap(second.id)); fixture.page.openProfile(tap(second.profileId));
  assert.deepEqual(fixture.calls.routes, ['/pages/public-recipe/index?id=' + second.id, '/pages/profile/index?id=' + second.profileId]);
});

test('a server account mismatch invalidates the session even before the local owner changes', async () => {
  let attempts = 0;
  const {page} = setup({getDiscover: async () => {
    attempts++; throw Object.assign(Error('账号校验失败'), {code: 'ACCOUNT_CHANGED'});
  }});
  await page.load(); await page.load();
  assert.equal(attempts, 1); assert.match(page.data.error, /账号已切换/);
  assert.equal(page.data.loading, false);
});

test('unloaded pages ignore success and failures from pending reads', async t => {
  for (const fail of [false, true]) await t.test(fail ? 'failure' : 'success', async () => {
    const pending = deferred(); const {page, calls} = setup({getDiscover: () => pending.promise});
    const task = page.load(); page.onUnload(); const updates = calls.updates;
    if (fail) pending.reject(Error('暂时失败')); else pending.resolve({recipes: [recipe], nextCursor: null});
    await task; assert.equal(calls.updates, updates);
  });
});

test('on-show refreshes signed photos and ignores failures from an older image', async () => {
  let loads = 0;
  const {page, calls} = setup({getDiscover: async () => ({recipes: [{...recipe, photoURL: ++loads === 1 ? recipe.photoURL : 'https://example.test/refreshed'}], nextCursor: null})});
  await page.onShow(); page.onReady(); await page.onShow();
  assert.equal(loads, 2); assert.equal(calls.syncs, 3);
  page.photoError({currentTarget: {dataset: {id: recipe.id, url: recipe.photoURL}}});
  assert.equal(page.data.recipes[0].photoURL, 'https://example.test/refreshed');
  page.photoError({currentTarget: {dataset: {id: recipe.id, url: 'https://example.test/refreshed'}}});
  assert.equal(page.data.recipes[0].photoURL, '');
});

test('first-load failures offer retry and pull-down stops after either result', async () => {
  let attempts = 0;
  const {page, calls} = setup({getDiscover: async () => {
    if (++attempts === 1) throw Error('暂时离线');
    return {recipes: [recipe], nextCursor: null};
  }});
  await page.onPullDownRefresh(); assert.equal(page.data.error, '暂时离线');
  assert.equal(page.data.loading, false); assert.equal(calls.refreshStops, 1);
  await page.reload(); assert.equal(page.data.error, ''); assert.equal(page.data.recipes.length, 1);
  await page.onPullDownRefresh(); assert.equal(calls.refreshStops, 2);
});
