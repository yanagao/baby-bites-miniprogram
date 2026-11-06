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
    assert.equal(page.onShareAppMessage().imageUrl, 'https://example.com/public.jpg');
    assert.deepEqual(app.calls.shareLinks, [{id: LOCAL_ID, force: false}]);
    assert.deepEqual(app.calls.navigation, []); assert.deepEqual(app.calls.publish, []);
    assert.deepEqual(clone(app.store.getState()), before);
  }
});

test('sharing and returning retain verified recipe data without another request or redraw', async t => {
  for (const recipe of [{}, {createdBy: OTHER}, {source: {recipeId: 'e'.repeat(64), profileId: AUTHOR_ID, authorName: '原作者'}}]) {
    for (const hideFirst of [false, true]) await t.test((recipe.source ? 'saved copy' : recipe.createdBy ? 'family recipe' : 'own recipe') + (hideFirst ? ' hide first' : ' share first'), async () => {
      const app = setup({recipe}), page = await app.open();
      const snapshot = clone(page.data), updates = app.calls.updates;
      const menuCalls = app.calls.shareMenu.length;
      for (let i = 0; i < 3; i++) {
        if (hideFirst) { app.hideApp(2); page.onHide(); }
        const shared = page.onShareAppMessage();
        assert.match(shared.path, /^\/pages\/public-recipe\/index\?id=/);
        if (!hideFirst) { page.onHide(); app.hideApp(2); }
        await page.onShow();
      }
      // A canceled share chooser has the same hide/show lifecycle.
      page.onShareAppMessage(); page.onHide(); app.hideApp(2); await page.onShow();
      assert.equal(app.calls.shareLinks.length, 1);
      assert.equal(app.calls.updates, updates);
      assert.equal(app.calls.shareMenu.length, menuCalls);
      assert.deepEqual(clone(page.data), snapshot);
    });
  }
});

test('ordinary returns revalidate saved copies when the original author renames or withdraws the recipe', async t => {
  for (const change of ['rename', 'NOT_PUBLIC']) await t.test(change, async () => {
    const source = {recipeId: 'e'.repeat(64), profileId: AUTHOR_ID, authorName: '原作者'};
    const app = setup({recipe: {source}}), page = await app.open();
    const localBefore = clone(app.store.getRecipe(LOCAL_ID));
    page.onHide();
    if (change === 'rename') app.updatePublicSnapshot('原作者的新菜名');
    else app.hooks.recipe = () => { throw Object.assign(Error('原作者已取消公开'), {code: 'NOT_PUBLIC'}); };
    await page.onShow();
    assert.equal(app.calls.shareLinks.length, 2);
    assert.deepEqual(clone(app.store.getRecipe(LOCAL_ID)), localBefore);
    if (change === 'rename') assert.equal(page.onShareAppMessage().title, '原作者的新菜名 · 口袋食谱');
    else { assertUnshareable(page); assert.match(page.data.shareError, /取消公开/); }
  });
});

test('one share return does not suppress a later ordinary background refresh', async () => {
  const app = setup(), page = await app.open();
  page.onShareAppMessage(); page.onHide(); app.hideApp(2); await page.onShow();
  assert.equal(app.calls.shareLinks.length, 1);
  page.onHide(); app.updatePublicSnapshot('后台更新的菜名'); await page.onShow();
  assert.equal(app.calls.shareLinks.length, 2);
  assert.equal(page.data.shareRecipe.name, '后台更新的菜名');
});

test('canceling without hide cannot exempt a later ordinary app hide, even when the source changes', async t => {
  for (const reason of [0, 1, 3, undefined]) for (const change of ['rename', 'NOT_PUBLIC']) {
    await t.test(String(reason) + ' ' + change, async () => {
      const app = setup({recipe: {source: {recipeId: 'e'.repeat(64), profileId: AUTHOR_ID, authorName: '原作者'}}});
      const page = await app.open(); page.onShareAppMessage();
      await new Promise(resolve => setTimeout(resolve, 0));
      if (change === 'rename') app.updatePublicSnapshot('原作者修改后的名字');
      else app.hooks.recipe = () => { throw Object.assign(Error('原作者已取消公开'), {code: 'NOT_PUBLIC'}); };
      app.hideApp(reason); page.onHide(); await page.onShow();
      assert.equal(app.calls.shareLinks.length, 2);
      if (change === 'rename') assert.equal(page.data.shareRecipe.name, '原作者修改后的名字');
      else assertUnshareable(page);
    });
  }
});

