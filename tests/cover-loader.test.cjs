'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const pumpkin = 'dish:pumpkin-millet';
const broccoli = 'dish:broccoli-potato';
const localSource = key => 'wxfile://usr/recipe-covers-v1/' + key.slice(5) + '.jpg';
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function page(route, data = {}, extra = {}) {
  return {refresh() { assert.fail('Image notifications must not refresh page data'); },
    onShow() { assert.fail('Image notifications must not redraw or reload a page'); },
    load() { assert.fail('Image notifications must not request social data'); },
    ...extra, route: 'pages/' + route + '/index', data: clone(data), changes: [],
    setData(changes) {
      this.changes.push(clone(changes));
      for (const [key, value] of Object.entries(changes)) {
        const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let target = this.data;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts[parts.length - 1]] = clone(value);
      }
    }
  };
}

function appFixture(options = {}) {
  let app, pages = [], owner = options.owner === undefined ? 'account-a' : options.owner;
  const sources = new Map(), listeners = new Set(), work = [], recipes = new Map();
  const calls = {loads: 0, starts: 0, syncs: 0, subscriptions: 0, recipeReads: []};
  const store = {init() {}, subscribe() {}, getSyncInfo: () => ({owner}),
    getRecipe(id) { calls.recipeReads.push(id); if (options.getRecipe) return options.getRecipe(id); return recipes.get(id); }};
  const loader = {isReady() { assert.fail('App must recheck caches even after an earlier success'); },
    getSource: key => sources.get(key) || '',
    subscribe(listener) { calls.subscriptions++; listeners.add(listener); return () => listeners.delete(listener); },
    prepare() {
      calls.loads++;
      if (options.prepare) return options.prepare();
      const item = deferred(); work.push(item); return item.promise;
    }
  };
  const coverModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/recipe-covers.js'), 'utf8'), {
    module: coverModule, require(name) {
      if (name === './cover-loader') return loader;
      if (name === '../data/recipe-cover-catalog') return require('../data/recipe-cover-catalog');
      throw Error('Unexpected cover dependency: ' + name);
    }
  });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
    App(value) { app = value; }, wx: {}, console, getCurrentPages: () => pages,
    require(name) {
      if (name === './utils/store') return store;
      if (name === './utils/cloud-sync') return {start() { calls.starts++; }, getStatus: () => ({state: 'ready'}), syncNow() { calls.syncs++; }};
      if (name === './utils/tdesign-font') return {loadTDesignIcons: () => Promise.resolve('offline')};
      if (name === './utils/cover-loader') return loader;
      if (name === './utils/recipe-covers') return coverModule.exports;
      throw Error('Unexpected app dependency: ' + name);
    }
  });
  return {app, calls, recipes, sources, cover: coverModule.exports,
    show(value) { pages = value ? [value] : []; }, owner(value) { owner = value; },
    emit(key, source = localSource(key)) {
      if (source) sources.set(key, source); else sources.delete(key);
      for (const listener of listeners) listener({key, source});
    },
    async complete(value = true) { await flush(); const pending = app._coverPromise; work.at(-1).resolve(value); return pending; }
  };
}

test('app subscribes once, shares pending work and rechecks caches on every later foreground', async () => {
  const h = appFixture();
  const current = page('home', {recommendations: [{id: 'pumpkin-millet', displayPhoto: ''}]});
  h.show(current);
  h.app.onLaunch(); h.app.onShow();
  await flush();
  assert.equal(h.calls.loads, 1);
  assert.equal(h.calls.subscriptions, 1);
  assert.equal(await h.complete(false), false);
  h.app.onShow(); await flush();
  assert.equal(h.calls.loads, 2);
  h.emit(pumpkin);
  assert.equal(current.data.recommendations[0].displayPhoto, localSource(pumpkin));
  assert.equal(await h.complete(), true);
  h.app.onShow(); await flush();
  assert.equal(h.calls.loads, 3, 'success must not skip revalidation after a cache file disappears');
  h.emit(pumpkin, '');
  assert.equal(current.data.recommendations[0].displayPhoto, '');
  assert.equal(await h.complete(false), false);
  assert.equal(h.calls.subscriptions, 1);
  assert.equal(h.calls.starts, 1);
  assert.equal(h.calls.syncs, 3);
});

test('each file event updates current matching image fields before the full batch completes', async () => {
  const h = appFixture();
  const data = {search: '南瓜', pantry: ['南瓜'], showAllIngredients: true};
  const fields = ['recommendations', 'recipes', 'matches', 'previewMatches', 'completeMatches', 'partialMatches'];
  for (const name of fields) data[name] = [{id: 'pumpkin-millet', displayPhoto: ''}, {id: 'broccoli-potato', displayPhoto: ''}];
  const current = page('ingredients', data);
  h.show(current); h.app.onLaunch(); await flush();
  h.emit(pumpkin);
  for (const name of fields) {
    assert.equal(current.data[name][0].displayPhoto, localSource(pumpkin));
    assert.equal(current.data[name][1].displayPhoto, '');
  }
  assert.deepEqual(Object.keys(current.changes[0]).sort(), fields.map(name => name + '[0].displayPhoto').sort());
  h.emit(broccoli);
  for (const name of fields) assert.equal(current.data[name][1].displayPhoto, localSource(broccoli));
  assert.equal(current.data.search, '南瓜');
  assert.deepEqual(current.data.pantry, ['南瓜']);
  assert.equal(current.data.showAllIngredients, true);
  assert.equal(await h.complete(), true);
  assert.equal(current.changes.length, 2, 'batch completion does not reapply identical values');
});

