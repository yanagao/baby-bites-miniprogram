'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, pending, turn, clone, LOCAL_ID, PUBLIC_ID, AUTHOR_ID} = require('./detail-runtime.cjs');

test('ordinary detail returns keep loaded content, share photo, and metadata without requests or redraws', async t => {
  for (const action of ['previewPhoto', 'edit', 'record', 'openLastLog', 'openProfile', 'openPublicRecipe', 'openCooksnap']) {
    await t.test(action, async () => {
      const app = setup({recipe: {photo: 'wxfile://usr/photo.jpg', source: {
        recipeId: 'e'.repeat(64), profileId: AUTHOR_ID, authorName: '原作者'}}});
      const page = await app.open();
      page[action](); page.onHide();
      const before = clone(page.data), updates = app.calls.updates;
      await page.onShow(); await page.onShow();
      assert.equal(app.calls.shareLinks.length, 1);
      assert.equal(app.calls.images.length, 1);
      assert.equal(app.calls.updates, updates);
      assert.deepEqual(clone(page.data), before);
      assert.equal(page.onShareAppMessage().imageUrl, 'wxfile://tmp/public-share.jpg');
    });
  }
});

test('detail returns update local meal records while keeping unchanged share metadata', async () => {
  const app = setup(), page = await app.open();
  page.record(); page.onHide();
  const logId = app.store.addLog({recipeId: LOCAL_ID, date: '2026-11-27', rating: 3, note: ''});
  await page.onShow();
  assert.equal(page.data.lastLog.id, logId);
  assert.equal(app.calls.shareLinks.length, 1);
});

test('local edits, social invalidation and private sync retain sharing while public sync refreshes on return', async t => {
  for (const change of ['edit', 'social', 'private-sync', 'sync']) await t.test(change, async () => {
    const app = setup(), page = await app.open();
    page.onHide();
    if (change === 'edit') app.store.saveRecipe({...app.store.getRecipe(LOCAL_ID), name: '更新后的菜谱'});
    else if (change === 'social') app.invalidateReads();
    else if (change === 'private-sync') {
      app.invalidateReads(); app.emitSync({revision: 8, publicationVersion: 0});
    }
    else app.emitSync();
    app.updatePublicSnapshot('更新后的公开菜谱');
    await page.onShow(); await page.onShow();
    assert.equal(app.calls.shareLinks.length, change === 'sync' ? 2 : 1);
    assert.equal(page.data.shareRecipe.name, change === 'sync' ? '更新后的公开菜谱' : '已公开的南瓜小米粥');
    assert.equal(page.data.shareReady, true);
  });
});

test('returning while detail metadata loads joins the pending read and preserves its result', async () => {
  const app = setup(), gate = pending();
  const response = {recipe: {id: PUBLIC_ID, name: '南瓜粥'}};
  app.hooks.link = () => gate.promise;
  const first = app.page.onShow(); app.page.onHide();
  const second = app.page.onShow();
  assert.equal(app.calls.shareLinks.length, 1);
  gate.resolve(response); await Promise.all([first, second]); await turn();
  await app.page.onShow();
  assert.equal(app.calls.shareLinks.length, 1);
  assert.equal(app.page.data.shareReady, true);
});

test('a failed detail read remains retryable and a successful explicit refresh is reused on return', async () => {
  const app = setup();
  app.hooks.link = () => { throw Error('暂时离线'); };
  const page = await app.open();
  assert.equal(page.data.shareReady, false);
  delete app.hooks.link;
  await page.requestShare();
  assert.deepEqual(app.calls.shareLinks.at(-1), {id: LOCAL_ID, force: true});
  page.onHide(); await page.onShow();
  assert.equal(app.calls.shareLinks.length, 2);
  assert.equal(page.data.shareReady, true);
});