test('a share cancelled without hiding cannot suppress a later normal navigation return', async t => {
  for (const action of ['previewPhoto', 'edit', 'record', 'openLastLog', 'openProfile', 'openPublicRecipe', 'openCooksnap']) {
    await t.test(action, async () => {
      const app = setup({recipe: {photo: 'wxfile://usr/photo.jpg', source: {recipeId: 'e'.repeat(64), profileId: AUTHOR_ID, authorName: '原作者'}}});
      const page = await app.open(); page.onShareAppMessage();
      page[action](); page.onHide(); app.hideApp(2); app.updatePublicSnapshot('导航后的新菜名'); await page.onShow();
      assert.equal(app.calls.shareLinks.length, 2);
      assert.equal(page.data.shareRecipe.name, '导航后的新菜名');
    });
  }
});

test('social invalidation before or during native sharing requires a new verified link', async t => {
  for (const when of ['before share', 'during share']) await t.test(when, async () => {
    const app = setup(), page = await app.open();
    if (when === 'before share') app.invalidateReads();
    page.onShareAppMessage(); page.onHide(); app.hideApp(2);
    if (when === 'during share') app.invalidateReads();
    app.updatePublicSnapshot('社交更新后的菜名'); await page.onShow();
    assert.equal(app.calls.shareLinks.length, 2);
    assert.equal(page.data.shareRecipe.name, '社交更新后的菜名');
  });
});

test('a response crossing social invalidation cannot mark its share-return metadata as current', async () => {
  const app = setup();
  app.hooks.link = () => {
    const result = linkResult(app, '失效前的菜名');
    app.invalidateReads();
    return result;
  };
  const page = await app.open(); delete app.hooks.link;
  page.onShareAppMessage(); page.onHide(); app.hideApp(2); app.updatePublicSnapshot('重新确认的菜名');
  await page.onShow();
  assert.equal(app.calls.shareLinks.length, 2);
  assert.equal(page.data.shareRecipe.name, '重新确认的菜名');
});

test('manual preparation consumes an old native-share exemption and still forces its request', async () => {
  const app = setup(), page = await app.open(); page.onShareAppMessage();
  await page.requestShare(); assert.equal(app.calls.shareLinks.at(-1).force, true);
  page.onHide(); await page.onShow();
  assert.equal(app.calls.shareLinks.length, 3);
});

test('a social change during pending preparation starts a fresh read on return and ignores the older response', async () => {
  const app = setup(), gate = pending(), stale = linkResult(app, '失效菜名');
  app.hooks.link = () => gate.promise;
  const first = app.page.onShow(); app.page.onHide(); app.invalidateReads();
  app.hooks.link = () => linkResult(app, '重新校验后的菜名');
  const second = app.page.onShow();
  // Do not await a mistakenly reused old promise before reporting the regression.
  assert.equal(app.calls.shareLinks.length, 2);
  await second;
  const updates = app.calls.updates; gate.resolve(stale); await first;
  assert.equal(app.calls.updates, updates);
  assert.equal(app.page.data.shareRecipe.name, '重新校验后的菜名');
});

test('an unconsumed native-share return cannot survive account or family changes or unload', async t => {
  for (const change of ['account', 'family', 'unload']) await t.test(change, async () => {
    const app = setup(), page = await app.open(); page.onShareAppMessage(); page.onHide(); app.hideApp(2);
    if (change === 'account') { app.store.bindAccount(OTHER); app.store.bindAccount(OWNER); }
    else if (change === 'family') {
      app.store.bindScope(OWNER, {kind: 'family', id: 'f'.repeat(64), membershipId: 'e'.repeat(32)});
      app.store.bindScope(OWNER, {kind: 'personal', id: OWNER});
    } else page.onUnload();
    const reads = app.calls.shareLinks.length;
    await page.onShow(); assert.equal(app.calls.shareLinks.length, reads); assertUnshareable(page);
  });
});

test('returning during share preparation reuses the current request', async () => {
  const app = setup(), gate = pending();
  app.hooks.link = () => gate.promise;
  const first = app.page.onShow(); app.page.onHide();
  const second = app.page.onShow(), third = app.page.onShow();
  assert.equal(app.calls.shareLinks.length, 1);
  gate.resolve(linkResult(app)); await Promise.all([first, second, third]);
  assert.equal(app.page.data.shareReady, true);
  assert.equal(app.page.onShareAppMessage().title, '同步后的南瓜粥 · 口袋食谱');
});