test('random image events preserve the chosen recipe, all filters and drawing history', async () => {
  const h = appFixture();
  const current = page('random', {result: {id: 'pumpkin-millet', favorite: true, displayPhoto: ''},
    categories: ['粥饭主食'], ageGroups: ['9-11', '12-17'], skipDisliked: false, candidateCount: 4},
  {_sessionOwner: 'account-a', _seenIds: ['older', 'pumpkin-millet']});
  const before = clone(current.data);
  h.show(current); h.app.onLaunch(); await flush();
  h.emit(pumpkin);
  assert.equal(current.data.result.displayPhoto, localSource(pumpkin));
  assert.deepEqual({...current.data, result: {...current.data.result, displayPhoto: ''}}, before);
  assert.deepEqual(current._seenIds, ['older', 'pumpkin-millet']);
  await h.complete();
  assert.equal(current.changes.length, 1);
});

test('record editing receives only the image field and preserves its entire unsaved draft', async () => {
  const h = appFixture();
  const current = page('record-editor', {recipe: {id: 'pumpkin-millet', name: '我的菜谱', displayPhoto: ''},
    note: '尚未保存的备注', rating: 3, date: '2026-10-29', portionIndex: 2, saving: false, discardVisible: true},
  {_draftOwner: 'account-a', initialDraft: 'original-draft'});
  const before = clone(current.data);
  h.show(current); h.app.onLaunch(); await flush(); h.emit(pumpkin);
  assert.equal(current.data.recipe.displayPhoto, localSource(pumpkin));
  assert.deepEqual({...current.data, recipe: {...current.data.recipe, displayPhoto: ''}}, before);
  assert.deepEqual(Object.keys(current.changes[0]), ['recipe.displayPhoto']);
  assert.equal(current.initialDraft, 'original-draft');
  await h.complete();
});

test('profile drafts and public pages get only current picture projections without network or form resets', async () => {
  for (const route of ['mine', 'profile', 'discover', 'following', 'public-recipe']) {
    const h = appFixture();
    const current = page(route, {isSelf: route === 'mine' || route === 'profile', editing: true,
      name: '未保存昵称', bio: '未保存简介', babyBirthDate: '2025-08-31', loadingMore: true, followBusy: true,
      recipe: {id: 'public-id', imageKey: broccoli}, recipes: [{id: 'pumpkin-millet', visibility: 'private'},
        {id: 'custom', photoURL: 'https://example.test/photo', displayPhoto: 'https://example.test/photo'}]},
    {accountSession: {owner: 'account-a'}});
    const before = clone(current.data);
    h.show(current); h.app.onLaunch(); await flush(); h.emit(pumpkin); h.emit(broccoli);
    assert.equal(current.data.recipe.displayPhoto, localSource(broccoli));
    assert.equal(current.data.recipes[0].displayPhoto, localSource(pumpkin));
    delete current.data.recipe.displayPhoto; delete current.data.recipes[0].displayPhoto;
    assert.deepEqual(current.data, before, route);
    await h.complete();
  }
});

test('notifications use the visible page and latest row instead of capturing a prior account or list', async () => {
  const h = appFixture();
  const previous = page('public-recipe', {recipe: {id: 'old', imageKey: pumpkin}}, {accountSession: {owner: 'account-a'}});
  h.show(previous); h.app.onLaunch(); await flush();
  const current = page('discover', {recipes: [{id: 'replaced', imageKey: pumpkin}]}, {accountSession: {owner: 'account-b'}});
  h.owner('account-b'); h.show(current);
  current.data.recipes = [{id: 'latest', imageKey: broccoli}];
  h.emit(pumpkin); h.emit(broccoli);
  assert.equal(previous.changes.length, 0);
  assert.equal(current.data.recipes[0].id, 'latest');
  assert.equal(current.data.recipes[0].displayPhoto, localSource(broccoli));
  await h.complete();
});

test('stale account guards, disposed pages and recipe editors ignore late picture notifications', async () => {
  const cases = [
    page('profile', {recipes: [{id: 'pumpkin-millet'}]}, {accountSession: {owner: 'other-account'}}),
    page('profile', {recipes: [{id: 'pumpkin-millet'}]}, {accountSession: {owner: 'account-a', changed: true}}),
    page('profile', {recipes: [{id: 'pumpkin-millet'}]}, {accountSession: {owner: 'account-a', disposed: true}}),
    page('record-editor', {recipe: {id: 'pumpkin-millet'}}, {_draftOwner: 'other-account'}),
    page('random', {result: {id: 'pumpkin-millet'}}, {_sessionOwner: 'other-account'}),
    page('detail', {recipe: {id: 'pumpkin-millet'}}, {_sessionOwner: 'account-a', _accountLocked: true}),
    page('home', {recommendationOwner: 'other-account', recommendations: [{id: 'pumpkin-millet'}]}),
    page('public-recipe', {recipe: {id: 'pumpkin-millet'}}, {_unloaded: true}),
    page('discover', {recipes: [{id: 'pumpkin-millet'}]}, {_disposed: true}),
    page('editor', {recipe: {id: 'pumpkin-millet'}, note: '保持草稿'}), null
  ];
  for (const current of cases) {
    const h = appFixture(); h.show(current); h.app.onLaunch(); await flush(); h.emit(pumpkin);
    await h.complete();
    if (current) assert.equal(current.changes.length, 0, current.route);
  }
});

