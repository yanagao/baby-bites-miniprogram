'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, pending, turn, assertUnshareable, clone, OWNER, OTHER, PUBLIC_ID, AUTHOR_ID, LOCAL_ID} = require('./detail-runtime.cjs');

test('unshared recipes enter preview without publishing or requiring profile setup', async () => {
  for (const profileExists of [true, false]) {
    const app = setup({profileExists}); const page = await app.open();
    const before = clone(app.store.getState());
    assertUnshareable(page);
    await page.requestShare();
    assert.deepEqual(app.calls.publish, []);
    assert.equal(page.data.shareVisible, false);
    assert.equal(app.calls.navigation.length, 1);
    assert.equal(app.calls.navigation[0].url, '/pages/share-preview/index?id=' + LOCAL_ID);
    assert.equal(page.requestPublish, undefined);
    assert.equal(page.confirmPublish, undefined);
    assert.equal(page.unpublish, undefined);
    assert.equal(app.isPublished(), false);
    assert.deepEqual(clone(app.store.getState()), before);
    assertUnshareable(page);
  }
});

test('duplicate taps open only one preview and returning allows another deliberate preview', async () => {
  const app = setup(); const page = await app.open();
  await page.requestShare(); await page.requestShare();
  assert.equal(app.calls.navigation.length, 1); assertUnshareable(page);
  assert.deepEqual(app.calls.publish, []);
  await page.onShow(); await page.requestShare();
  assert.equal(app.calls.navigation.length, 2);
  assert.deepEqual(app.calls.publish, []);
});

test('already synced recipes share the server snapshot without posting unsynced local edits', async () => {
  const app = setup({published: true}); const page = await app.open();
  await page.requestShare();
  assert.deepEqual(app.calls.publish, []);
  assert.equal(page.onShareAppMessage().title, '已公开的南瓜小米粥 · 口袋食谱');
  assert.equal(page.data.publicChanged, true);
  assert.doesNotMatch(JSON.stringify(page.onShareAppMessage()), /尚未公开|只给自己|宝宝私密/);
});

test('starter recipes remain local and only share the fixed app card even after editing', async () => {
  for (const recipe of [{isExample: true}, {id: 'pumpkin-millet', isExample: false}]) {
    const app = setup({recipe}); const before = clone(app.store.getState()); const page = await app.open();
    assert.equal(page.data.builtIn, true);
    await page.requestShare(); app.emitSync(); await turn();
    assert.equal(page.onShareAppMessage().path, '/pages/home/index');
    assert.equal(page.onShareAppMessage().imageUrl, '/assets/cute/pocket-mascot.png');
    assert.equal(app.calls.mine, 0); assert.deepEqual(app.calls.recipe, []); assert.deepEqual(app.calls.publish, []);
    assert.deepEqual(clone(app.store.getState()), before);
    assert.equal(app.calls.shareMenu.at(-1).show, true);
  }
});

test('saved copies also need preview and keep their author attribution', async () => {
  const source = {recipeId: 'e'.repeat(64), profileId: AUTHOR_ID, authorName: '原作者'};
  const app = setup({recipe: {source}}); const page = await app.open();
  await page.requestShare();
  assert.deepEqual(app.calls.publish, []); assert.equal(page.data.shareVisible, false);
  assert.equal(app.calls.navigation[0].url, '/pages/share-preview/index?id=' + LOCAL_ID);
  assert.deepEqual(clone(app.store.getRecipe(LOCAL_ID).source), source);
});

test('unreadable sharing status does not guess a URL or publish and retries into preview', async () => {
  const app = setup(); app.hooks.mine = () => { throw Error('离线'); }; const page = await app.open();
  await page.requestShare(); assert.deepEqual(app.calls.publish, []); assertUnshareable(page);
  assert.deepEqual(app.calls.navigation, []);
  delete app.hooks.mine; await page.requestShare();
  assert.equal(app.calls.navigation[0].url, '/pages/share-preview/index?id=' + LOCAL_ID);
  assert.deepEqual(app.calls.publish, []); assertUnshareable(page);
});

test('preview navigation failure is retryable without publishing or exposing local content', async () => {
  const app = setup({profileExists: false}); const page = await app.open();
  await page.requestShare(); app.calls.navigation[0].fail();
  assertUnshareable(page); assert.equal(page.data.shareVisible, false);
  assert.match(page.data.shareError, /预览/);
  await page.requestShare();
  assert.equal(app.calls.navigation.length, 2);
  assert.deepEqual(app.calls.publish, []);
});

test('a failed published snapshot retries without submitting the recipe again', async () => {
  const app = setup({published: true}); app.hooks.recipe = () => { throw Error('菜谱暂不可读取'); };
  const page = await app.open();
  await page.requestShare(); assertUnshareable(page); assert.deepEqual(app.calls.publish, []);
  delete app.hooks.recipe; await page.requestShare();
  assert.equal(page.data.shareVisible, true); assert.deepEqual(app.calls.publish, []);
  assert.deepEqual(app.calls.navigation, []);
});

test('invalid server identities or names cannot become share metadata', async () => {
  for (const recipe of [null, {id: 'bad', name: '名称'}, {id: PUBLIC_ID, name: ''}, {id: PUBLIC_ID, name: ' '}]) {
    const app = setup({published: true}); app.hooks.recipe = () => ({recipe}); const page = await app.open();
    assertUnshareable(page); assert.equal(page.data.shareRecipe, null);
  }
});

