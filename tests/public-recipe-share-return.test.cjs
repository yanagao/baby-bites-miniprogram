'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {getProfileAvatar} = require('../utils/profile-avatar');
const clone = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const author = {id: 'a'.repeat(32), name: '朋友的小厨房'};
const recipe = {id: 'b'.repeat(64), name: '南瓜粥', profileId: author.id,
  ingredients: [{name: '南瓜'}], steps: ['蒸熟'], source: {profileId: 'c'.repeat(32)}};
const photoURL = 'https://example.test/author-recipe.jpg';
const fallbackImage = '/assets/cute/pocket-mascot.png';
const localPhoto = source => 'wxfile://tmp/' + encodeURIComponent(source) + '.jpg';

function setup() {
  let owner = 'owner-a', scope = 'family-a', version = 1, imported = null, allergies = [];
  const listeners = new Set();
  const appHideListeners = new Set();
  const calls = {recipes: [], summaries: 0, feedback: [], routes: [], images: [], updates: 0, loading: 0};
  const hooks = {};
  const store = {getSyncInfo: () => ({owner, scopeKey: scope}), getState: () => ({recipes: [], logs: [], allergies}),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  const social = {
    getReadVersion: () => version,
    getRecipe: async (id, options) => { calls.recipes.push({id, options}); if (hooks.recipe) return hooks.recipe(); return {recipe, author}; },
    getProfileSummary: async () => { calls.summaries++; return hooks.summary ? hooks.summary() : {isSelf: false, following: false, followedBy: true}; },
    getRecipeFeedback: async (_, offset) => {
      calls.feedback.push(offset);
      return {saveCount: 3, cooksnapCount: 2, nextOffset: offset ? null : 1,
        cooksnaps: [{id: String(offset), createdAt: 1, text: '喜欢', photoURL: 'https://example.test/photo.jpg'}]};
    },
    findImportedRecipe: () => imported,
    setFollowing: async (_, following) => ({following, followedBy: true}),
    addToCookbook: async () => { imported = {id: 'local-copy'}; return {recipeId: imported.id, added: true}; }
  };
  const wx = {showShareMenu() {}, hideShareMenu() {}, showToast() {}, previewImage() {},
    getImageInfo(options) {
      calls.images.push(options.src);
      if (hooks.image) return hooks.image(options);
      options.success({path: localPhoto(options.src)});
    },
    onAppHide(listener) { appHideListeners.add(listener); }, offAppHide(listener) { appHideListeners.delete(listener); },
    navigateTo(options) { calls.routes.push(options.url); if (options.complete) options.complete(); }};
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {module: accountModule, wx, require: () => store});
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/public-recipe/index.js'), 'utf8'), {
    wx, Date, Page(value) { definition = value; }, require(name) {
      if (name.endsWith('/social')) return social;
      if (name.endsWith('/native-share-return')) return require('../utils/native-share-return');
      if (name.endsWith('/recipe-share-photo')) return require('../utils/recipe-share-photo');
      if (name.endsWith('/store')) return store;
      if (name.endsWith('/account')) return accountModule.exports;
      if (name.endsWith('/profile-avatar')) return {getProfileAvatar};
      if (name.endsWith('/allergies')) return require('../utils/allergies');
      if (name.endsWith('/ui')) return {error() {}, back() {}};
      throw Error(name);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(update) {
    calls.updates++; if (update.loading) calls.loading++; Object.assign(this.data, clone(update));
  }};
  page.onLoad({id: recipe.id});
  return {page, calls, hooks, listeners,
    appHideListeners, hideApp(reason) { appHideListeners.forEach(listener => listener({reason})); },
    invalidate() { version++; }, setImported(value) { imported = value; }, setAllergies(value) { allergies = value; },
    changeIdentity(nextOwner, nextScope = scope, notify = true) { owner = nextOwner; scope = nextScope; if (notify) listeners.forEach(fn => fn()); }};
}

function nativeShare(app, options) {
  const result = app.page.onShareAppMessage(options);
  app.hideApp(2);
  return result;
}