test('first account binding does not permanently lock an initially unbound image view', async () => {
  const h = appFixture({owner: ''});
  const current = page('record-editor', {recipe: {id: 'pumpkin-millet', displayPhoto: ''}}, {_draftOwner: ''});
  h.show(current); h.app.onLaunch(); await flush(); h.owner('account-a'); h.emit(pumpkin);
  assert.equal(current.data.recipe.displayPhoto, localSource(pumpkin));
  await h.complete();
});

test('meal logs resolve only current static recipe artwork and preserve user-photo or unknown rows', async () => {
  const h = appFixture();
  h.recipes.set('pumpkin-millet', {id: 'pumpkin-millet'});
  h.recipes.set('own-photo', {id: 'own-photo', imageKey: pumpkin, photo: 'wxfile://usr/private.jpg'});
  h.recipes.set('own-url', {id: 'own-url', imageKey: pumpkin, photoURL: 'https://example.test/private.jpg'});
  h.recipes.set('custom', {id: 'custom', name: '自建菜谱'});
  const current = page('records', {selectedDate: '2026-10-29', filter: '3', logs: [
    {id: 'one', recipeId: 'pumpkin-millet', displayPhoto: '', note: '只保留我原来的备注'},
    {id: 'two', recipeId: 'pumpkin-millet', photoSrc: 'wxfile://usr/existing.jpg', displayPhoto: 'wxfile://usr/existing.jpg'},
    {id: 'three', recipeId: 'own-photo', displayPhoto: 'do-not-copy-from-store'},
    {id: 'four', recipeId: 'own-url', displayPhoto: 'do-not-copy-from-store'},
    {id: 'five', recipeId: 'custom', displayPhoto: ''}, {id: 'six', recipeId: 'removed', displayPhoto: ''}
  ]});
  const before = clone(current.data);
  h.show(current); h.app.onLaunch(); await flush(); h.emit(pumpkin);
  assert.deepEqual(current.changes[0], {'logs[0].displayPhoto': localSource(pumpkin)});
  h.emit(pumpkin, '');
  assert.deepEqual(current.data, before);
  await h.complete(false);
});

test('an account switch while resolving a log recipe prevents publishing any mixed-account fields', async () => {
  let h;
  h = appFixture({getRecipe() { h.owner('account-b'); return {id: 'pumpkin-millet'}; }});
  const current = page('records', {logs: [{id: 'one', recipeId: 'pumpkin-millet', displayPhoto: ''}]});
  h.show(current); h.app.onLaunch(); await flush(); h.emit(pumpkin);
  assert.equal(current.changes.length, 0);
  h.show(null); await h.complete();
});

test('public recipe image failures reset only when a new effective static source becomes available', async () => {
  const h = appFixture();
  const current = page('public-recipe', {recipe: {id: 'public', imageKey: pumpkin, displayPhoto: 'expired'}, photoFailed: true},
    {accountSession: {owner: 'account-a'}});
  h.show(current); h.app.onLaunch(); await flush(); h.emit(pumpkin);
  assert.equal(current.data.photoFailed, false);
  current.data.photoFailed = true;
  h.emit(pumpkin);
  assert.equal(current.data.photoFailed, true, 'the same failed URL does not trigger an endless retry');
  h.emit(pumpkin, '');
  assert.equal(current.data.recipe.displayPhoto, '');
  assert.equal(current.data.photoFailed, true);
  current.data.recipe.photoURL = 'https://example.test/my-photo';
  current.data.recipe.displayPhoto = current.data.recipe.photoURL;
  h.emit(pumpkin);
  assert.equal(current.data.recipe.displayPhoto, 'https://example.test/my-photo');
  assert.equal(current.data.photoFailed, true);
  await h.complete();
});

test('already cached results can resolve immediately but foreground still calls prepare again', async () => {
  const h = appFixture({prepare: () => Promise.resolve(true)});
  const current = page('detail', {recipe: {id: 'pumpkin-millet', displayPhoto: ''}}, {_sessionOwner: 'account-a'});
  h.sources.set(pumpkin, localSource(pumpkin)); h.show(current); h.app.onLaunch();
  await h.app._coverPromise;
  assert.equal(current.data.recipe.displayPhoto, localSource(pumpkin));
  h.app.onShow(); await h.app._coverPromise;
  assert.equal(h.calls.loads, 2);
  assert.equal(current.changes.length, 1);
});
