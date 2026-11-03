'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64), RECIPE = 'c'.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
const save = (id = 'save-1') => ({id, type: 'save', recipeId: RECIPE, recipeName: '南瓜粥', createdAt: 1762099200000, photoURL: '', text: ''});
const snap = () => ({...save('snap-1'), type: 'cooksnap', actorName: '小南瓜', photoURL: 'https://example.test/cooked.jpg', text: '我把南瓜切得更小了'});
function setup() {
  let owner = OWNER, readVersion = 1;
  const listeners = new Set(), calls = {reads: [], navigation: [], images: [], hidden: 0, refreshDone: 0};
  const hooks = {};
  const store = {getSyncInfo: () => ({owner}), subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}};
  const wx = {hideShareMenu() {calls.hidden++;}, navigateTo(value) {calls.navigation.push(value.url);}, previewImage(value) {calls.images.push(value);}, stopPullDownRefresh() {calls.refreshDone++;}};
  const mod = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/profile/account.js'), 'utf8'), {module: mod, wx, require: () => store});
  const social = {getReadVersion: () => readVersion, async getFeedbackInbox(offset, options) {
    calls.reads.push({offset, options});
    return hooks.read ? hooks.read(offset, options) : {saveCount: 1, cooksnapCount: 1, items: [save(), snap()], nextOffset: null};
  }};
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/feedback/index.js'), 'utf8'), {
    wx, Page(value) {definition = value;}, require(name) {
      if (name.endsWith('/social')) return social;
      if (name.endsWith('/account')) return mod.exports;
      if (name.endsWith('/ui')) return {back() {}};
      throw Error(name);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(value) {Object.assign(this.data, clone(value));}};
  page.onLoad();
  return {page, calls, hooks, changeOwner(value) {owner = value; listeners.forEach(fn => fn());}, invalidate() {readVersion++;}, listeners};
}
test('inbox shows actual save and cooksnap feedback without creating or sharing content', async () => {
  const {page, calls} = setup();
  assert.equal(page.data.saveCount, null);
  await page.onShow();
  assert.equal(page.data.saveCount, 1); assert.equal(page.data.cooksnapCount, 1);
  assert.equal(page.data.items[1].text, snap().text);
  assert.equal(page.onShareAppMessage, undefined); assert.equal(calls.hidden, 1);
});
test('inbox reuses recent results and refreshes after cache invalidation or manual refresh', async () => {
  const app = setup(); await app.page.onShow(); app.page.onHide(); await app.page.onShow();
  assert.equal(app.calls.reads.length, 1);
  app.invalidate(); await app.page.onShow(); assert.equal(app.calls.reads.length, 2);
  await app.page.onPullDownRefresh(); assert.equal(app.calls.reads.length, 3);
  assert.equal(app.calls.reads[2].options.force, true); assert.equal(app.calls.refreshDone, 1);
});
test('failed initial read does not fabricate zero feedback and permits retry', async () => {
  const app = setup(); app.hooks.read = async () => {throw Error('断网');};
  await app.page.onShow(); assert.equal(app.page.data.error, '断网');
  assert.equal(app.page.data.saveCount, null); assert.equal(app.page.data.items.length, 0);
  delete app.hooks.read; await app.page.reload(); assert.equal(app.page.data.error, '');
});
test('pending inbox read cannot restore previous account content after an account switch and return', async () => {
  const app = setup(), deferred = pending(); app.hooks.read = () => deferred.promise;
  const work = app.page.onShow(); app.changeOwner(OTHER); app.changeOwner(OWNER);
  deferred.resolve({saveCount: 1, cooksnapCount: 0, items: [save()], nextOffset: null}); await work;
  assert.equal(app.page.data.items.length, 0); assert.equal(app.page.data.saveCount, null);
  assert.match(app.page.data.error, /账号已切换/);
});
test('hidden and unloaded inboxes ignore late requests', async () => {
  for (const lifecycle of ['onHide', 'onUnload']) {
    const app = setup(), deferred = pending(); app.hooks.read = () => deferred.promise;
    const work = app.page.onShow(); app.page[lifecycle]();
    deferred.resolve({saveCount: 1, cooksnapCount: 0, items: [save()], nextOffset: null}); await work;
    assert.equal(app.page.data.items.length, 0);
  }
});
test('pagination appends unique events, keeps prior cards on failure and retries same offset', async () => {
  const app = setup(); app.hooks.read = async offset => offset === 0 ? {saveCount: 2, cooksnapCount: 0, items: [save()], nextOffset: 20} : Promise.reject(Error('暂时失败'));
  await app.page.onShow(); await app.page.loadMore();
  assert.equal(app.page.data.items.length, 1); assert.equal(app.page.data.nextOffset, 20); assert.equal(app.page.data.moreError, '暂时失败');
  app.hooks.read = async () => ({saveCount: 2, cooksnapCount: 0, items: [save(), save('save-2')], nextOffset: null});
  await app.page.loadMore(); assert.equal(app.page.data.items.length, 2); assert.equal(app.page.data.moreError, '');
  assert.equal(app.calls.reads[2].offset, 20);
});