test('forwarded recipe cards prefer the cached author photo, then the public cover, then the app image', async () => {
  const displayPhoto = 'wxfile://usr/recipe-covers-v1/public-cover.jpg';
  for (const [photos, expected] of [[{photoURL, displayPhoto}, localPhoto(photoURL)], [{displayPhoto}, displayPhoto], [{}, fallbackImage]]) {
    const app = setup();
    app.hooks.recipe = () => ({recipe: {...recipe, ...photos}, author});
    await app.page.onShow();
    const share = app.page.onShareAppMessage();
    assert.equal(share.imageUrl, expected);
    assert.equal(share.path, '/pages/public-recipe/index?id=' + recipe.id);
  }
});

test('reloading replaces the shared photo and never exposes the previous photo while loading or after failure', async () => {
  const app = setup();
  app.hooks.recipe = () => ({recipe: {...recipe, photoURL}, author});
  await app.page.onShow();
  assert.equal(app.page.onShareAppMessage().imageUrl, localPhoto(photoURL));
  let release;
  app.hooks.recipe = () => new Promise(resolve => { release = resolve; });
  const loading = app.page.reload();
  assert.equal(app.page.data.loading, true);
  assert.equal(app.page.onShareAppMessage().imageUrl, fallbackImage);
  const replacement = 'https://example.test/author-recipe-updated.jpg';
  release({recipe: {...recipe, photoURL: replacement}, author}); await loading;
  assert.equal(app.page.onShareAppMessage().imageUrl, localPhoto(replacement));
  app.hooks.recipe = () => { throw Error('菜谱已取消公开'); };
  await app.page.reload();
  assert.equal(app.page.onShareAppMessage().imageUrl, fallbackImage);
});

test('a photo cached on load still shares after the public URL expires without downloading or redrawing', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const app = setup(); app.hooks.recipe = () => ({recipe: {...recipe, photoURL}, author});
  await app.page.onShow();
  const before = clone(app.page.data), counts = clone(app.calls);
  assert.deepEqual(app.calls.images, [photoURL]);
  now += 301000;
  assert.equal(nativeShare(app).imageUrl, localPhoto(photoURL));
  await app.page.onShow();
  assert.deepEqual(app.page.data, before);
  assert.deepEqual(clone(app.calls), counts);
});

test('failed photo downloads cannot fall back to an expired public URL in displayPhoto', async () => {
  for (const displayPhoto of ['', photoURL]) {
    const app = setup(); app.hooks.recipe = () => ({recipe: {...recipe, photoURL, displayPhoto}, author});
    app.hooks.image = options => options.fail({errMsg: 'download failed'});
    await app.page.onShow();
    const share = app.page.onShareAppMessage();
    assert.equal(share.path, '/pages/public-recipe/index?id=' + recipe.id);
    assert.equal(share.imageUrl, fallbackImage);
    assert.deepEqual(app.calls.images, [photoURL]);
  }
});

test('reloading the same photo URL ignores an older download that completes after its replacement', async () => {
  const app = setup(), pending = [];
  app.hooks.recipe = () => ({recipe: {...recipe, photoURL}, author});
  app.hooks.image = options => pending.push(options);
  await app.page.onShow();
  assert.equal(app.page.onShareAppMessage().imageUrl, fallbackImage);
  await app.page.reload();
  assert.equal(app.page.onShareAppMessage().imageUrl, fallbackImage);
  assert.deepEqual(app.calls.images, [photoURL, photoURL]);
  const updates = app.calls.updates;
  pending[1].success({path: 'wxfile://tmp/new-download.jpg'});
  pending[0].success({path: 'wxfile://tmp/old-download.jpg'});
  assert.equal(app.page.onShareAppMessage().imageUrl, 'wxfile://tmp/new-download.jpg');
  assert.equal(app.calls.updates, updates);
});

test('late photo downloads cannot cross account or family changes, or revive an unloaded page', async t => {
  for (const mode of ['account', 'family', 'unload']) await t.test(mode, async () => {
    const app = setup(), pending = [];
    app.hooks.recipe = () => ({recipe: {...recipe, photoURL}, author});
    app.hooks.image = options => pending.push(options);
    await app.page.onShow();
    if (mode === 'unload') app.page.onUnload();
    else {
      if (mode === 'account') app.changeIdentity('owner-b');
      else app.changeIdentity('owner-a', 'family-b');
      await app.page.reload();
    }
    const updates = app.calls.updates;
    pending[0].success({path: 'wxfile://tmp/previous-session.jpg'});
    assert.equal(app.page.onShareAppMessage().imageUrl, fallbackImage);
    assert.equal(app.calls.updates, updates);
    if (mode !== 'unload') {
      pending[1].success({path: 'wxfile://tmp/current-session.jpg'});
      assert.equal(app.page.onShareAppMessage().imageUrl, 'wxfile://tmp/current-session.jpg');
    } else assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
  });
});