test('a completed automatic sync refreshes sharing metadata once and ignores identity-only notifications', async () => {
  const app = setup({published: true}); const page = await app.open(); const reads = app.calls.mine;
  app.emitSync({revision: 0, publicationVersion: 0, identityCheckedAt: Date.now()}); await turn();
  assert.equal(app.calls.mine, reads);
  app.updatePublicSnapshot('自动同步后的菜名'); app.emitSync(); await turn();
  assert.equal(app.calls.mine, reads + 1); assert.equal(page.onShareAppMessage().title, '自动同步后的菜名 · 口袋食谱');
});

test('sync notifications during an existing read coalesce into one trailing refresh', async () => {
  const app = setup({published: true}); const page = await app.open(); const gate = pending();
  app.hooks.mine = () => gate.promise; const work = page.refreshPublication();
  app.updatePublicSnapshot('合并通知后的菜名'); app.emitSync(); app.emitSync({publicationVersion: 2});
  delete app.hooks.mine; gate.resolve({profile: {exists: true}, published: [{id: PUBLIC_ID, sourceRecipeId: LOCAL_ID, sourceUpdatedAt: 1}]});
  await work; await turn();
  assert.equal(app.calls.mine, 3); assert.equal(page.onShareAppMessage().title, '合并通知后的菜名 · 口袋食谱');
});

test('sync refresh waits for a share panel, a delete confirmation or a hidden page', async () => {
  for (const mode of ['share', 'delete', 'hidden']) {
    const app = setup({published: true}); const page = await app.open();
    if (mode === 'share') await page.requestShare(); else if (mode === 'delete') page.remove(); else page.onHide();
    const reads = app.calls.mine; app.updatePublicSnapshot('等待页面恢复后的菜名'); app.emitSync(); await turn();
    assert.equal(app.calls.mine, reads, mode);
    if (mode === 'share') page.closeShare(); else if (mode === 'delete') page.cancelDelete(); else await page.onShow();
    await turn(); assert.equal(page.onShareAppMessage().title, '等待页面恢复后的菜名 · 口袋食谱', mode);
  }
});

test('account changes immediately clear shares and A to B to A does not revive the old page', async () => {
  for (const published of [false, true]) {
    const app = setup({published}); const page = await app.open();
    app.store.bindAccount(OTHER); app.store.bindAccount(OWNER); await page.requestShare();
    assert.equal(page.data.recipe, null); assertUnshareable(page); assert.deepEqual(app.calls.publish, []);
  }
});

test('a pending status read cannot open preview after account change or page unload', async () => {
  for (const mode of ['switch', 'unload']) {
    const app = setup(); const page = await app.open(); const gate = pending();
    page.setData({publicReady: false}); app.hooks.mine = () => gate.promise;
    const work = page.requestShare();
    if (mode === 'switch') app.store.bindAccount(OTHER); else page.onUnload();
    const updates = app.calls.updates;
    gate.resolve({profile: {exists: false}, published: []}); await work;
    assert.equal(app.calls.updates, updates); assertUnshareable(page);
    assert.deepEqual(app.calls.navigation, []); assert.deepEqual(app.calls.publish, []);
  }
});

test('late server snapshots cannot overwrite a newer read or a switched account', async () => {
  for (const mode of ['newer', 'switch', 'unload']) {
    const app = setup({published: true}); const page = await app.open(); const gate = pending();
    app.hooks.recipe = () => gate.promise; const work = page.refreshShareRecipe(page._publicRequest);
    if (mode === 'newer') { delete app.hooks.recipe; app.updatePublicSnapshot('新菜名'); await page.refreshPublication(); }
    else if (mode === 'switch') app.store.bindAccount(OTHER); else page.onUnload();
    const updates = app.calls.updates; gate.resolve({recipe: {id: PUBLIC_ID, name: '过期菜名'}}); await work;
    assert.equal(app.calls.updates, updates);
    if (mode === 'newer') assert.equal(page.onShareAppMessage().title, '新菜名 · 口袋食谱'); else assertUnshareable(page);
  }
});

test('server account errors lock the page and a removed recipe cannot be shared', async () => {
  const switched = setup(); switched.hooks.mine = () => { throw Object.assign(Error('changed'), {code: 'ACCOUNT_CHANGED'}); };
  const page = await switched.open(); assert.equal(page.data.recipe, null); assertUnshareable(page);
  const missing = setup({published: true}); missing.hooks.recipe = () => { throw Object.assign(Error('已删除'), {code: 'NOT_PUBLIC'}); };
  const missingPage = await missing.open(); assert.equal(missingPage.data.publicReady, false); assertUnshareable(missingPage);
});

test('unload removes subscriptions and disabled social does not start recipe synchronization', async () => {
  const app = setup(); const page = await app.open(); page.onUnload(); assert.equal(app.syncListeners.size, 0);
  const updates = app.calls.updates; app.emitSync(); await turn(); assert.equal(app.calls.updates, updates);
  const disabled = setup({enabled: false}); const local = await disabled.open(); await local.requestShare();
  assert.equal(disabled.calls.mine, 0); assert.deepEqual(disabled.calls.publish, []); assertUnshareable(local);
});

test('background synchronization never publishes a recipe the user kept for themselves', async () => {
  const app = setup(); const before = clone(app.store.getState()); const page = await app.open();
  app.emitSync(); await turn();
  assert.equal(app.isPublished(), false); assert.deepEqual(app.calls.publish, []);
  assert.deepEqual(app.calls.navigation, []); assert.deepEqual(clone(app.store.getState()), before);
  assertUnshareable(page);
});