test('an empty filtered page keeps the cursor and real totals so older visible feedback remains reachable', async () => {
  const app = setup(); app.hooks.read = async offset => offset === 0 ?
    {saveCount: 1, cooksnapCount: 0, items: [], nextOffset: 20} :
    {saveCount: 1, cooksnapCount: 0, items: [save()], nextOffset: null};
  await app.page.onShow();
  assert.equal(app.page.data.items.length, 0); assert.equal(app.page.data.saveCount, 1);
  assert.equal(app.page.data.nextOffset, 20);
  await app.page.loadMore(); assert.equal(app.page.data.items.length, 1);
  const template = fs.readFileSync(path.join(root, 'pages/feedback/index.wxml'), 'utf8');
  assert.match(template, /saveCount === 0 && cooksnapCount === 0 && nextOffset === null/);
});
test('duplicate load-more taps make a single request and reload invalidates older pagination', async () => {
  const app = setup(), deferred = pending();
  await app.page.onShow(); app.page.setData({nextOffset: 20}); app.hooks.read = offset => offset === 20 ? deferred.promise : {saveCount: 0, cooksnapCount: 0, items: [], nextOffset: null};
  const work = app.page.loadMore(); await app.page.loadMore(); await app.page.reload();
  deferred.resolve({saveCount: 1, cooksnapCount: 0, items: [save()], nextOffset: null}); await work;
  assert.equal(app.calls.reads.filter(item => item.offset === 20).length, 1); assert.equal(app.page.data.items.length, 0);
});
test('only loaded feedback opens recipe or photo and switching accounts clears content', async () => {
  const app = setup(); await app.page.onShow();
  const event = id => ({currentTarget: {dataset: {id}}});
  app.page.openRecipe(event('forged')); app.page.previewPhoto(event('forged'));
  assert.equal(app.calls.navigation.length, 0); assert.equal(app.calls.images.length, 0);
  app.page.openRecipe(event('save-1')); app.page.previewPhoto(event('snap-1'));
  assert.equal(app.calls.navigation[0], '/pages/public-recipe/index?id=' + RECIPE); assert.equal(app.calls.images.length, 1);
  app.page.photoError(event('snap-1')); app.page.previewPhoto(event('snap-1')); assert.equal(app.calls.images.length, 1);
  app.changeOwner(OTHER); app.page.openRecipe(event('save-1'));
  assert.equal(app.page.data.items.length, 0); assert.equal(app.calls.navigation.length, 1);
  app.page.onUnload(); assert.equal(app.listeners.size, 0);
});

test('saved recipe offers follow-up cooking feedback only for a source recipe and the current account', async () => {
  const {setup: detailSetup, OTHER: otherOwner} = require('./detail-runtime.cjs');
  const app = detailSetup({recipe: {source: {recipeId: RECIPE, profileId: 'd'.repeat(32), authorName: '原作者'}}});
  const page = await app.open(); page.openCooksnap();
  assert.equal(app.calls.navigation[0].url, '/pages/cooksnap-editor/index?id=' + RECIPE);
  app.store.bindAccount(otherOwner); page.openCooksnap(); assert.equal(app.calls.navigation.length, 1);
  for (const options of [{}, {enabled: false}, {recipe: {isExample: true}}]) {
    const own = detailSetup(options); const ownPage = await own.open(); ownPage.openCooksnap();
    assert.equal(own.calls.navigation.length, 0);
  }
});