test('native recipe sharing and cancellation preserve the loaded view, pagination and failed-image state without requests', async t => {
  for (const from of ['button', 'menu']) for (const hideFirst of [false, true]) await t.test(from + (hideFirst ? ' hide first' : ' share first'), async () => {
    const app = setup(), {page, calls} = app; app.hooks.recipe = () => ({recipe: {...recipe, photoURL}, author});
    await page.onShow(); await page.moreFeedback();
    page.photoError(); page.cooksnapPhotoError({currentTarget: {dataset: {id: '1'}}});
    const before = clone(page.data), counts = clone(calls);
    if (hideFirst) app.hideApp(2);
    const share = page.onShareAppMessage({from});
    assert.equal(share.path, '/pages/public-recipe/index?id=' + recipe.id);
    assert.equal(share.imageUrl, localPhoto(photoURL));
    if (!hideFirst) app.hideApp(2);
    // No share success callback is needed: cancelling the native sheet returns the same way.
    await page.onShow();
    assert.deepEqual(page.data, before);
    assert.deepEqual(clone(calls), counts);
  });
});

test('share-return reuse is consumed once and ordinary returns still revalidate public visibility', async () => {
  const app = setup(), {page, calls, hooks} = app; await page.onShow();
  nativeShare(app); await page.onShow();
  assert.equal(calls.recipes.length, 1);
  hooks.recipe = () => { throw Error('菜谱已取消公开'); };
  await page.onShow();
  assert.equal(calls.recipes.length, 2); assert.equal(page.data.recipe, null);
  assert.match(page.data.error, /取消公开/);
  assert.equal(page.onShareAppMessage().path, '/pages/home/index');
});

test('canceling without hide cannot exempt a later ordinary background return after an author change', async t => {
  for (const reason of [0, 1, 3, undefined]) for (const change of ['rename', 'NOT_PUBLIC']) {
    await t.test(String(reason) + ' ' + change, async () => {
      const app = setup(); await app.page.onShow(); app.page.onShareAppMessage();
      await new Promise(resolve => setTimeout(resolve, 0));
      app.hooks.recipe = () => {
        if (change === 'NOT_PUBLIC') throw Object.assign(Error('原作者已取消公开'), {code: 'NOT_PUBLIC'});
        return {recipe: {...recipe, name: '原作者修改后的名字'}, author};
      };
      app.hideApp(reason); if (app.page.onHide) app.page.onHide(); await app.page.onShow();
      assert.equal(app.calls.recipes.length, 2);
      if (change === 'rename') assert.equal(app.page.data.recipe.name, '原作者修改后的名字');
      else assert.equal(app.page.data.recipe, null);
    });
  }
});

test('share return refreshes changed local allergy and imported-copy state without querying the server', async () => {
  const app = setup(); await app.page.onShow(); nativeShare(app);
  app.setAllergies(['南瓜']); app.setImported({id: 'new-local-copy'});
  await app.page.onShow();
  assert.equal(app.calls.recipes.length, 1); assert.equal(app.calls.summaries, 1); assert.equal(app.calls.feedback.length, 1);
  assert.match(app.page.data.allergyWarning, /南瓜/); assert.equal(app.page.data.importedId, 'new-local-copy');
});

test('a social change during sharing requires fresh public detail and related state', async () => {
  const app = setup(); await app.page.onShow(); nativeShare(app); app.invalidate();
  await app.page.onShow();
  assert.equal(app.calls.recipes.length, 2); assert.equal(app.calls.summaries, 2); assert.equal(app.calls.feedback.length, 2);
});

test('a social change before sharing cannot be relabeled as already displayed fresh recipe data', async () => {
  const app = setup(); await app.page.onShow(); app.invalidate(); nativeShare(app);
  await app.page.onShow();
  assert.equal(app.calls.recipes.length, 2); assert.equal(app.calls.summaries, 2);
});

