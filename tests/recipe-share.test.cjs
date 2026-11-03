'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {setup, pending, turn, assertUnshareable, clone, OWNER, OTHER, PUBLIC_ID, AUTHOR_ID, LOCAL_ID} = require('./detail-runtime.cjs');
const linkResult = (app, name = '同步后的南瓜粥') => ({recipe: {id: PUBLIC_ID, name}, localVersion: JSON.stringify(app.store.getRecipe(app.sourceID))});

test('own recipes prepare a synchronized link without a preview or profile-setup step', async () => {
  for (const profileExists of [true, false]) {
    const app = setup({profileExists}), before = clone(app.store.getState()), page = await app.open();
    assert.equal(page.data.shareReady, true);
    assert.equal(page.onShareAppMessage().path, '/pages/public-recipe/index?id=' + PUBLIC_ID);
    assert.equal(page.onShareAppMessage().title, '已公开的南瓜小米粥 · 口袋食谱');
    assert.deepEqual(app.calls.shareLinks, [{id: LOCAL_ID, force: false}]);
    assert.deepEqual(app.calls.navigation, []); assert.deepEqual(app.calls.publish, []);
    assert.deepEqual(clone(app.store.getState()), before);
  }
});

test('the ready entry uses native sharing directly and has no preview or publish confirmation', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../pages/detail/index.wxml'), 'utf8');
  assert.match(markup, /wx:if="\{\{shareReady\}\}"[^>]*open-type="share"/);
  assert.doesNotMatch(markup, /shareVisible|先留给自己|确认预览|选择公开分享/);
  const code = fs.readFileSync(path.join(__dirname, '../pages/detail/index.js'), 'utf8');
  assert.doesNotMatch(code, /share-preview|previewPublication|publishRecipe/);
});

test('starter recipes only share the fixed app card and never prepare a publication', async () => {
  for (const recipe of [{isExample: true}, {id: 'pumpkin-millet', isExample: false}]) {
    const app = setup({recipe}), page = await app.open();
    await page.requestShare(); app.emitSync(); await turn();
    assert.equal(page.onShareAppMessage().path, '/pages/home/index');
    assert.deepEqual(app.calls.shareLinks, []); assert.deepEqual(app.calls.publish, []);
    assert.equal(app.calls.shareMenu.at(-1).show, true);
  }
});

test('saved copies forward the original recipe link and retain attribution', async () => {
  const source = {recipeId: 'e'.repeat(64), profileId: AUTHOR_ID, authorName: '原作者'};
  const app = setup({recipe: {source}}), page = await app.open();
  assert.equal(page.onShareAppMessage().path, '/pages/public-recipe/index?id=' + source.recipeId);
  assert.deepEqual(clone(app.store.getRecipe(LOCAL_ID).source), source);
  assert.deepEqual(app.calls.publish, []); assert.deepEqual(app.calls.navigation, []);
});

test('another family member can forward a verified existing link without becoming its author', async () => {
  const app = setup({recipe: {createdBy: OTHER}}), page = await app.open();
  assert.equal(page.data.familyRecipe, true); assert.equal(page.data.shareReady, true);
  assert.equal(app.onShareAppMessage, undefined);
  assert.equal(page.onShareAppMessage().path, '/pages/public-recipe/index?id=' + PUBLIC_ID);
  assert.equal(app.store.getRecipe(LOCAL_ID).createdBy, OTHER); assert.deepEqual(app.calls.publish, []);
});

test('preparation failure exposes no local data and retries the synchronized-link API', async () => {
  const app = setup(); app.hooks.link = () => {throw Error('请联网后重试');}; const page = await app.open();
  assertUnshareable(page); assert.match(page.data.shareError, /联网/);
  delete app.hooks.link; await page.requestShare();
  assert.equal(page.data.shareReady, true); assert.equal(app.calls.shareLinks.at(-1).force, true);
  assert.deepEqual(app.calls.navigation, []); assert.deepEqual(app.calls.publish, []);
});

test('duplicate preparation taps coalesce at the page while one request is pending', async () => {
  const app = setup(), page = await app.open(), gate = pending();
  app.hooks.link = () => gate.promise; const first = page.requestShare(); await page.requestShare();
  assert.equal(app.calls.shareLinks.length, 2); assertUnshareable(page);
  gate.resolve(linkResult(app)); await first; assert.equal(page.data.shareReady, true);
});

test('invalid server metadata or stale local versions cannot become share cards', async () => {
  for (const recipe of [null, {id: 'bad', name: '名称'}, {id: PUBLIC_ID, name: ''}, {id: PUBLIC_ID, name: ' '}]) {
    const app = setup(); app.hooks.link = () => ({recipe, localVersion: JSON.stringify(app.store.getRecipe(LOCAL_ID))});
    assertUnshareable(await app.open());
  }
  const app = setup(); app.hooks.link = () => ({recipe: {id: PUBLIC_ID, name: '旧菜名'}, localVersion: 'old'});
  const page = await app.open(); assertUnshareable(page); assert.match(page.data.shareError, /更新/);
});