test('a real local edit while away still refreshes sharing on return', async () => {
  const app = setup(), page = await app.open();
  page.onShareAppMessage(); page.onHide(); app.hideApp(2);
  app.store.saveRecipe({...app.store.getRecipe(LOCAL_ID), name: '编辑后的菜名'});
  app.hooks.link = () => linkResult(app, '编辑后的菜名');
  await page.onShow();
  assert.equal(app.calls.shareLinks.length, 2);
  assert.equal(page.data.recipe.name, '编辑后的菜名');
  assert.equal(page.onShareAppMessage().title, '编辑后的菜名 · 口袋食谱');
});

test('an edit while preparation is pending starts a fresh read on return and rejects the old response', async () => {
  const app = setup(), gate = pending(), stale = linkResult(app, '编辑前的菜名');
  app.hooks.link = () => gate.promise;
  const first = app.page.onShow(); app.page.onHide();
  app.store.saveRecipe({...app.store.getRecipe(LOCAL_ID), name: '编辑后的菜名'});
  app.hooks.link = () => linkResult(app, '编辑后的菜名');
  await app.page.onShow();
  assert.equal(app.calls.shareLinks.length, 2);
  assert.equal(app.page.onShareAppMessage().title, '编辑后的菜名 · 口袋食谱');
  const updates = app.calls.updates;
  gate.resolve(stale); await first;
  assert.equal(app.calls.updates, updates);
  assert.equal(app.page.onShareAppMessage().title, '编辑后的菜名 · 口袋食谱');
});

test('local-only meal changes refresh displayed content without preparing the same share again', async () => {
  const app = setup(), page = await app.open();
  page.onShareAppMessage(); page.onHide(); app.hideApp(2);
  const logId = app.store.addLog({recipeId: LOCAL_ID, date: '2026-11-04', rating: 3, note: ''});
  await page.onShow();
  assert.equal(page.data.lastLog.id, logId);
  assert.equal(app.calls.shareLinks.length, 1);
});

test('the ready entry uses native sharing directly and has no preview or publish confirmation', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../pages/detail/index.wxml'), 'utf8');
  assert.match(markup, /wx:if="\{\{shareReady\}\}"[^>]*open-type="share"/);
  assert.doesNotMatch(markup, /shareVisible|先留给自己|确认预览|选择公开分享/);
  const code = fs.readFileSync(path.join(__dirname, '../pages/detail/index.js'), 'utf8');
  assert.doesNotMatch(code, /share-preview|previewPublication|publishRecipe/);
});

test('starter recipes share their bundled original without preparing a publication or sending local edits', async () => {
  for (const isExample of [true, false]) {
    const recipe = {id: 'pumpkin-millet', isExample, name: '私人的修改菜名', note: '私人心得', photo: 'wxfile://usr/private-photo.jpg'};
    const app = setup({recipe}), page = await app.open();
    await page.requestShare(); app.emitSync(); await turn();
    assert.equal(page.onShareAppMessage().path, '/pages/builtin-recipe/index?id=pumpkin-millet');
    assert.equal(page.onShareAppMessage().title, '南瓜小米粥 · 口袋食谱');
    assert.doesNotMatch(JSON.stringify(page.onShareAppMessage()), /私人|private-photo/);
    assert.deepEqual(app.calls.shareLinks, []); assert.deepEqual(app.calls.publish, []);
    assert.equal(app.calls.shareMenu.at(-1).show, true);
  }
});

test('an unknown imported sample cannot masquerade as a bundled recipe or offer a misleading share entry', async () => {
  const app = setup({recipe: {isExample: true}}), page = await app.open();
  assert.equal(page.shareAvailable(), false); assert.equal(page.data.shareReady, false);
  assert.equal(app.calls.shareMenu.at(-1).show, false);
  assert.deepEqual(app.calls.shareLinks, []); assertUnshareable(page);
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
  assert.equal(app.appHideListeners.size, 0);
  const updates = app.calls.updates; app.emitSync(); await turn(); assert.equal(app.calls.updates, updates);
  const disabled = setup({enabled: false}), local = await disabled.open(); await local.requestShare();
  assert.deepEqual(disabled.calls.shareLinks, []); assertUnshareable(local);
});