test('identity preparation that advances the version before recipe delivery does not cause a redundant share-return read', async () => {
  const app = setup();
  app.hooks.recipe = () => { app.invalidate(); return {recipe, author}; };
  await app.page.onShow(); nativeShare(app); await app.page.onShow();
  assert.equal(app.calls.recipes.length, 1); assert.equal(app.calls.summaries, 1);
});

test('sharing with the initial author relationship still pending preserves that request and the delivered recipe', async () => {
  const app = setup(); let release;
  app.hooks.summary = () => new Promise(resolve => { release = resolve; });
  const first = app.page.onShow(); await turn();
  assert.equal(app.page.data.loading, false); assert.equal(app.page.data.relationLoading, true);
  nativeShare(app); await app.page.onShow();
  assert.equal(app.calls.recipes.length, 1); assert.equal(app.calls.summaries, 1);
  release({isSelf: false, following: true, followedBy: true}); await first;
  assert.equal(app.page.data.following, true); assert.equal(app.page.data.relationReady, true);
});

test('a pending relationship read cannot make an invalidated displayed recipe current for sharing', async () => {
  const app = setup(); let release;
  app.hooks.summary = () => new Promise(resolve => { release = resolve; });
  const first = app.page.onShow(); await turn(); app.invalidate();
  release({isSelf: false, following: true}); await first;
  app.hooks.summary = null;
  nativeShare(app); await app.page.onShow();
  assert.equal(app.calls.recipes.length, 2); assert.equal(app.calls.summaries, 2);
});

test('explicit reload consumes a pending share-return marker and remains forced', async () => {
  const {page, calls} = setup(); await page.onShow(); page.onShareAppMessage();
  await page.reload(); assert.equal(calls.recipes[1].options.force, true);
  await page.onShow(); assert.equal(calls.recipes.length, 3);
});

test('a cancelled share without a show event cannot suppress a later business-navigation refresh', async t => {
  for (const action of ['openAuthor', 'openSource', 'openCooksnap', 'openOwn']) await t.test(action, async () => {
    const app = setup(); app.setImported({id: 'copy'}); await app.page.onShow(); app.page.onShareAppMessage();
    app.page[action](); assert.equal(app.calls.routes.length, 1);
    await app.page.onShow(); assert.equal(app.calls.recipes.length, 2);
  });
});

test('following or saving after an unconsumed share cannot leave a stale reuse marker', async t => {
  for (const action of ['toggleFollow', 'add']) await t.test(action, async () => {
    const app = setup(); await app.page.onShow(); app.page.onShareAppMessage();
    await app.page[action](); await app.page.onShow();
    assert.equal(app.calls.recipes.length, 2);
  });
});

test('photo previews cannot pick up a canceled share marker when they open a native page', async t => {
  for (const action of ['previewPhoto', 'previewCooksnap']) await t.test(action, async () => {
    const app = setup(); await app.page.onShow(); app.page.data.recipe.photoURL = 'https://example.test/recipe.jpg';
    app.page.onShareAppMessage();
    app.page[action]({currentTarget: {dataset: {id: '0'}}}); app.hideApp(2);
    await app.page.onShow(); assert.equal(app.calls.recipes.length, 2);
  });
});

test('share-return reuse cannot revive account or family ABA sessions and ignores unloaded pages', async t => {
  for (const mode of ['account', 'family', 'unnotified', 'unload']) await t.test(mode, async () => {
    const app = setup(); app.hooks.recipe = () => ({recipe: {...recipe, photoURL}, author});
    await app.page.onShow(); assert.equal(app.page.onShareAppMessage().imageUrl, localPhoto(photoURL));
    if (mode === 'account') { app.changeIdentity('owner-b'); app.changeIdentity('owner-a'); }
    if (mode === 'family') { app.changeIdentity('owner-a', 'family-b'); app.changeIdentity('owner-a', 'family-a'); }
    if (mode === 'unnotified') app.changeIdentity('owner-b', 'family-a', false);
    if (mode === 'unload') app.page.onUnload();
    await app.page.onShow(); assert.equal(app.calls.recipes.length, 1);
    assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
    assert.equal(app.page.onShareAppMessage().imageUrl, fallbackImage);
    if (mode !== 'unload') assert.equal(app.page.data.recipe, null);
    else { assert.equal(app.listeners.size, 0); assert.equal(app.appHideListeners.size, 0); }
  });
});