test('local edits invalidate a prepared share until a fresh synchronized version is read', async () => {
  const app = setup(), page = await app.open();
  app.store.saveRecipe({...app.store.getRecipe(LOCAL_ID), name: '新修改的菜名'});
  assert.equal(page.data.shareReady, false); assertUnshareable(page);
  app.hooks.link = () => linkResult(app, '服务端确认的新菜名'); await page.requestShare();
  assert.equal(page.onShareAppMessage().title, '服务端确认的新菜名 · 口袋食谱');
  assert.doesNotMatch(JSON.stringify(page.onShareAppMessage()), /只给自己|宝宝私密|私密用餐|私人|cloud:\/\//);
});

test('an edit between helper resolution and page continuation rejects the earlier local version', async () => {
  const app = setup(); app.hooks.link = () => {
    const previous = linkResult(app);
    app.store.saveRecipe({...app.store.getRecipe(LOCAL_ID), name: '刚刚修改'});
    return previous;
  };
  const page = await app.open(); assertUnshareable(page); assert.match(page.data.shareError, /更新/);
});

test('completed sync refreshes sharing once and identity-only notifications do not reread', async () => {
  const app = setup(), page = await app.open(), reads = app.calls.shareLinks.length;
  app.emitSync({revision: 0, publicationVersion: 0, identityCheckedAt: Date.now()}); await turn();
  assert.equal(app.calls.shareLinks.length, reads);
  app.updatePublicSnapshot('自动同步后的菜名'); app.emitSync(); await turn();
  assert.equal(app.calls.shareLinks.length, reads + 1);
  assert.equal(page.onShareAppMessage().title, '自动同步后的菜名 · 口袋食谱');
});

test('sync notifications during a read coalesce into one trailing refresh', async () => {
  const app = setup(), page = await app.open(), gate = pending();
  app.hooks.link = () => gate.promise; const work = page.refreshPublication();
  app.emitSync(); app.emitSync({publicationVersion: 2});
  delete app.hooks.link; app.updatePublicSnapshot('最后同步版本'); gate.resolve(linkResult(app));
  await work; await turn();
  assert.equal(app.calls.shareLinks.length, 3); assert.equal(page.onShareAppMessage().title, '最后同步版本 · 口袋食谱');
});

test('sync refresh waits while deleting or hidden and resumes when the page returns', async () => {
  for (const mode of ['delete', 'hidden']) {
    const app = setup(), page = await app.open();
    if (mode === 'delete') page.remove(); else page.onHide();
    const reads = app.calls.shareLinks.length; app.updatePublicSnapshot('恢复后菜名'); app.emitSync(); await turn();
    assert.equal(app.calls.shareLinks.length, reads);
    if (mode === 'delete') page.cancelDelete(); else await page.onShow();
    await turn(); assert.equal(page.onShareAppMessage().title, '恢复后菜名 · 口袋食谱');
  }
});

test('account and family ABA transitions permanently clear an open share page', async () => {
  for (const mode of ['account', 'family']) {
    const app = setup(), page = await app.open();
    if (mode === 'account') {app.store.bindAccount(OTHER); app.store.bindAccount(OWNER);}
    else {app.store.bindScope(OWNER, {kind: 'family', id: 'f'.repeat(64), membershipId: 'e'.repeat(32)}); app.store.bindScope(OWNER, {kind: 'personal', id: OWNER});}
    await page.requestShare(); assert.equal(page.data.recipe, null); assertUnshareable(page);
  }
});

test('late share preparation cannot overwrite a newer result or revive switched, deleted or unloaded pages', async () => {
  for (const mode of ['newer', 'switch', 'delete', 'unload']) {
    const app = setup(), page = await app.open(), gate = pending(), old = linkResult(app, '过期版本');
    app.hooks.link = () => gate.promise; const work = page.refreshPublication();
    if (mode === 'newer') {delete app.hooks.link; app.updatePublicSnapshot('新版本'); await page.refreshPublication();}
    else if (mode === 'switch') app.store.bindAccount(OTHER);
    else if (mode === 'delete') {page.remove(); await page.confirmDelete();}
    else page.onUnload();
    const updates = app.calls.updates; gate.resolve(old); await work;
    assert.equal(app.calls.updates, updates);
    if (mode === 'newer') assert.equal(page.onShareAppMessage().title, '新版本 · 口袋食谱'); else assertUnshareable(page);
  }
});

test('unload removes subscriptions and disabled social never prepares a link', async () => {
  const app = setup(), page = await app.open(); page.onUnload(); assert.equal(app.syncListeners.size, 0);
  const updates = app.calls.updates; app.emitSync(); await turn(); assert.equal(app.calls.updates, updates);
  const disabled = setup({enabled: false}), local = await disabled.open(); await local.requestShare();
  assert.deepEqual(disabled.calls.shareLinks, []); assertUnshareable(local);
});
